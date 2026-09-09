'use strict';
/* 在线德州扑克 · 客户端：大厅 + 牌桌渲染 + 动作发送 */
const SUITS = ['♠', '♥', '♦', '♣'];
const $ = id => document.getElementById(id);

let ws = null;
let S = null;                 // 最近一次服务器状态
let myName = localStorage.getItem('poker-online-name') || '';

/* ---------------- 连接 ---------------- */
function connect() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(proto + location.host);
  ws.onopen = () => { $('lobby-conn').textContent = '已连接服务器'; };
  ws.onclose = () => {
    $('lobby-conn').textContent = '连接已断开，请刷新页面重连';
    $('lobby').style.display = 'flex';
    $('lobby-msg').textContent = '与服务器断开连接';
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.t === 'state') { S = m; render(); }
    else if (m.t === 'log') addLog(m.msg, m.cls);
    else if (m.t === 'error') {
      if ($('lobby').style.display !== 'none') $('lobby-msg').textContent = m.msg;
      else addLog('提示：' + m.msg, 'sys');
    }
  };
}

/* ---------------- 大厅 ---------------- */
function myNameInput() {
  const v = $('name-input').value.replace(/[<>&"']/g, '').trim().slice(0, 8);
  return v || '玩家' + Math.floor(Math.random() * 100);
}

function initLobby() {
  $('name-input').value = myName;
  $('btn-create').addEventListener('click', () => {
    myName = myNameInput();
    localStorage.setItem('poker-online-name', myName);
    ws.send(JSON.stringify({ t: 'create', name: myName }));
    $('lobby-msg').textContent = '';
  });
  $('btn-join').addEventListener('click', () => {
    const code = $('code-input').value.toUpperCase().trim();
    if (code.length !== 4) { $('lobby-msg').textContent = '请输入 4 位房间码'; return; }
    myName = myNameInput();
    localStorage.setItem('poker-online-name', myName);
    ws.send(JSON.stringify({ t: 'join', code: code, name: myName }));
    $('lobby-msg').textContent = '';
  });
  $('btn-start').addEventListener('click', () => ws.send(JSON.stringify({ t: 'start' })));
}

function renderLobby() {
  $('lobby').style.display = 'flex';
  $('lobby-entry').style.display = 'none';
  $('lobby-room').style.display = 'block';
  $('lobby-code').textContent = S.code;
  $('lobby-players').innerHTML = S.players.map(p =>
    '<div class="lp"><span>' + esc(p.name) +
    (p.seat === S.hostSeat ? ' <span class="host-tag">[房主]</span>' : '') +
    (p.seat === S.you ? ' <span class="host-tag">（你）</span>' : '') + '</span>' +
    '<span>' + (p.connected ? '筹码 ' + p.chips : '<span class="off">离线</span>') + '</span></div>'
  ).join('');
  const isHost = S.you === S.hostSeat;
  $('btn-start').style.display = isHost ? '' : 'none';
  $('lobby-wait').style.display = isHost ? 'none' : 'block';
  $('btn-start').disabled = S.players.filter(p => p.connected).length < 2;
  $('btn-start').textContent = S.players.filter(p => p.connected).length < 2 ?
    '开始游戏（至少 2 人）' : '开始游戏（' + S.players.filter(p => p.connected).length + ' 人）';
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

/* ---------------- 座位坐标 ---------------- */
const SEAT_POS = [
  { left: '50%', top: '87%' }, { left: '15%', top: '68%' }, { left: '13%', top: '24%' },
  { left: '50%', top: '9%' }, { left: '87%', top: '24%' }, { left: '85%', top: '68%' }
];
const SEAT_POS_MOBILE = [
  { left: '50%', top: '86%' }, { left: '19%', top: '68%' }, { left: '19%', top: '25%' },
  { left: '50%', top: '11%' }, { left: '81%', top: '25%' }, { left: '81%', top: '68%' }
];

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
  if (!S.started) { renderLobby(); return; }
  $('lobby').style.display = 'none';
  $('room-code').textContent = S.code;
  $('hand-no').textContent = S.handNo;
  renderSeats();
  renderCommunity();
  renderPot();
  renderHint();
  renderControls();
  renderResult();
}

function renderSeats() {
  const positions = (window.innerWidth <= 768 ? SEAT_POS_MOBILE : SEAT_POS);
  $('seats').innerHTML = S.players.map(p => {
    const pos = positions[p.seat];
    const faceUp = p.cards.length > 0 && p.cards[0] !== null;
    const cards = p.cards.map((c, k) => cardHTML(c, !faceUp,
      faceUp ? 'f-' + (c ? c.suit + '-' + c.rank : 'x') + '-' + p.seat + '-' + k : 'b-p' + p.seat + '-' + k)).join('');
    let status = '';
    if (!p.inHand && S.phase !== 'lobby') status = p.chips <= 0 ? '等待买入' : '观战中';
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
    }
    return '<div class="' + cls.join(' ') + '" style="left:' + pos.left + ';top:' + pos.top + '">' +
      '<div class="cards">' + cards + '</div>' +
      '<div class="info">' + dbtn + blind +
        '<div class="name">' + esc(p.name) + '</div>' +
        '<div class="chips">筹码 ' + p.chips + '</div>' +
      '</div>' +
      (p.bet > 0 ? '<div class="bet">下注 ' + p.bet + '</div>' : '<div style="height:4px"></div>') +
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
  if (!me || !me.inHand) { $('hint').innerHTML = '<span class="dim">你在观战…</span>'; return; }
  if (me.folded) { $('hint').innerHTML = '<span class="dim">你已弃牌，等待本局结束…</span>'; return; }
  $('hint').textContent = S.acting === S.you ? '轮到你行动' : '';
}

function myToCall() {
  const me = S.players[S.you];
  return Math.max(0, S.currentBet - (me ? me.bet : 0));
}

function renderControls() {
  const myTurn = S.acting === S.you && S.actingDeadline > 0;
  const me = S.players[S.you];
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
  $('raise-amt').textContent = '加注到 ' + $('raise-slider').value;
}

function renderResult() {
  const me = S.players[S.you];
  if (S.result) {
    $('panel-title').textContent = S.result.title;
    $('panel-body').innerHTML = S.result.lines.map(w =>
      '<div class="win-line"><b>' + esc(w.name) + '</b> 赢得 <b class="gold">' + w.amount + '</b>' +
      (w.hand ? '<span class="hn">' + esc(w.hand) + '</span>' : '') + '</div>').join('');
    const broke = me && me.chips <= 0;
    $('panel-note').textContent = broke ? '你的筹码已用完，请点击「重新买入」继续' :
      (me && S.you !== S.hostSeat ? '等待房主开始下一局…' : '');
    $('btn-rebuy').style.display = broke ? '' : 'none';
    $('btn-next').style.display = (S.you === S.hostSeat) ? '' : 'none';
    $('btn-next').disabled = broke;
    $('overlay').style.display = 'flex';
  } else {
    $('overlay').style.display = 'none';
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
  $('btn-next').addEventListener('click', () => ws.send(JSON.stringify({ t: 'next' })));
  $('btn-rebuy').addEventListener('click', () => ws.send(JSON.stringify({ t: 'rebuy' })));
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

connect();
initLobby();
initControls();
