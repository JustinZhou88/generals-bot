'use strict';

/**
 * 观战直播服务器 (Live Viewer)
 *
 * 独立进程,不侵入 headless_bot.js:只监听 live_status.txt 的写入,
 * 解析成结构化棋盘后通过 SSE 推给浏览器,实现半回合级别的实时观战。
 *
 *   node live_viewer.js            # 默认 http://127.0.0.1:8787
 *   PORT=9000 node live_viewer.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const STATUS_TXT = path.join(__dirname, 'live_status.txt');
const PORT = Number(process.env.PORT || 8787);

let latest = { phase: 'unknown', raw: '' };
const clients = new Set();

// ---------------- 解析 live_status.txt ----------------

/** 单元格文本 → {sym, army, city}; sym: G我将 X敌将 M我 E敌 -空地 #山 ?雾障 .未探 ,去过 */
function parseCell(raw) {
  const s = raw.trim();
  if (!s) return { sym: '.', army: 0, city: false };
  const city = s[0] === 'o';
  const body = city ? s.slice(1) : s;
  const sym = body[0] || '.';
  const army = parseInt(body.slice(1), 10);
  return { sym, army: Number.isFinite(army) ? army : 0, city };
}

function parseStatus(text) {
  if (!text || !text.trim()) return null;

  if (text.includes('不在对局中')) {
    return { phase: 'idle', pageText: text.split('\n').slice(2).join('\n').trim(), ts: Date.now() };
  }

  const lines = text.split('\n');
  const head = lines.join('\n');
  const num = (re, d = null) => { const m = head.match(re); return m ? m : d; };

  const mMe = num(/回合 (\d+)\s+\((.*?)\)\s+兵力 (\d+) \/ 地块 (\d+)/);
  if (!mMe) return null;
  const mOpp = num(/对手 (.*?)(\s+\[已阵亡\])?\s+兵力 (\d+) \/ 地块 (\d+)/);
  const mGen = num(/我方将军 (\[.*?\]|null)\s+敌将定位 (\[.*?\]|未知)/);
  const mStar = num(/星级 我 (\S+) \/ 对手 (\S+)/);
  const mCity = num(/塔数 我 实测 (\d+) 推断 (\S+) \/ 对手 推断 (\S+) \(样本 (\d+)\)/);
  const mThreat = num(/最近威胁 (.+)/);
  const mMove = num(/本步 (.+)/);
  const mReplay = num(/回放 (\S+)/);

  // 棋盘:列头行之后,每行 4 字符行号前缀 + 若干个 5 字符单元格
  const headerIdx = lines.findIndex((l) => /^\s{4,}0\s+1\s+2/.test(l));
  if (headerIdx < 0) return null;

  const grid = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*\d+\s/.test(line)) continue;
    const row = [];
    for (let p = 4; p < line.length; p += 5) row.push(parseCell(line.slice(p, p + 5)));
    if (row.length) grid.push(row);
  }
  if (!grid.length) return null;

  return {
    phase: 'in_game',
    ts: Date.now(),
    turn: Number(mMe[1]),
    meName: mMe[2],
    meArmy: Number(mMe[3]),
    meLand: Number(mMe[4]),
    oppName: mOpp ? mOpp[1] : '?',
    oppDead: !!(mOpp && mOpp[2]),
    oppArmy: mOpp ? Number(mOpp[3]) : 0,
    oppLand: mOpp ? Number(mOpp[4]) : 0,
    myGeneral: mGen ? mGen[1] : null,
    enemyGeneral: mGen && mGen[2] !== '未知' ? mGen[2] : null,
    meStar: mStar ? mStar[1] : '?',
    oppStar: mStar ? mStar[2] : '?',
    meCityActual: mCity ? mCity[1] : null,
    meCityEst: mCity ? mCity[2] : null,
    oppCityEst: mCity ? mCity[3] : null,
    citySamples: mCity ? Number(mCity[4]) : 0,
    threat: mThreat ? mThreat[1].trim() : '无',
    move: mMove ? mMove[1].trim() : '',
    replay: mReplay ? mReplay[1] : '',
    width: Math.max(...grid.map((r) => r.length)),
    height: grid.length,
    grid
  };
}

function refresh() {
  let text;
  try {
    text = fs.readFileSync(STATUS_TXT, 'utf8');
  } catch (e) {
    return;
  }
  const parsed = parseStatus(text);
  if (!parsed) return; // 写入瞬间可能读到半截,保留上一帧
  latest = parsed;
  const payload = `data: ${JSON.stringify(latest)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch (e) { clients.delete(res); }
  }
}

// fs.watch 在 macOS 上偶有漏事件,配合低频轮询兜底
let debounce = null;
try {
  fs.watch(STATUS_TXT, () => {
    clearTimeout(debounce);
    debounce = setTimeout(refresh, 60);
  });
} catch (e) {
  console.log('[viewer] fs.watch 不可用,退回轮询模式');
}
setInterval(refresh, 500);
refresh();

// ---------------- 页面 ----------------

const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>generals.io 观战直播</title>
<style>
  :root {
    --bg:#0b0f19; --panel:#151b2b; --line:#232c42; --text:#e6ebf5; --dim:#8a95ad;
    --me:#2f6df6; --me2:#5b8cff; --opp:#e03b3b; --opp2:#ff6b6b;
    --neutral:#5d6780; --mtn:#2b3348; --fog:#0e1320; --fogseen:#161d2e; --gold:#f5c542;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
         font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif; }
  header { display:flex; align-items:center; gap:16px; flex-wrap:wrap;
           padding:12px 18px; background:var(--panel); border-bottom:1px solid var(--line); }
  .turn { font-size:22px; font-weight:700; letter-spacing:.5px; }
  .chip { display:flex; align-items:center; gap:10px; padding:6px 12px; border-radius:10px;
          background:#1b2333; border:1px solid var(--line); }
  .dot { width:10px; height:10px; border-radius:50%; }
  .name { font-weight:600; }
  .star { color:var(--gold); font-weight:600; font-variant-numeric:tabular-nums; }
  .stat { color:var(--dim); font-variant-numeric:tabular-nums; }
  .stat b { color:var(--text); font-size:15px; }
  .spacer { flex:1; }
  .meta { color:var(--dim); font-size:12px; text-align:right; }
  .meta a { color:var(--me2); text-decoration:none; }
  .bar { height:6px; display:flex; background:var(--line); }
  .bar i { display:block; height:100%; transition:width .3s ease; }
  main { padding:16px; display:flex; gap:16px; align-items:flex-start; flex-wrap:wrap; }
  #boardWrap { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:10px;
               overflow:auto; max-width:100%; }
  #board { display:grid; gap:1px; }
  /* 作者样式的 display 会盖过 [hidden] 的 UA 样式,必须显式写回 */
  #board[hidden], #idle[hidden] { display:none; }
  .c { position:relative; display:flex; align-items:center; justify-content:center;
       border-radius:2px; font-weight:700; font-variant-numeric:tabular-nums;
       background:var(--fog); color:#fff; transition:background .18s ease; }
  /* 家(将军)=王冠 ♛,塔(城)=塔楼 ♜,图标垫在兵力数字底下 */
  .c::before { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
               font-size:1.55em; line-height:1; opacity:.34; pointer-events:none; }
  .c.gen::before { content:'♛'; opacity:.62; color:var(--gold); }
  .c.city::before { content:'♜'; }
  .c > span { position:relative; text-shadow:0 1px 2px rgba(0,0,0,.65); }
  .c.seen { background:var(--fogseen); }
  .c.empty { background:#39415a; }
  .c.mtn { background:var(--mtn); color:#4d5878; }
  .c.obst { background:#1a2135; color:#39415a; }
  .c.me { background:var(--me); }
  .c.opp { background:var(--opp); }
  .c.gen { box-shadow:inset 0 0 0 2px var(--gold); }
  .c.city { border-radius:50%; }
  .c.from { outline:2px dashed var(--gold); outline-offset:-2px; }
  .c.to { outline:2px solid var(--gold); outline-offset:-2px; animation:pulse .5s ease; }
  @keyframes pulse { from { transform:scale(1.25); } to { transform:scale(1); } }
  aside { width:290px; min-width:240px; flex:1; display:flex; flex-direction:column; gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:12px 14px; }
  .card h3 { margin:0 0 8px; font-size:12px; letter-spacing:1px; color:var(--dim); font-weight:600; }
  .kv { display:flex; justify-content:space-between; gap:10px; padding:3px 0; }
  .kv span:last-child { font-weight:600; }
  .danger { color:var(--opp2); }
  #log { max-height:230px; overflow:auto; font-size:12px; color:var(--dim); }
  #log div { padding:2px 0; border-bottom:1px solid #1b2333; }
  #idle { white-space:pre-wrap; color:var(--dim); font-size:13px; }
  .legend { font-size:12px; color:var(--dim); display:flex; flex-wrap:wrap; gap:8px 14px; }
  .legend i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; vertical-align:-1px; }
  .off { opacity:.45; }
</style>
</head>
<body>
<header>
  <div class="turn">回合 <span id="turn">–</span></div>
  <div class="chip"><span class="dot" style="background:var(--me)"></span>
    <span class="name" id="meName">我</span>
    <span class="star" id="meStar">★ –</span>
    <span class="stat">兵 <b id="meArmy">0</b> · 地 <b id="meLand">0</b> · <span title="将军+塔的每回合产兵">♜ <b id="meCity">–</b></span></span></div>
  <div class="chip"><span class="dot" style="background:var(--opp)"></span>
    <span class="name" id="oppName">对手</span>
    <span class="star" id="oppStar">★ –</span>
    <span class="stat">兵 <b id="oppArmy">0</b> · 地 <b id="oppLand">0</b> · <span title="由非战斗回合兵力自然增长推断">♜ <b id="oppCity">–</b></span></span></div>
  <div class="spacer"></div>
  <div class="meta"><div id="conn">连接中…</div><div id="replayBox"></div></div>
</header>
<div class="bar"><i id="barMe" style="background:var(--me);width:50%"></i><i id="barOpp" style="background:var(--opp);width:50%"></i></div>

<main>
  <div id="boardWrap"><div id="board"></div><div id="idle" hidden></div></div>
  <aside>
    <div class="card">
      <h3>局势</h3>
      <div class="kv"><span>兵力差</span><span id="dArmy">–</span></div>
      <div class="kv"><span>地块差</span><span id="dLand">–</span></div>
      <div class="kv"><span>我方塔数 ♜</span><span id="myCityDetail">–</span></div>
      <div class="kv"><span>对方塔数 ♜(推断)</span><span id="oppCityDetail">–</span></div>
      <div class="kv"><span>我方将军</span><span id="myGen">–</span></div>
      <div class="kv"><span>敌将定位</span><span id="enGen">未知</span></div>
      <div class="kv"><span>最近威胁</span><span id="threat">无</span></div>
    </div>
    <div class="card">
      <h3>兵力走势</h3>
      <svg id="spark" viewBox="0 0 260 70" width="100%" height="70" preserveAspectRatio="none">
        <polyline id="sparkMe" fill="none" stroke="var(--me2)" stroke-width="2"></polyline>
        <polyline id="sparkOpp" fill="none" stroke="var(--opp2)" stroke-width="2"></polyline>
      </svg>
    </div>
    <div class="card"><h3>决策日志</h3><div id="log"></div></div>
    <div class="card"><h3>图例</h3>
      <div class="legend">
        <span><i style="background:var(--me)"></i>我方</span>
        <span><i style="background:var(--opp)"></i>敌方</span>
        <span><i style="background:#39415a"></i>空地</span>
        <span><i style="background:var(--mtn)"></i>山</span>
        <span><i style="background:var(--fogseen)"></i>去过的雾</span>
        <span><i style="background:var(--fog)"></i>未探索</span>
        <span>♛ 家(将军)</span>
        <span>♜ 塔(城)</span>
      </div>
    </div>
  </aside>
</main>

<script>
const $ = (id) => document.getElementById(id);
const hist = [];
let lastMove = null, lastTurn = -1;

function cellClass(c) {
  if (c.sym === '#') return 'c mtn';
  if (c.sym === '?') return 'c obst';
  if (c.sym === '.') return 'c';
  if (c.sym === ',') return 'c seen';
  if (c.sym === '-') return 'c empty' + (c.city ? ' city' : '');
  let k = 'c ';
  k += (c.sym === 'M' || c.sym === 'G') ? 'me' : 'opp';
  if (c.sym === 'G' || c.sym === 'X') k += ' gen';
  if (c.city) k += ' city';
  return k;
}

function parseRC(s) {
  if (!s || s === 'null') return null;
  const m = s.match(/\\[(\\d+),\\s*(\\d+)\\]/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function render(s) {
  if (s.phase === 'idle') {
    $('board').hidden = true; $('idle').hidden = false;
    $('idle').textContent = '⏳ 不在对局中 —— 排队/菜单状态:\\n\\n' + s.pageText;
    $('turn').textContent = '–';
    return;
  }
  $('board').hidden = false; $('idle').hidden = true;

  // 协议里的 turn 是「半回合 tick」,官方界面显示的回合数是它的一半
  const officialTurn = Math.floor(s.turn / 2);
  $('turn').textContent = officialTurn;
  $('meName').textContent = s.meName;
  $('oppName').textContent = s.oppName + (s.oppDead ? ' ☠' : '');
  $('meArmy').textContent = s.meArmy; $('meLand').textContent = s.meLand;
  $('oppArmy').textContent = s.oppArmy; $('oppLand').textContent = s.oppLand;

  $('meStar').textContent = '★ ' + (s.meStar || '?');
  $('oppStar').textContent = '★ ' + (s.oppStar || '?');
  $('meCity').textContent = s.meCityActual != null ? s.meCityActual : '–';
  $('oppCity').textContent = s.oppCityEst && s.oppCityEst !== '-' ? s.oppCityEst : '–';
  $('myCityDetail').textContent = s.meCityActual != null
    ? '实测 ' + s.meCityActual + ' · 推断 ' + s.meCityEst : '–';
  $('oppCityDetail').textContent = s.oppCityEst && s.oppCityEst !== '-'
    ? s.oppCityEst + ' 座 (样本 ' + s.citySamples + ')'
    : '样本积累中 (' + s.citySamples + ')';

  const tot = Math.max(1, s.meArmy + s.oppArmy);
  $('barMe').style.width = (s.meArmy / tot * 100) + '%';
  $('barOpp').style.width = (s.oppArmy / tot * 100) + '%';

  const dA = s.meArmy - s.oppArmy, dL = s.meLand - s.oppLand;
  $('dArmy').textContent = (dA >= 0 ? '+' : '') + dA;
  $('dArmy').className = dA >= 0 ? '' : 'danger';
  $('dLand').textContent = (dL >= 0 ? '+' : '') + dL;
  $('dLand').className = dL >= 0 ? '' : 'danger';
  $('myGen').textContent = s.myGeneral || '–';
  $('enGen').textContent = s.enemyGeneral || '未知';
  $('enGen').className = s.enemyGeneral ? 'danger' : '';
  $('threat').textContent = s.threat;
  $('threat').className = /距将 [0-3] 格/.test(s.threat) ? 'danger' : '';
  $('replayBox').innerHTML = s.replay ? '<a href="' + s.replay + '" target="_blank">官方回放</a>' : '';

  // 棋盘
  const board = $('board');
  const size = Math.max(16, Math.min(34, Math.floor((window.innerWidth - 360) / s.width) - 1));
  board.style.gridTemplateColumns = 'repeat(' + s.width + ',' + size + 'px)';
  board.style.gridAutoRows = size + 'px';
  board.style.fontSize = Math.max(9, Math.floor(size * 0.42)) + 'px';

  const mv = s.move.match(/(\\[\\d+,\\s*\\d+\\]) → (\\[\\d+,\\s*\\d+\\])/);
  const from = mv ? parseRC(mv[1]) : null, to = mv ? parseRC(mv[2]) : null;

  const need = s.width * s.height;
  while (board.children.length < need) {
    const d = document.createElement('div');
    d.appendChild(document.createElement('span')); // 数字放 span 里,才能压在 ::before 图标之上
    board.appendChild(d);
  }
  while (board.children.length > need) board.lastChild.remove();

  for (let r = 0; r < s.height; r++) {
    for (let c = 0; c < s.width; c++) {
      const cell = s.grid[r][c] || { sym: '.', army: 0 };
      const el = board.children[r * s.width + c];
      let cls = cellClass(cell);
      if (from && from[0] === r && from[1] === c) cls += ' from';
      if (to && to[0] === r && to[1] === c) cls += ' to';
      if (el.className !== cls) el.className = cls;
      const txt = cell.army > 0 ? String(cell.army) : (cell.sym === '#' ? '▲' : '');
      if (el.firstChild.textContent !== txt) el.firstChild.textContent = txt;
    }
  }

  // 走势 + 日志
  if (s.turn !== lastTurn) {
    hist.push([s.meArmy, s.oppArmy]);
    if (hist.length > 120) hist.shift();
    drawSpark();
    if (s.move && s.move !== lastMove) {
      lastMove = s.move;
      const d = document.createElement('div');
      d.textContent = 'T' + officialTurn + '  ' + s.move;
      $('log').prepend(d);
      while ($('log').children.length > 60) $('log').lastChild.remove();
    }
    lastTurn = s.turn;
  }
}

function drawSpark() {
  if (hist.length < 2) return;
  const max = Math.max(1, ...hist.flat());
  const pts = (i) => hist.map((h, x) =>
    (x / (hist.length - 1) * 260).toFixed(1) + ',' + (68 - h[i] / max * 64).toFixed(1)).join(' ');
  $('sparkMe').setAttribute('points', pts(0));
  $('sparkOpp').setAttribute('points', pts(1));
}

const es = new EventSource('/events');
es.onopen = () => { $('conn').textContent = '● 直播中'; $('conn').className = 'meta'; };
es.onerror = () => { $('conn').textContent = '○ 重连中…'; };
es.onmessage = (e) => render(JSON.parse(e.data));
window.addEventListener('resize', () => { if (window._last) render(window._last); });
const _r = render; render = (s) => { window._last = s; _r(s); };
</script>
</body>
</html>`;

// ---------------- 服务 ----------------

http.createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write(`data: ${JSON.stringify(latest)}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.url === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(latest));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[viewer] 🔴 观战直播已开: http://127.0.0.1:${PORT}`);
  console.log(`[viewer] 数据源: ${STATUS_TXT}`);
});
