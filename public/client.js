'use strict';
/* 在线德州扑克 · 客户端：大厅 + 牌桌渲染 + 动作发送 */
const SUITS = ['♠', '♥', '♦', '♣'];
const $ = id => document.getElementById(id);

let ws = null;
let S = null;                 // 最近一次服务器状态
let myName = localStorage.getItem('poker-online-name') || '';
let token = sessionStorage.getItem('poker-online-token') || '';
let session = null;           // 座位凭证 {code, playerId}：断线重连恢复原座
try { session = JSON.parse(localStorage.getItem('poker-online-session') || 'null'); } catch (e) { session = null; }

/* ---------------- 登录 ---------------- */
function showLogin(msg) {
  $('lobby').style.display = 'flex';
  $('lobby-entry').style.display = 'none';
  $('login-entry').style.display = 'block';
  $('login-msg').textContent = msg || '';
}

async function doLogin() {
  const username = $('login-user').value.trim();
  const password = $('login-pass').value;
  if (!username || !password) { $('login-msg').textContent = '请输入用户名和口令'; return; }
  $('btn-login').disabled = true;
  try {
    const r = await fetch('/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    });
    if (r.status === 200) {
      const j = await r.json();
      token = j.token;
      sessionStorage.setItem('poker-online-token', token);
      $('login-msg').textContent = '';
      connect();
    } else {
      $('login-msg').textContent = '用户名或口令错误';
    }
  } catch (e) {
    $('login-msg').textContent = '网络错误，请重试';
  }
  $('btn-login').disabled = false;
}

/* ---------------- 连接 ---------------- */
function connect() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(proto + location.host + '/?token=' + encodeURIComponent(token));
  let opened = false;
  ws.onopen = () => {
    opened = true;
    $('lobby-conn').textContent = '已连接服务器';
    $('login-entry').style.display = 'none';
    $('lobby-entry').style.display = 'block';
    // 有座位凭证：自动恢复原座位
    if (session) {
      ws.send(JSON.stringify({ t: 'rejoin', code: session.code, playerId: session.playerId }));
    }
    requestRooms();
  };
  ws.onclose = (ev) => {
    if (window._suppressReconnect) { window._suppressReconnect = false; return; }   // 房间已解散，不重连
    if (ev.code === 4401 || !opened) {  // 握手被拒（令牌失效/未认证）→ 回登录页
      sessionStorage.removeItem('poker-online-token');
      token = '';
      showLogin('登录已失效或口令错误，请重新登录');
      return;
    }
    // 断线自动重连（有座位凭证时恢复原座）
    $('lobby-conn').textContent = '连接中断，正在重连…';
    if (S) $('hint').innerHTML = '<span class="dim">连接中断，正在重连…</span>';
    clearTimeout(window._rcTimer);
    window._rcTimer = setTimeout(connect, 2500);
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.t === 'joined') {
      session = { code: m.code, playerId: m.playerId };
      localStorage.setItem('poker-online-session', JSON.stringify(session));
    }
    else if (m.t === 'rooms') renderRoomList(m.rooms);
    else if (m.t === 'room_closed') {
      // 房主解散房间：弹回大厅，压住自动重连
      window._suppressReconnect = true;
      localStorage.removeItem('poker-online-session');
      session = null;
      S = null;
      $('lobby').style.display = 'flex';
      $('lobby-entry').style.display = 'block';
      $('lobby-msg').textContent = m.msg || '房间已被房主解散';
      requestRooms();
    }
    else if (m.t === 'state') { S = m; render(); }
    else if (m.t === 'log') addLog(m.msg, m.cls);
    else if (m.t === 'error') {
      if (m.msg === '房间已不存在' || m.msg === '座位不存在，请重新加入') {
        localStorage.removeItem('poker-online-session');
        session = null;
        $('lobby').style.display = 'flex';
        $('lobby-entry').style.display = 'block';
        $('lobby-msg').textContent = m.msg;
      }
      else if ($('lobby').style.display !== 'none') $('lobby-msg').textContent = m.msg;
      else addLog('提示：' + m.msg, 'sys');
    }
  };
}

/* ---------------- 大厅 ---------------- */
function myNameInput() {
  return $('name-input').value.replace(/[<>&"']/g, '').trim().slice(0, 8);
}

function requireName() {
  const name = myNameInput();
  if (!name) {
    $('lobby-msg').textContent = '请先填写昵称再进入房间';
    $('name-input').focus();
    return null;
  }
  return name;
}

/* ---------------- 房间列表 ---------------- */
function requestRooms() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'rooms' }));
}

function renderRoomList(list) {
  const box = $('room-list');
  if (!box) return;
  if (!list || !list.length) {
    box.innerHTML = '<div class="rl-empty">暂无可加入的房间，创建一个吧</div>';
    return;
  }
  box.innerHTML = list.map(r =>
    '<div class="rl-row" data-code="' + esc(r.code) + '">' +
      '<span class="rl-code">' + esc(r.code) + '</span>' +
      '<span class="rl-info">' + r.online + '/' + r.count + ' 人' + (r.started ? ' · 进行中' : ' · 等待中') + (r.straddle ? ' · 抓' : '') + '</span>' +
      '<span class="rl-names">' + esc(r.names.join('、')) + '</span>' +
    '</div>').join('');
}

function initLobby() {
  $('name-input').value = myName;
  $('btn-create').addEventListener('click', () => {
    const name = requireName();
    if (name === null) return;
    myName = name;
    localStorage.setItem('poker-online-name', myName);
    ws.send(JSON.stringify({ t: 'create', name: myName }));
    $('lobby-msg').textContent = '';
  });
  $('btn-join').addEventListener('click', () => {
    const code = $('code-input').value.toUpperCase().trim();
    if (code.length !== 4) { $('lobby-msg').textContent = '请输入 4 位房间码'; return; }
    const name = requireName();
    if (name === null) return;
    myName = name;
    localStorage.setItem('poker-online-name', myName);
    ws.send(JSON.stringify({ t: 'join', code: code, name: myName }));
    $('lobby-msg').textContent = '';
  });
  $('btn-start2').addEventListener('click', () => ws.send(JSON.stringify({ t: 'start' })));
  // 准备/取消准备（等待面板与局内准备区共用）
  $('btn-ready-wait').addEventListener('click', () => {
    const me = S && S.players[S.you];
    ws.send(JSON.stringify({ t: 'ready', on: !(me && me.ready) }));
  });
  $('btn-ready').addEventListener('click', () => ws.send(JSON.stringify({ t: 'ready', on: true })));
  $('btn-unready').addEventListener('click', () => ws.send(JSON.stringify({ t: 'ready', on: false })));
  // 房间列表：点击进入 + 大厅停留期间每 5 秒刷新
  $('room-list').addEventListener('click', (e) => {
    const row = e.target && e.target.closest ? e.target.closest('.rl-row') : null;
    if (!row) return;
    const name = requireName();
    if (name === null) return;
    myName = name;
    localStorage.setItem('poker-online-name', myName);
    ws.send(JSON.stringify({ t: 'join', code: row.dataset.code, name: myName }));
    $('lobby-msg').textContent = '';
  });
  setInterval(() => {
    if ($('lobby').style.display !== 'none' && $('lobby-entry').style.display === 'block') requestRooms();
  }, 5000);
  // 移动端日志：默认收起，点标题栏展开/收起
  const lp = $('log-panel');
  const lpTitle = lp.querySelector('h3');
  if (lpTitle) lpTitle.addEventListener('click', () => lp.classList.toggle('open'));
}

/* 等待开局面板：建房/加入后直接入座牌桌，房主在中央开始 */
function renderWait() {
  const w = $('wait-panel');
  if (S.started) { w.style.display = 'none'; return; }
  w.style.display = 'flex';
  $('wait-code').textContent = S.code;
  const online = S.players.filter(p => p.connected).length;
  const readyCount = S.players.filter(p => p.connected && p.ready && p.chips > 0).length;
  $('wait-count').textContent = '已入座 ' + online + ' 人 · 已准备 ' + readyCount + ' 人';
  const isHost = S.you === S.hostSeat;
  const me = S.players[S.you];
  // 准备开关：文案随状态；满 2 名已准备才允许开局
  const bw = $('btn-ready-wait');
  bw.textContent = (me && me.ready) ? '取消准备' : '准备';
  $('btn-start2').style.display = isHost ? '' : 'none';
  $('wait-tip').textContent = isHost ? '' : '等待房主开始…（先点「准备」入座）';
  $('btn-start2').disabled = readyCount < 2;
  $('btn-start2').textContent = readyCount < 2 ? '开始游戏（待 2 人准备）' : '开始游戏（' + readyCount + ' 人已准备）';
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

/* ---------------- 买入记录 ---------------- */
function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function renderBuyins() {
  if (!S || !S.buyins) return;
  const totals = {};
  for (const b of S.buyins) {
    if (!totals[b.name]) totals[b.name] = { n: 0, amt: 0 };
    totals[b.name].n++;
    totals[b.name].amt += b.amount;
  }
  const names = Object.keys(totals);
  $('buyins-summary').innerHTML = names.length ?
    names.map(n => '<span>' + esc(n) + '：买入 ' + totals[n].n + ' 次 / 共 ' + totals[n].amt + '</span>').join('') :
    '<span>暂无记录</span>';
  $('buyins-list').innerHTML = S.buyins.length ? S.buyins.slice().reverse().map(b =>
    '<div class="bi"><span><b>' + esc(b.name) + '</b> <span class="lb">' + esc(b.label) +
    (b.handNo ? ' · 第' + b.handNo + '局' : ' · 开局前') + '</span></span>' +
    '<span><span class="amt">+' + b.amount + '</span> <span class="t">' + fmtTime(b.ts) + '</span></span></div>'
  ).join('') : '<div class="lb" style="text-align:center">暂无买入记录</div>';
}

/* ---------------- 座位坐标 ---------------- */
const SEAT_POS = [
  { left: '50%', top: '87%' }, { left: '15%', top: '68%' }, { left: '13%', top: '24%' },
  { left: '50%', top: '9%' }, { left: '87%', top: '24%' }, { left: '85%', top: '68%' }
];
const SEAT_POS_MOBILE = [
  { left: '50%', top: '86%' }, { left: '13%', top: '70%' }, { left: '19%', top: '25%' },
  { left: '50%', top: '11%' }, { left: '81%', top: '25%' }, { left: '87%', top: '70%' }
];
/* 7~9 人：椭圆均分算法（座位 0 固定底部，其余逆时针均匀环绕；移动端横向半径加大，边座让出公共牌区） */
function spreadPos(n, i, mobile) {
  const rx = mobile ? 41 : 42, ry = mobile ? 37 : 40;
  const ang = (90 + i * (360 / n)) * Math.PI / 180;
  return { left: (50 + rx * Math.cos(ang)).toFixed(1) + '%', top: (50 + ry * Math.sin(ang)).toFixed(1) + '%' };
}

/* ---------------- 发牌动画去重（同单机版思路） ---------------- */
let renderedHandNo = -1;
const shownCardKeys = new Set();
function isNewCard(key) {
  if (!S || S.handNo !== renderedHandNo) {
    renderedHandNo = S ? S.handNo : -1;
    shownCardKeys.clear();
  }
  if (shownCardKeys.has(key)) return false;
  shownCardKeys.add(key);
  return true;
}

function cardHTML(c, faceDown, animKey) {
  const anim = (animKey && isNewCard(animKey)) ? ' dealt' : '';
  if (faceDown || !c) return '<div class="card back' + anim + '"><div class="back-pattern"></div></div>';
  const red = (c.suit === 1 || c.suit === 2);
  return '<div class="card ' + (red ? 'red' : 'black') + anim + '">' +
    '<div class="rank">' + rankChar(c.rank) + '</div>' +
    '<div class="suit">' + SUITS[c.suit] + '</div>' +
    '<div class="big-suit">' + SUITS[c.suit] + '</div></div>';
}
function rankChar(r) {
  if (r === 14) return 'A'; if (r === 13) return 'K';
  if (r === 12) return 'Q'; if (r === 11) return 'J';
  return String(r);
}

/* ---------------- 渲染 ---------------- */
function render() {
  if (!S) return;
  // 僵尸视角自愈：已入座玩家的 you 不可能为 -1；一旦出现说明连接状态错乱，立即重连恢复
  if (S.you === -1 && session) {
    console.warn('[zombie-view] you=-1，自动重连恢复');
    try { ws.close(); } catch (e) { /* 忽略 */ }
    return;
  }
  // 已在房间内（无论是否开局）都直接进牌桌
  $('lobby').style.display = 'none';
  $('room-code').textContent = S.code;
  $('hand-no').textContent = S.handNo;
  $('blinds-text').textContent = '盲注 10 / 20' + (S.straddleOn ? ' / 40（抓）' : '');
  // 分区容错：任何一段渲染崩溃都不能冻结其他段（尤其操作区）
  const sections = [renderSeats, renderCommunity, renderPot, renderHint, renderControls, renderResult, renderWait];
  for (const fn of sections) {
    try { fn(); } catch (e) { console.error('[render:' + fn.name + ']', e); }
  }
}

function renderSeats() {
  const positions = (window.innerWidth <= 768 ? SEAT_POS_MOBILE : SEAT_POS);
  const isMobile = window.innerWidth <= 768;
  const pCount = S.players.length;
  // 7 人以上：座位容器加 crowded 类（移动端卡牌缩小一档，避免互挤）
  $('seats').classList.toggle('crowded', pCount > 6);
  $('seats').innerHTML = S.players.map(p => {
    // ≤6 人用固定布局（零回归），7~9 人椭圆均分
    const pos = pCount > 6 ? spreadPos(pCount, p.seat, isMobile) : positions[p.seat];
    const faceUp = p.cards.length > 0 && p.cards[0] !== null;
    const cards = p.cards.map((c, k) => cardHTML(c, !faceUp,
      faceUp ? 'f-' + (c ? c.suit + '-' + c.rank : 'x') + '-' + p.seat + '-' + k : 'b-p' + p.seat + '-' + k)).join('');
    let status = '';
    if (!p.inHand) status = S.phase === 'lobby' ? (p.ready ? '已准备' : '已入座') : (p.chips <= 0 ? '等待买入' : (p.ready ? '已准备' : '观战中'));
    if (p.folded) status = '已弃牌';
    else if (S.winners.indexOf(p.seat) !== -1) status = '★ 获胜 ★';
    else if (p.allIn && p.inHand) status = '全下';
    else if (S.acting === p.seat) status = '思考中…';
    if (!p.connected) status = (status ? status + ' · ' : '') + '离线';
    const cls = ['seat'];
    if (p.seat === S.you) cls.push('human');
    if (p.folded) cls.push('folded');
    if (S.acting === p.seat) cls.push('acting');
    if (S.winners.indexOf(p.seat) !== -1) cls.push('winner');
    if (!p.connected) cls.push('offline');
    const dbtn = (p.seat === S.dealer && S.handNo > 0) ? '<div class="dbtn">D</div>' : '';
    let blind = '';
    if (S.phase === 'preflop') {
      if (p.seat === S.sb) blind = '<div class="blind-tag">SB</div>';
      else if (p.seat === S.bb) blind = '<div class="blind-tag bb">BB</div>';
      else if (p.seat === S.straddleSeat) blind = '<div class="blind-tag str">抓</div>';
    }
    // 动作徽章：check/call X/raise X/All in X 优先；无动作时显示本轮下注额（如盲注）
    // 外层 betbox 槽位恒定高度，有/无徽章座位不跳动
    let badge;
    if (p.lastAction) {
      const kind = p.lastAction === 'check' ? 'check' :
        p.lastAction.indexOf('All') === 0 ? 'allin' :
        p.lastAction.indexOf('raise') === 0 ? 'raise' : 'call';
      badge = '<div class="bet lastact-' + kind + '">' + esc(p.lastAction) + '</div>';
    } else {
      badge = p.bet > 0 ? '<div class="bet">下注 ' + p.bet + '</div>' : '';
    }
    return '<div class="' + cls.join(' ') + '" style="left:' + pos.left + ';top:' + pos.top + '">' +
      '<div class="cards">' + cards + '</div>' +
      '<div class="info">' + dbtn + blind +
        '<div class="name">' + esc(p.name) + '</div>' +
        '<div class="chips">筹码 ' + p.chips + '</div>' +
      '</div>' +
      '<div class="betbox">' + badge + '</div>' +
      '<div class="status">' + status + '</div>' +
      '<div class="hand-name">' + esc(p.showHand || '') + '</div>' +
    '</div>';
  }).join('');
}

function renderCommunity() {
  let html = S.community.map(c => cardHTML(c, false, 'c-' + c.suit + '-' + c.rank)).join('');
  for (let k = S.community.length; k < 5; k++) html += '<div class="slot"></div>';
  $('community').innerHTML = html;
}

function renderPot() {
  const area = $('pot-area');
  if (S.pot === 0 && !S.potBreakdown) { area.innerHTML = ''; return; }
  let html = '底池：' + S.pot;
  if (S.potBreakdown && S.potBreakdown.length > 1) {
    html += '<div class="breakdown">' +
      S.potBreakdown.map((p, i) => (i === 0 ? '主池 ' : '边池' + i + ' ') + p.amount).join(' ｜ ') + '</div>';
  }
  area.innerHTML = html;
}

function renderHint() {
  const me = S.players[S.you];
  if (!me) { $('hint').innerHTML = ''; return; }
  if (!me.inHand) {
    $('hint').innerHTML = S.phase === 'lobby'
      ? '<span class="dim">已入座，等待开始…</span>'
      : '<span class="dim">你在观战…</span>';
    return;
  }
  if (me.folded) { $('hint').innerHTML = '<span class="dim">你已弃牌，等待本局结束…</span>'; return; }
  $('hint').textContent = S.acting === S.you ? '轮到你行动' : '';
}

function myToCall() {
  const me = S.players[S.you];
  return Math.max(0, S.currentBet - (me ? me.bet : 0));
}

function renderControls() {
  const me = S.players[S.you];
  // 观战/候补模式：只显示准备区，隐藏操作区
  const actionIds = ['btn-fold', 'btn-call', 'btn-raise', 'btn-allin', 'raise-box', 'quick-bets', 'quick-select'];
  const setActionsVisible = (v) => { for (const id of actionIds) $(id).style.display = v ? '' : 'none'; };
  if (me && S.started && !me.ready) {
    setActionsVisible(false);
    $('ready-box').style.display = 'flex';
    $('btn-ready').style.display = '';
    $('btn-unready').style.display = 'none';
    $('ready-hint').textContent = '你在观战 · 点「准备」参与下一局';
    return;
  }
  if (me && S.started && me.ready && !me.inHand && !S.result) {
    setActionsVisible(false);
    $('ready-box').style.display = 'flex';
    $('btn-ready').style.display = 'none';
    $('btn-unready').style.display = '';
    $('ready-hint').textContent = '已准备 · 等待下一局发牌';
    return;
  }
  setActionsVisible(true);
  $('ready-box').style.display = 'none';
  const myTurn = S.acting === S.you && S.actingDeadline > 0;
  const canPlay = myTurn && me && me.inHand && !me.folded && !me.allIn;
  const toCall = myToCall();

  $('btn-fold').disabled = !canPlay;
  const btnCall = $('btn-call');
  btnCall.textContent = toCall === 0 ? '过牌' : (toCall >= me.chips ? '跟注（全下）' + me.chips : '跟注 ' + toCall);
  btnCall.disabled = !canPlay;

  const slider = $('raise-slider');
  const btnRaise = $('btn-raise');
  const maxTotal = (me ? me.bet + me.chips : 0);
  const minRaiseTotal = S.currentBet + S.minRaise;
  const canRaise = canPlay && maxTotal >= minRaiseTotal;
  slider.disabled = !canRaise;
  btnRaise.disabled = !canRaise;
  const qb = $('quick-bets').children;
  for (const b of qb) b.disabled = !canRaise;
  $('quick-select').disabled = !canRaise;
  // 开池时下注按钮叫「下注」，有注可加时才叫「加注」
  $('btn-raise').textContent = S.currentBet > 0 ? '加注' : '下注';
  if (canRaise) {
    if (slider.max != maxTotal || slider.min != minRaiseTotal) {
      slider.min = minRaiseTotal; slider.max = maxTotal; slider.step = 10;
      slider.value = minRaiseTotal;
      updateRaiseAmt();
    }
  } else {
    $('raise-amt').textContent = canPlay ? '筹码不足加注' : '';
  }
  $('btn-allin').disabled = !canPlay || me.chips <= 0;
}

function updateRaiseAmt() {
  const label = (S && S.currentBet > 0) ? '加注到 ' : '下注到 ';
  $('raise-amt').textContent = label + $('raise-slider').value;
}

function canContinue() {
  // 可继续条件：至少 2 名在线且有筹码的玩家
  return !!(S && S.players.filter(p => p.connected && p.chips > 0).length >= 2);
}

function renderResult() {
  const me = S.players[S.you];
  if (S.result) {
    $('panel-title').textContent = S.result.title;
    $('panel-body').innerHTML = S.result.lines.map(w =>
      '<div class="win-line"><b>' + esc(w.name) + '</b> 赢得 <b class="gold">' + w.amount + '</b>' +
      (w.hand ? '<span class="hn">' + esc(w.hand) + '</span>' : '') + '</div>').join('');
    const broke = me && me.chips <= 0;
    // 可继续条件：至少 2 名在线且有筹码的玩家（有人进房/重连后状态广播会自动刷新出按钮）
    const canNext = canContinue();
    $('panel-note').textContent = broke ? '你的筹码已用完，请点击「重新买入」继续' : '';
    $('btn-rebuy').style.display = broke ? '' : 'none';
    $('btn-next').style.display = canNext ? '' : 'none';   // 下一局已对全员放开，人够就显示
    $('btn-next').disabled = broke;
    $('result-wait').style.display = canNext ? 'none' : 'block';
    $('overlay').style.display = 'flex';
    // 只剩 1 人干等时：遮罩别挡死全屏——4 秒后自动收起（可点离开房间等）；
    // 有人进房/重连后状态广播重新走到这里，canNext=true 时结算页带「下一局」自动回归
    if (canNext) {
      clearTimeout(window._soloT); window._soloT = null;
    } else if (!broke && window._soloDismissedFor !== S.handNo && !window._soloT) {
      // 注意：broke（等待买入）时不自动收起——买入按钮必须留得住
      window._soloT = setTimeout(() => {
        window._soloT = null;
        if (S && S.result && !canContinue()) {
          window._soloDismissedFor = S.handNo;
          $('overlay').style.display = 'none';
        }
      }, 4000);
    }
  } else {
    $('overlay').style.display = 'none';
    window._soloDismissedFor = -1;
    clearTimeout(window._soloT); window._soloT = null;
  }
}

/* ---------------- 倒计时（服务器 deadline 驱动） ---------------- */
setInterval(() => {
  if (!S || !S.actingDeadline) { $('timer-box').classList.remove('on', 'danger'); return; }
  const leftMs = S.actingDeadline - Date.now();
  if (leftMs <= 0 || S.acting === -1) { $('timer-box').classList.remove('on', 'danger'); return; }
  const left = Math.ceil(leftMs / 1000);
  const box = $('timer-box');
  box.classList.add('on');
  $('timer-num').textContent = left;
  $('timer-bar').style.width = (left / 60 * 100) + '%';
  box.classList.toggle('danger', left <= 10);
}, 250);

/* ---------------- 动作发送 ---------------- */
function initControls() {
  $('btn-fold').addEventListener('click', () => ws.send(JSON.stringify({ t: 'act', act: { type: 'fold' } })));
  $('btn-call').addEventListener('click', () => {
    ws.send(JSON.stringify({ t: 'act', act: { type: myToCall() > 0 ? 'call' : 'check' } }));
  });
  $('btn-raise').addEventListener('click', () => {
    ws.send(JSON.stringify({ t: 'act', act: { type: 'raise', target: parseInt($('raise-slider').value, 10) } }));
  });
  $('btn-allin').addEventListener('click', () => ws.send(JSON.stringify({ t: 'act', act: { type: 'allin' } })));
  $('raise-slider').addEventListener('input', updateRaiseAmt);
  // 快捷注码：按底池 1/2、1/3、1/4 或 Allin 一键设定加注额
  $('quick-bets').addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!b || b.disabled || !S) return;
    const slider = $('raise-slider');
    if (slider.disabled) return;
    if (b.dataset.frac === 'all') {
      slider.value = slider.max;
    } else {
      const target = Math.round((S.currentBet + S.pot * parseFloat(b.dataset.frac)) / 10) * 10;
      slider.value = Math.max(parseInt(slider.min, 10), Math.min(parseInt(slider.max, 10), target));
    }
    updateRaiseAmt();
  });
  // 移动端下拉快捷注码（与按钮同一套计算）
  $('quick-select').addEventListener('change', () => {
    const v = $('quick-select').value;
    const slider = $('raise-slider');
    if (!v || slider.disabled) { $('quick-select').value = ''; return; }
    if (v === 'all') {
      slider.value = slider.max;
    } else {
      const target = Math.round((S.currentBet + S.pot * parseFloat(v)) / 10) * 10;
      slider.value = Math.max(parseInt(slider.min, 10), Math.min(parseInt(slider.max, 10), target));
    }
    updateRaiseAmt();
    $('quick-select').value = '';
  });
  $('btn-next').addEventListener('click', () => ws.send(JSON.stringify({ t: 'next' })));
  // 买入弹窗（顶栏「买入」与结算页「重新买入」共用；金额须为 1000 的倍数）
  function openRebuy() {
    $('rebuy-amount').value = 1000;
    $('rebuy-tip').textContent = '必须是 1000 的倍数（1000 ~ 100000）· 计入公账';
    $('rebuy-overlay').style.display = 'flex';
  }
  $('btn-rebuy').addEventListener('click', openRebuy);
  $('btn-rebuy2').addEventListener('click', openRebuy);
  $('btn-rebuy-cancel').addEventListener('click', () => { $('rebuy-overlay').style.display = 'none'; });
  $('rebuy-overlay').addEventListener('click', (e) => { if (e.target === $('rebuy-overlay')) $('rebuy-overlay').style.display = 'none'; });
  $('btn-rebuy-ok').addEventListener('click', () => {
    const amt = Math.round(Number($('rebuy-amount').value));
    if (!amt || amt < 1000 || amt % 1000 !== 0 || amt > 100000) {
      $('rebuy-tip').textContent = '金额无效：必须是 1000 的倍数（1000 ~ 100000）';
      return;
    }
    ws.send(JSON.stringify({ t: 'rebuy', amount: amt }));
    $('rebuy-overlay').style.display = 'none';
  });
  $('btn-buyins').addEventListener('click', () => { renderBuyins(); $('buyins-overlay').style.display = 'flex'; });
  $('btn-buyins-close').addEventListener('click', () => { $('buyins-overlay').style.display = 'none'; });
  $('buyins-overlay').addEventListener('click', (e) => { if (e.target === $('buyins-overlay')) $('buyins-overlay').style.display = 'none'; });
  $('btn-leave').addEventListener('click', () => {
    try { ws.send(JSON.stringify({ t: 'leave' })); } catch (e) { /* 忽略 */ }   // 通知服务器（创建者离开=解散房间）
    localStorage.removeItem('poker-online-session');
    session = null;
    setTimeout(() => location.reload(), 150);
  });
  // 抓位设置弹窗（房主开启/关闭，下一局生效）
  $('btn-straddle').addEventListener('click', () => {
    $('straddle-state').textContent = (S && S.straddleOn) ? '当前状态：已开启（盲注 10 / 20 / 40）' : '当前状态：未开启（盲注 10 / 20）';
    $('straddle-overlay').style.display = 'flex';
  });
  $('btn-straddle-close').addEventListener('click', () => { $('straddle-overlay').style.display = 'none'; });
  $('straddle-overlay').addEventListener('click', (e) => { if (e.target === $('straddle-overlay')) $('straddle-overlay').style.display = 'none'; });
  $('btn-str-on').addEventListener('click', () => {
    ws.send(JSON.stringify({ t: 'straddle', on: true }));
    $('straddle-overlay').style.display = 'none';
  });
  $('btn-str-off').addEventListener('click', () => {
    ws.send(JSON.stringify({ t: 'straddle', on: false }));
    $('straddle-overlay').style.display = 'none';
  });
  // 等待状态（只剩 1 人）时点遮罩空白处立即收起结算页
  $('overlay').addEventListener('click', (e) => {
    if (e.target === $('overlay') && S && S.result && !canContinue()) {
      window._soloDismissedFor = S.handNo;
      clearTimeout(window._soloT); window._soloT = null;
      $('overlay').style.display = 'none';
    }
  });
}

/* ---------------- 日志 ---------------- */
function addLog(msg, cls) {
  const box = $('log');
  const div = document.createElement('div');
  div.className = cls || 'act';
  div.textContent = msg;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
// 前端异常浮出水面：写入牌局日志，截图即可见（排障用）
window.addEventListener('error', (e) => {
  try { addLog('[前端异常] ' + (e.message || '未知错误'), 'sys'); } catch (err) { /* 忽略 */ }
});

$('btn-login').addEventListener('click', doLogin);
$('login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('login-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
if (token) connect(); else showLogin();
initLobby();
initControls();
