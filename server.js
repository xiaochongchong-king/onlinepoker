'use strict';
/* ============================================================
 * 在线多人德州扑克 · 服务器
 * 单端口：HTTP 静态页 + WebSocket 同端口；服务器权威牌局。
 * 房间制：创建房间得 4 位房间码，好友凭码加入，2~6 人开赛。
 * ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

/* ---------------- 登录认证 ----------------
 * 口令不明文存储：仅存 scrypt(口令, 盐值) 哈希，登录时同样计算后做时间安全比较。
 * 盐值：KylinSec@2026 */
const AUTH_USER = 'poker';
const AUTH_SALT = 'KylinSec@2026';
const AUTH_HASH = 'fc116072de3e288ce105c36a82b28e936412296a188c747f2d0ab7ef7b453c12355ac95c4856a9a0ef1b7f430db37baa122063f33dc78fa6b41f87ea40b9daa5';
const authTokens = new Set();   // 已签发的令牌（内存存储，重启失效需重新登录）

/** 校验用户名口令（时间安全比较，防时序侧信道） */
function checkAuth(username, password) {
  if (username !== AUTH_USER || typeof password !== 'string') return false;
  const h = crypto.scryptSync(password, AUTH_SALT, 64).toString('hex');
  const a = Buffer.from(h, 'hex'), b = Buffer.from(AUTH_HASH, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ====POKER_CORE_BEGIN====
/* 扑克核心（纯函数，与单机版一致，经全量组合验证） */
function rankChar(r) {
  if (r === 14) return 'A';
  if (r === 13) return 'K';
  if (r === 12) return 'Q';
  if (r === 11) return 'J';
  return String(r);
}
function compareScores(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
function evaluate5(cards) {
  const ranks = cards.map(c => c.rank).sort((x, y) => y - x);
  const flush = cards.every(c => c.suit === cards[0].suit);
  const uniq = [];
  for (const r of ranks) if (uniq.indexOf(r) === -1) uniq.push(r);
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5) straightHigh = 5;
  }
  const cnt = {};
  for (const r of ranks) cnt[r] = (cnt[r] || 0) + 1;
  const groups = Object.keys(cnt).map(Number).sort((a, b) => (cnt[b] - cnt[a]) || (b - a));
  if (flush && straightHigh) return [8, straightHigh];
  if (cnt[groups[0]] === 4) return [7, groups[0], groups[1]];
  if (cnt[groups[0]] === 3 && groups.length > 1 && cnt[groups[1]] === 2) return [6, groups[0], groups[1]];
  if (flush) return [5].concat(ranks);
  if (straightHigh) return [4, straightHigh];
  if (cnt[groups[0]] === 3) return [3, groups[0], groups[1], groups[2]];
  if (cnt[groups[0]] === 2 && groups.length > 1 && cnt[groups[1]] === 2) {
    return [2, Math.max(groups[0], groups[1]), Math.min(groups[0], groups[1]), groups[2]];
  }
  if (cnt[groups[0]] === 2) return [1, groups[0], groups[1], groups[2], groups[3]];
  return [0].concat(ranks);
}
function evaluate7(cards) {
  if (!cards || cards.length < 5) throw new Error('evaluate7 至少需要 5 张牌');
  let best = null;
  const n = cards.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const h = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const s = evaluate5(h);
            if (!best || compareScores(s, best.score) > 0) best = { score: s, cards: h };
          }
  best.name = handName(best.score);
  return best;
}
function handName(s) {
  switch (s[0]) {
    case 8: return s[1] === 14 ? '皇家同花顺' : '同花顺（' + rankChar(s[1]) + ' 高）';
    case 7: return '四条 ' + rankChar(s[1]);
    case 6: return '葫芦（' + rankChar(s[1]) + ' 带 ' + rankChar(s[2]) + '）';
    case 5: return '同花（' + rankChar(s[1]) + ' 高）';
    case 4: return s[1] === 5 ? '顺子（轮子 A-5）' : '顺子（' + rankChar(s[1]) + ' 高）';
    case 3: return '三条 ' + rankChar(s[1]);
    case 2: return '两对（' + rankChar(s[1]) + ' 和 ' + rankChar(s[2]) + '）';
    case 1: return '一对 ' + rankChar(s[1]);
    default: return '高牌 ' + rankChar(s[1]);
  }
}
function buildSidePots(players) {
  let cur = players.map((p, i) => ({ i: i, amt: p.totalBetThisHand || 0, folded: !!p.folded })).filter(l => l.amt > 0);
  const pots = [];
  const sameSet = (a, b) => a.length === b.length && b.every(x => a.indexOf(x) !== -1);
  while (cur.length) {
    const min = Math.min.apply(null, cur.map(l => l.amt));
    const amount = min * cur.length;
    const eligible = cur.filter(l => !l.folded).map(l => l.i);
    if (eligible.length === 0 && pots.length) {
      pots[pots.length - 1].amount += amount;
    } else if (pots.length && sameSet(pots[pots.length - 1].eligible, eligible)) {
      pots[pots.length - 1].amount += amount;
    } else {
      pots.push({ amount: amount, eligible: eligible });
    }
    cur = cur.map(l => ({ i: l.i, amt: l.amt - min, folded: l.folded })).filter(l => l.amt > 0);
  }
  return pots;
}
// ====POKER_CORE_END====

/* ---------------- 牌组 ---------------- */
const SUITS = ['♠', '♥', '♦', '♣'];
function newDeck() {
  const d = [];
  for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) d.push({ rank: r, suit: s });
  return d;
}
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
  }
  return deck;
}
function cardStr(c) { return SUITS[c.suit] + rankChar(c.rank); }

/* ---------------- 常量与工具 ---------------- */
const SMALL_BLIND = 10, BIG_BLIND = 20, START_CHIPS = 1000;
const TURN_MS = parseInt(process.env.TURN_MS || '60000', 10); // 行动倒计时（服务器强制执行，测试可用环境变量调小）
const PORT = process.env.PORT || 3000;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const sleep = ms => new Promise(res => setTimeout(res, ms));

/* ---------------- 房间管理 ---------------- */
const rooms = new Map(); // code -> room

function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function createRoom(host, name) {
  const code = makeCode();
  const room = {
    code: code, players: [], hostSeat: 0, handNo: 0, hid: 0,
    dealer: -1, sbIdx: -1, bbIdx: -1, game: null, pending: null,
    buyins: [],               // 买入记录：[{seat, name, amount, label, handNo, ts}]
    createdAt: Date.now()
  };
  rooms.set(code, room);
  addPlayer(room, host, name);
  return room;
}

function addPlayer(room, ws, name) {
  if (room.players.length >= 6) return null;
  const p = {
    seat: room.players.length, ws: ws, name: name, connected: true,
    playerId: crypto.randomUUID(),   // 座位凭证：断线重连凭它恢复原座位
    chips: START_CHIPS, inHand: false,
    hand: [], bet: 0, totalBetThisHand: 0,
    folded: false, allIn: false, acted: false, showHand: '', lastAction: ''
  };
  room.players.push(p);
  ws._player = p;
  ws._room = room;
  return p;
}

/** 记录一次买入（初始/重新），并广播日志 */
function recordBuyin(room, p, label) {
  room.buyins.push({ seat: p.seat, name: p.name, amount: START_CHIPS, label: label, handNo: room.handNo, ts: Date.now() });
  if (room.buyins.length > 200) room.buyins.shift();
}

function logTo(room, msg, cls) {
  broadcast(room, { t: 'log', msg: msg, cls: cls || 'act' });
}
function broadcast(room, obj) {
  const s = JSON.stringify(obj);
  for (const p of room.players) {
    if (p.connected && p.ws.readyState === 1) p.ws.send(s);
  }
}
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function inHand(room) { return room.players.filter(p => p.inHand); }
function activeInHand(room) { return room.players.filter(p => p.inHand && !p.folded); }
function canAct(room) { return room.players.filter(p => p.inHand && !p.folded && !p.allIn); }
function totalPot(room) { return room.players.reduce((s, p) => s + p.totalBetThisHand, 0); }

function nextIdx(room, from, pred) {
  const n = room.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (pred(i)) return i;
  }
  return -1;
}

/* ---------------- 每客户端定制视图（底牌隐私） ---------------- */
function viewFor(room, me) {
  const g = room.game;
  return {
    t: 'state',
    code: room.code, hostSeat: room.hostSeat, handNo: room.handNo,
    started: !!g, phase: g ? g.phase : 'lobby',
    dealer: room.dealer, sb: room.sbIdx, bb: room.bbIdx,
    community: g ? g.community : [],
    pot: g ? totalPot(room) : 0,
    potBreakdown: g ? g.potBreakdown : null,
    currentBet: g ? g.currentBet : 0,
    minRaise: g ? g.minRaise : BIG_BLIND,
    acting: g ? g.acting : -1,
    actingDeadline: room.pending ? room.pending.deadline : 0,
    winners: g ? g.winners : [],
    revealAll: g ? g.revealAll : false,
    result: g ? g.result : null,
    buyins: room.buyins,
    you: me ? me.seat : -1,
    players: room.players.map(p => {
      const showFace = p.inHand && p.hand.length > 0 &&
        ((me && p.seat === me.seat) ||
         (!p.folded && g && (g.revealAll || g.phase === 'showdown')));
      return {
        seat: p.seat, name: p.name, chips: p.chips, bet: p.bet,
        inHand: p.inHand, folded: p.folded, allIn: p.allIn,
        connected: p.connected, lastAction: p.lastAction || '',
        cards: p.hand.length ? (showFace ? p.hand : [null, null]) : [],
        showHand: p.showHand || ''
      };
    })
  };
}

function broadcastState(room) {
  for (const p of room.players) {
    if (p.connected && p.ws.readyState === 1) p.ws.send(JSON.stringify(viewFor(room, p)));
  }
}

/* ---------------- 行动请求（60 秒超时自动过牌/弃牌） ---------------- */
function askAction(room, p) {
  return new Promise(resolve => {
    const finish = (act) => {
      if (room.pending) { clearTimeout(room.pending.timer); room.pending = null; }
      resolve(act);
    };
    room.pending = {
      seat: p.seat,
      deadline: Date.now() + TURN_MS,
      resolve: finish,
      timer: setTimeout(() => {
        const toCall = room.game.currentBet - p.bet;
        logTo(room, p.name + ' 超时未行动，自动' + (toCall <= 0 ? '过牌' : '弃牌'), 'sys');
        finish(toCall <= 0 ? { type: 'check' } : { type: 'fold' });
      }, TURN_MS)
    };
    broadcastState(room);
  });
}

/* ---------------- 动作执行 ---------------- */
function commitChips(p, amt) {
  p.chips -= amt;
  p.bet += amt;
  p.totalBetThisHand += amt;
  if (p.chips === 0) p.allIn = true;
}

function doAction(room, p, act) {
  const g = room.game;
  if (act.type === 'fold') {
    p.folded = true;
    logTo(room, p.name + ' 弃牌', 'act');
  } else if (act.type === 'check') {
    p.lastAction = 'check';
    logTo(room, p.name + ' 过牌', 'act');
  } else if (act.type === 'call') {
    const amt = Math.min(g.currentBet - p.bet, p.chips);
    commitChips(p, amt);
    p.lastAction = p.allIn ? 'All in ' + amt : 'call ' + amt;
    logTo(room, p.name + ' 跟注 ' + amt + (p.allIn ? '（全下）' : ''), 'act');
  } else if (act.type === 'raise') {
    let target = Math.min(Math.round(act.target || 0), p.bet + p.chips);
    target = Math.max(target, Math.min(g.currentBet + g.minRaise, p.bet + p.chips));
    const inc = target - g.currentBet;
    commitChips(p, target - p.bet);
    if (inc >= g.minRaise) g.minRaise = inc;
    g.currentBet = target;
    p.lastAction = p.allIn ? 'All in ' + target : 'raise ' + target;
    logTo(room, p.name + ' 加注到 ' + target + (p.allIn ? '（全下）' : ''), 'act');
  } else if (act.type === 'allin') {
    const target = p.bet + p.chips;
    commitChips(p, p.chips);
    p.lastAction = 'All in ' + target;
    if (target > g.currentBet) {
      const inc = target - g.currentBet;
      if (inc >= g.minRaise) g.minRaise = inc;
      g.currentBet = target;
      logTo(room, p.name + ' 全下加注到 ' + target, 'act');
    } else {
      logTo(room, p.name + ' 全下 ' + target, 'act');
    }
  }
  p.acted = true;
}

/* ---------------- 一局流程 ---------------- */
function setupHand(room) {
  const g = room.game = {
    deck: shuffle(newDeck()), community: [], phase: 'preflop',
    currentBet: 0, minRaise: BIG_BLIND, acting: -1,
    winners: [], revealAll: false, potBreakdown: null, result: null,
    hid: ++room.hid
  };
  room.handNo++;
  for (const p of room.players) {
    p.inHand = p.connected && p.chips > 0;
    p.hand = []; p.bet = 0; p.totalBetThisHand = 0;
    p.folded = false; p.allIn = false; p.acted = false; p.showHand = ''; p.lastAction = '';
  }
  const n = room.players.length;
  room.dealer = nextIdx(room, room.dealer, i => room.players[i].inHand);
  if (inHand(room).length === 2) {           // 单挑：庄家即小盲
    room.sbIdx = room.dealer;
    room.bbIdx = nextIdx(room, room.dealer, i => room.players[i].inHand);
  } else {
    room.sbIdx = nextIdx(room, room.dealer, i => room.players[i].inHand);
    room.bbIdx = nextIdx(room, room.sbIdx, i => room.players[i].inHand);
  }
  // 发底牌（按实际在局人数发，坐观玩家不发）
  const cnt = inHand(room).length;
  for (let r = 0; r < 2; r++) {
    let idx = nextIdx(room, room.dealer, i => room.players[i].inHand);
    for (let k = 0; k < cnt; k++) {
      room.players[idx].hand.push(g.deck.pop());
      idx = nextIdx(room, idx, i => room.players[i].inHand);
    }
  }
  logTo(room, '—— 第 ' + room.handNo + ' 局 · 庄家：' + room.players[room.dealer].name + ' ——', 'sys');
  postBlind(room, room.players[room.sbIdx], SMALL_BLIND, '小盲');
  postBlind(room, room.players[room.bbIdx], BIG_BLIND, '大盲');
  g.currentBet = Math.max.apply(null, room.players.map(p => p.bet));
}

function postBlind(room, p, amount, label) {
  const amt = Math.min(amount, p.chips);
  commitChips(p, amt);
  logTo(room, p.name + ' 下' + label + ' ' + amt + (p.allIn ? '（全下）' : ''), 'act');
}

async function playHand(room) {
  try {
    setupHand(room);
    const hid = room.game.hid;
    broadcastState(room);
    await sleep(900);
    if (hid !== room.hid) return;

    await bettingRound(room, true);
    if (hid !== room.hid) return;
    if (activeInHand(room).length <= 1) return earlyWin(room);
    await maybeReveal(room);
    if (hid !== room.hid) return;

    await dealStreet(room, 3, '翻牌');
    if (hid !== room.hid) return;
    if (canAct(room).length >= 2) {
      await bettingRound(room, false);
      if (hid !== room.hid) return;
      if (activeInHand(room).length <= 1) return earlyWin(room);
      await maybeReveal(room);
      if (hid !== room.hid) return;
    }

    await dealStreet(room, 1, '转牌');
    if (hid !== room.hid) return;
    if (canAct(room).length >= 2) {
      await bettingRound(room, false);
      if (hid !== room.hid) return;
      if (activeInHand(room).length <= 1) return earlyWin(room);
      await maybeReveal(room);
      if (hid !== room.hid) return;
    }

    await dealStreet(room, 1, '河牌');
    if (hid !== room.hid) return;
    if (canAct(room).length >= 2) {
      await bettingRound(room, false);
      if (hid !== room.hid) return;
      if (activeInHand(room).length <= 1) return earlyWin(room);
    }

    await showdown(room);
  } catch (e) {
    logTo(room, '系统错误：' + e.message, 'sys');
  }
}

async function dealStreet(room, n, label) {
  const g = room.game;
  for (let k = 0; k < n; k++) g.community.push(g.deck.pop());
  g.phase = label === '翻牌' ? 'flop' : label === '转牌' ? 'turn' : 'river';
  logTo(room, '--- ' + label + '：' + g.community.map(cardStr).join(' ') + ' ---', 'street');
  broadcastState(room);
  await sleep(800);
}

async function bettingRound(room, isPreflop) {
  const g = room.game;
  if (!isPreflop) {
    for (const p of room.players) { p.bet = 0; p.acted = false; p.lastAction = ''; }
    g.currentBet = 0;
    g.minRaise = BIG_BLIND;
  }
  let idx;
  if (isPreflop) {
    idx = nextIdx(room, room.bbIdx, i => room.players[i].inHand);
  } else {
    idx = nextIdx(room, room.dealer, i => room.players[i].inHand && !room.players[i].folded && !room.players[i].allIn);
    if (idx === -1) return;
  }
  broadcastState(room);

  while (true) {
    if (activeInHand(room).length <= 1) break;
    const p = room.players[idx];
    if (p.inHand && !p.folded && !p.allIn && (!p.acted || p.bet < g.currentBet)) {
      g.acting = idx;
      const act = await askAction(room, p);
      if (g.hid !== room.hid) return;
      doAction(room, p, act);
      g.acting = -1;
      broadcastState(room);
      await sleep(400);
      if (g.hid !== room.hid) return;
    }
    const nidx = nextIdx(room, idx, i => {
      const q = room.players[i];
      return q.inHand && !q.folded && !q.allIn && (!q.acted || q.bet < g.currentBet);
    });
    if (nidx === -1) break;
    idx = nidx;
  }
  g.acting = -1;
  for (const p of room.players) p.bet = 0;
  broadcastState(room);
}

async function maybeReveal(room) {
  const g = room.game;
  if (g.revealAll) return;
  if (activeInHand(room).length >= 2 && canAct(room).length <= 1) {
    g.revealAll = true;
    logTo(room, '--- 无人可再行动，亮牌跑马！---', 'street');
    broadcastState(room);
    await sleep(1200);
  }
}

async function earlyWin(room) {
  const g = room.game;
  const winner = activeInHand(room)[0];
  const total = totalPot(room);
  if (!winner) {
    // 全员掉线导致无人可赢的极端情况：本局作废，退还各人在局下注
    for (const p of room.players) {
      if (p.inHand) { p.chips += p.totalBetThisHand; p.totalBetThisHand = 0; p.bet = 0; }
    }
    g.phase = 'showdown';
    g.winners = [];
    logTo(room, '所有玩家均已掉线，本局作废，下注退还', 'sys');
    g.result = { title: '本局作废（全员掉线）', lines: [] };
    broadcastState(room);
    return;
  }
  winner.chips += total;
  g.winners = [winner.seat];
  g.phase = 'showdown';
  logTo(room, '其他玩家全部弃牌，' + winner.name + ' 赢得底池 ' + total, 'win');
  g.result = { title: winner.name + ' 获胜！', lines: [{ name: winner.name, amount: total, hand: '对手全部弃牌，无需亮牌' }] };
  broadcastState(room);
}

async function showdown(room) {
  const g = room.game;
  g.phase = 'showdown';
  logTo(room, '--- 摊牌 ---', 'street');

  const evals = new Map();
  for (const p of room.players) {
    if (!p.inHand || p.folded) continue;
    const ev = evaluate7(p.hand.concat(g.community));
    evals.set(p.seat, ev);
    p.showHand = ev.name;
    logTo(room, p.name + ' 亮牌 ' + cardStr(p.hand[0]) + ' ' + cardStr(p.hand[1]) + '（' + ev.name + '）', 'act');
  }
  // 座位号即 room.players 下标（玩家永不移除），边池合格索引直接可用
  const pots = buildSidePots(room.players);
  g.potBreakdown = pots;
  broadcastState(room);
  await sleep(1000);

  const winnings = {};
  for (const p of room.players) winnings[p.seat] = 0;
  for (let pi = 0; pi < pots.length; pi++) {
    const pot = pots[pi];
    const eligible = pot.eligible.filter(s => {
      const p = room.players[s];
      return p && p.inHand && !p.folded;
    });
    if (!eligible.length) continue;
    let bestScore = null;
    for (const s of eligible) {
      const sc = evals.get(s).score;
      if (!bestScore || compareScores(sc, bestScore) > 0) bestScore = sc;
    }
    const winners = eligible.filter(s => compareScores(evals.get(s).score, bestScore) === 0);
    winners.sort((a, b) => ((a - room.dealer + 6) % 6) - ((b - room.dealer + 6) % 6));
    const share = Math.floor(pot.amount / winners.length);
    let rem = pot.amount - share * winners.length;
    const potLabel = pots.length > 1 ? (pi === 0 ? '主池' : '边池' + pi) : '底池';
    for (const s of winners) {
      let gain = share;
      if (rem > 0) { gain += 1; rem--; }
      room.players[s].chips += gain;
      winnings[s] += gain;
      logTo(room, potLabel + '：' + room.players[s].name + ' 以「' + evals.get(s).name + '」赢得 ' + gain, 'win');
    }
  }

  const winnerIds = Object.keys(winnings).map(Number).filter(s => winnings[s] > 0);
  g.winners = winnerIds;
  const lines = winnerIds.map(s => ({
    name: room.players[s].name, amount: winnings[s],
    hand: evals.has(s) ? evals.get(s).name : ''
  }));
  g.result = {
    title: winnerIds.length > 1 ? '平分底池！' : room.players[winnerIds[0]].name + ' 获胜！',
    lines: lines
  };
  broadcastState(room);
}

/* ---------------- 开始/下一局/买入 ---------------- */
function tryStartHand(room, byPlayer) {
  if (byPlayer.seat !== room.hostSeat) return send(byPlayer.ws, { t: 'error', msg: '只有房主可以开始' });
  if (room.game && room.game.phase !== 'showdown') return;
  const ready = room.players.filter(p => p.connected && p.chips > 0);
  if (ready.length < 2) return send(byPlayer.ws, { t: 'error', msg: '至少需要 2 名有筹码的在线玩家' });
  room.game = null;         // 清掉上局结果
  for (const p of room.players) p.showHand = '';
  playHand(room);
}

/* ---------------- WebSocket 协议 ---------------- */
function handleMessage(ws, msg) {
  let m;
  try { m = JSON.parse(msg); } catch (e) { return; }
  const room = ws._room, p = ws._player;

  if (m.t === 'create') {
    const name = String(m.name || '').replace(/[<>&"']/g, '').trim().slice(0, 8);
    if (!name) return send(ws, { t: 'error', msg: '请先填写昵称' });
    const r = createRoom(ws, name);
    recordBuyin(r, ws._player, '初始买入');
    send(ws, { t: 'joined', code: r.code, playerId: ws._player.playerId, seat: ws._player.seat, name: name });
    logTo(r, name + ' 创建了房间（房间码 ' + r.code + '）并买入 ' + START_CHIPS + ' 筹码', 'sys');
    broadcastState(r);
    return;
  }
  if (m.t === 'join') {
    const r = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!r) return send(ws, { t: 'error', msg: '房间不存在，请检查房间码' });
    if (r.players.length >= 6) return send(ws, { t: 'error', msg: '房间已满（6 人）' });
    const name = String(m.name || '').replace(/[<>&"']/g, '').trim().slice(0, 8);
    if (!name) return send(ws, { t: 'error', msg: '请先填写昵称' });
    addPlayer(r, ws, name);
    recordBuyin(r, ws._player, '初始买入');
    send(ws, { t: 'joined', code: r.code, playerId: ws._player.playerId, seat: ws._player.seat, name: name });
    logTo(r, name + ' 加入房间并买入 ' + START_CHIPS + ' 筹码', 'sys');
    broadcastState(r);
    return;
  }
  // 断线重连：凭座位凭证恢复原座位
  if (m.t === 'rejoin') {
    const r = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!r) return send(ws, { t: 'error', msg: '房间已不存在' });
    const p = r.players.find(q => q.playerId === m.playerId);
    if (!p) return send(ws, { t: 'error', msg: '座位不存在，请重新加入' });
    if (p.ws && p.ws !== ws && p.ws.readyState === 1) { try { p.ws.close(); } catch (e) { /* 忽略 */ } }
    p.ws = ws;
    ws._player = p;
    ws._room = r;
    p.connected = true;
    send(ws, { t: 'joined', code: r.code, playerId: p.playerId, seat: p.seat, name: p.name });
    logTo(r, p.name + ' 重新连接', 'sys');
    broadcastState(r);
    return;
  }
  if (!room || !p) return;

  if (m.t === 'start' || m.t === 'next') return tryStartHand(room, p);
  if (m.t === 'rebuy') {
    if (p.chips > 0) return send(ws, { t: 'error', msg: '还有筹码，无需买入' });
    p.chips = START_CHIPS;
    recordBuyin(room, p, '重新买入');
    logTo(room, p.name + ' 重新买入 ' + START_CHIPS + ' 筹码', 'sys');
    broadcastState(room);
    return;
  }
  if (m.t === 'act') {
    if (!room.pending || room.pending.seat !== p.seat) return;
    const act = m.act || {};
    if (['fold', 'check', 'call', 'raise', 'allin'].indexOf(act.type) === -1) return;
    room.pending.resolve(act);
    return;
  }
}

function handleClose(ws) {
  const room = ws._room, p = ws._player;
  if (!room || !p) return;
  p.connected = false;
  logTo(room, p.name + ' 离开了房间', 'sys');
  // 轮到掉线玩家：立即弃牌（掉线即弃牌，与超时不同）
  if (room.pending && room.pending.seat === p.seat) {
    room.pending.resolve({ type: 'fold' });
  }
  // 局中断线且仍在局中：直接弃牌（全下除外）
  if (room.game && p.inHand && !p.folded && !p.allIn && room.game.phase !== 'showdown') {
    p.folded = true;
    logTo(room, p.name + ' 掉线，自动弃牌', 'sys');
  }
  // 房主移交
  if (room.hostSeat === p.seat) {
    const next = room.players.find(q => q.connected);
    if (next) {
      room.hostSeat = next.seat;
      logTo(room, '房主移交给 ' + next.name, 'sys');
    }
  }
  broadcastState(room);
}

/* ---------------- HTTP 静态页 + WS 挂载 ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  // 兼容代理/网关转发的绝对形式 URL（GET http://host/path）——剥掉 scheme+host
  urlPath = urlPath.replace(/^https?:\/\/[^/]+/, '') || '/';
  // 登录认证端点
  if (req.method === 'POST' && urlPath === '/login') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let m = {};
      try { m = JSON.parse(body); } catch (e) { /* 忽略 */ }
      if (checkAuth(m.username, m.password)) {
        const token = crypto.randomUUID();
        authTokens.add(token);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: token }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '用户名或口令错误' }));
      }
    });
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(__dirname, 'public', path.normalize(urlPath).replace(/^([.][.][\/\\])+/, ''));
  if (process.env.DEBUG_HTTP) console.log('[http]', req.method, req.url, '->', file);
  fs.readFile(file, (err, data) => {
    if (err) {
      if (process.env.DEBUG_HTTP) console.log('[http] 404', file, err.code);
      res.writeHead(404); res.end('Not Found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({
  server: server,
  // 握手前校验令牌：无有效令牌直接 HTTP 401，WS 连接不会建立
  verifyClient: (info, cb) => {
    const q = new URL(info.req.url, 'http://localhost').searchParams;
    cb(authTokens.has(q.get('token') || ''), 401, 'Unauthorized');
  }
});
wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    try { handleMessage(ws, msg); } catch (e) { console.error('msg error:', e.message); }
  });
  ws.on('close', () => handleClose(ws));
  ws.on('error', () => {});
});

/* 心跳保活：防代理/网关掐断闲置 WS（浏览器自动应答 pong） */
setInterval(() => {
  for (const ws of wss.clients) { try { ws.ping(); } catch (e) { /* 忽略 */ } }
}, 30000);

/* 房间清扫：全员离线 10 分钟删除 */
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.every(p => !p.connected) && now - room.createdAt > 10 * 60 * 1000) {
      if (room.pending) { clearTimeout(room.pending.timer); }
      rooms.delete(code);
    }
  }
}, 60 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('在线德州扑克服务器已启动：http://0.0.0.0:' + PORT);
});
