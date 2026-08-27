'use strict';

const { chromium } = require('playwright-core');
const { GameState } = require('./src/gamestate');
const { Strategy } = require('./src/strategy_v55');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const USER_ID = process.env.GENERALS_USER_ID || 'HkiU9LHoj';
const INITIAL_URL = `https://generals.io/?user_id=${encodeURIComponent(USER_ID)}&email=justinzhouwuxi%40gmail.com`;
const STATUS_PNG = path.join(__dirname, 'current_status.png');
const STATUS_TXT = path.join(__dirname, 'live_status.txt');
const STATUS_JSON = path.join(__dirname, 'live_status.json');
const SURRENDER_FILE = path.join(__dirname, 'do_surrender');

// 本机 generals.io 走代理解析(fake-IP),Headless Chrome 不继承系统代理,必须显式指定。
const PROXY = process.env.GENERALS_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;

// 单实例锁:同账号跑两个实例会互相打断(一个点 PLAY、另一个刚好重载页面),
// 表现为永远排不进队列。启动前先确认没有别的实例在跑。
// 必须用 'wx' 原子独占创建 —— 早先「读取→判断→写入」的写法不是原子的,
// restart_bot.sh 与 keep_alive.sh 几乎同时拉起时,两个进程会在对方写 pid 前
// 都完成读取,双双通过检查,于是两个实例抢同一账号互相打断(排不进队列)。
const LOCK_FILE = path.join(__dirname, '.bot.pid');
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');   // 已存在则直接抛错
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const old = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
      try {
        if (old && old !== process.pid) process.kill(old, 0); // 不抛 = 还活着
        console.error(`[headless] ❌ 已有 Bot 实例在运行 (pid ${old})，本次启动退出。`);
        return false;
      } catch (dead) {
        console.log(`[headless] 🧹 清理僵尸锁 (pid ${old} 已不存在)`);
        try { fs.unlinkSync(LOCK_FILE); } catch (e2) {}
      }
    }
  }
  return false;
}
if (!acquireLock()) process.exit(1);
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
    if (sig !== 'exit') process.exit(0);
  });
}

// 网络故障可能把 Chrome 页面搞死,之后任何 Playwright 调用都会抛
// ProtocolError(Not attached to an active page)。这种状态下进程已无法自救,
// 但必须干净退出并释放 pid 锁,交给 keep_alive.sh 拉起新实例 —— 否则就像
// 2026-07-30 凌晨那样静默停机数小时。
for (const evt of ['uncaughtException', 'unhandledRejection']) {
  process.on(evt, (err) => {
    console.error(`[headless] 💥 未捕获错误 (${evt}): ${err && err.message ? err.message : err}`);
    console.error(`[headless] 进程退出,等待守护脚本重启…`);
    try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
    process.exit(1);
  });
}

console.log(`[headless] 🚀 正在精准使用初始链接打开并刷新主服务器: ${INITIAL_URL}`);
console.log(`[headless] 目标账号: ${USER_ID}, 激活策略: src/strategy_v55.js`);
console.log(`[headless] 实时战况文本: ${STATUS_TXT} (JSON: ${STATUS_JSON}, 空闲截图: ${STATUS_PNG})`);
if (PROXY) console.log(`[headless] 浏览器代理: ${PROXY}`);

let gs = null;
let strategy = null;
let currentGameData = null;
let inGame = false;
let lastDangerTurn = null;
let queueing = false;
let queueFailures = 0;     // 连续排队失败次数,达到阈值就强制重载页面
let lastUpdateAt = Date.now();  // 最近一次收到 game_update 的时刻(掉线检测用)
// socket 的 'stars' 事件只推自己的星级(按模式索引),拿不到对手,
// 因此双方星级改用官方公开接口 /api/starsAndRanks?u=<用户名> 按用户名查。
let starsByName = {};      // username -> { stars, rank, isBot }

// 自动投降:兵力被拉开到 SURRENDER_RATIO 倍时止损。挂机拖延局(对手滚塔滚到
// 几万兵却不收尾)会白白占掉几十分钟,认输换下一局的期望收益高得多。
const SURRENDER_RATIO = Number(process.env.SURRENDER_RATIO || 5);
let hopelessStreak = 0;    // 连续多少个 tick 满足劣势条件(防抖,避免瞬时误判)
let surrendering = false;  // 本局是否已发过投降,避免重复发送

const REPLAY_DIR = path.join(__dirname, 'replay_links');
const REPLAY_INDEX = path.join(REPLAY_DIR, 'replays.md');

function logMatchEvent(text) {
  const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = `[${timeStr}] ${text}`;
  console.log(line);
}

// ---------- 实时战况:直接把 Node 侧的 GameState 渲染成文本,精度远高于截图 ----------

/** 单格渲染: G=我将 X=敌将 M=我 E=敌 -=空地 o前缀=城 #=山 ?=雾中障碍 .=迷雾 */
function cellStr(gs, t) {
  if (gs.terrain[t] === -2 || gs.discoveredMountains.has(t)) return '#';
  if (gs.terrain[t] === -4) return gs.knownCities.has(t) ? 'oC' : '?';
  if (gs.terrain[t] === -3) return gs.everSeen && gs.everSeen[t] ? ',' : '.';

  let sym;
  if (t === gs.myGeneral()) sym = 'G';
  else if (gs.terrain[t] === gs.playerIndex) sym = 'M';
  else if (gs.terrain[t] >= 0) sym = [...gs.knownGenerals].some(([p, tile]) => tile === t && p !== gs.playerIndex) ? 'X' : 'E';
  else sym = '-';

  const army = gs.armies[t] || 0;
  return (gs.knownCities.has(t) ? 'o' : '') + sym + (army > 0 ? String(army) : '');
}

function renderBoard(gs) {
  const lines = [];
  let head = '    ';
  for (let c = 0; c < gs.width; c++) head += String(c % 10).padStart(5);
  lines.push(head);
  for (let r = 0; r < gs.height; r++) {
    let line = String(r).padStart(3) + ' ';
    for (let c = 0; c < gs.width; c++) line += cellStr(gs, gs.tileAt(r, c)).padStart(5);
    lines.push(line);
  }
  return lines.join('\n');
}

// ---------- 塔数推断 ----------
//
// 机制:将军与每座己方塔在「每个整回合」(=2 个半回合 tick) 各 +1 兵,
//      其余地块只在每 25 回合(=50 tick)的翻倍点 +1。
// 于是在「地块数不变(没扩张也没被吃) 且 未跨越翻倍点」的相邻两 tick 之间:
//      兵力增量 = 1(将军) + 塔数
// 交战会污染个别样本,故取滑动窗口内增量的众数,而不是均值。

const growth = new Map(); // playerIndex -> { hist: [{turn,total,tiles}], samples: [] }

function updateGrowthStats(gs) {
  for (const s of gs.scores) {
    let g = growth.get(s.i);
    if (!g) { g = { hist: [], samples: [] }; growth.set(s.i, g); }

    // game_update 每个半回合(tick)触发一次,而产兵是「每整回合」=每 2 tick 一次。
    // 所以必须跟 2 个 tick 之前的帧比,不能跟上一帧比。
    const base = g.hist.find((h) => h.turn === gs.turn - 2);
    const mid = g.hist.find((h) => h.turn === gs.turn - 1);
    if (base && mid) {
      const tilesStable = s.tiles === base.tiles && s.tiles === mid.tiles;
      const noFarm = Math.floor(base.turn / 50) === Math.floor(gs.turn / 50);
      if (tilesStable && noFarm) {
        const d = s.total - base.total;   // = 1(将军) + 塔数
        if (d >= 1 && d <= 40) {
          g.samples.push(d);
          if (g.samples.length > 40) g.samples.shift();
        }
      }
    }

    g.hist.push({ turn: gs.turn, total: s.total, tiles: s.tiles });
    if (g.hist.length > 6) g.hist.shift();
  }
}

/** 返回 {cities, samples} —— 样本不足时返回 null */
function estimateCities(i) {
  const g = growth.get(i);
  if (!g || g.samples.length < 4) return null;
  const counts = new Map();
  for (const v of g.samples) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null, bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return { cities: Math.max(0, best - 1), samples: g.samples.length };
}

/** 我方实际持有的塔数(自己的地图信息是确定的,用来校验推断) */
function myCityCount(gs) {
  let n = 0;
  for (const t of gs.knownCities) if (gs.terrain[t] === gs.playerIndex) n++;
  return n;
}

/** 距我将最近的敌兵(威胁评估) */
function nearestThreat(gs) {
  const gen = gs.myGeneral();
  if (gen === undefined || gen < 0) return null;
  let best = null;
  for (let t = 0; t < gs.size; t++) {
    if (!gs.isEnemy(t) || (gs.armies[t] || 0) < 2) continue;
    const d = gs.dist(t, gen);
    if (!best || d < best.dist) best = { dist: d, army: gs.armies[t], at: [gs.row(t), gs.col(t)] };
  }
  return best;
}

function rc(gs, t) { return t === undefined || t < 0 ? null : [gs.row(t), gs.col(t)]; }

/** 对局结束后把回放链接单独归档到 replay_links/ 目录 */
function archiveReplay(result) {
  if (!currentGameData || !currentGameData.replay_id) return;
  const id = currentGameData.replay_id;
  const url = `https://generals.io/replays/${encodeURIComponent(id)}`;
  const opp = (currentGameData.usernames || [])
    .filter((_, i) => i !== currentGameData.playerIndex).join(',') || '未知对手';
  const now = new Date();
  const stamp = now.toLocaleString('zh-CN', { hour12: false });
  const fileStamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const safeOpp = opp.replace(/[^\w一-龥-]/g, '_').slice(0, 24);

  try {
    fs.mkdirSync(REPLAY_DIR, { recursive: true });
    if (!fs.existsSync(REPLAY_INDEX)) {
      fs.writeFileSync(REPLAY_INDEX, '# Generals.io 对局回放\n\n| 时间 | 对手 | 结果 | 回放 |\n|---|---|---|---|\n');
    }
    fs.appendFileSync(REPLAY_INDEX, `| ${stamp} | ${opp} | ${result} | [${id}](${url}) |\n`);
    // 每局一个 macOS 可双击打开的 .webloc
    const webloc = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>URL</key><string>${url}</string></dict></plist>\n`;
    fs.writeFileSync(path.join(REPLAY_DIR, `${fileStamp}_${result}_vs_${safeOpp}.webloc`), webloc);
    logMatchEvent(`📁 回放链接已归档: replay_links/`);
  } catch (e) {
    logMatchEvent(`⚠️ 回放归档失败: ${e.message}`);
  }
}

function writeLiveStatus(lastMove, purpose) {
  if (!gs || !gs.size) return;
  const me = gs.myScore();
  const enemies = gs.enemyScores();
  const threat = nearestThreat(gs);
  const enemyGen = [...gs.knownGenerals].find(([p]) => p !== gs.playerIndex);

  const oppIdx = enemies.length ? enemies[0].i : null;
  const star = (i) => {
    const name = i !== null && gs.usernames ? gs.usernames[i] : null;
    const info = name ? starsByName[name] : null;
    if (!info || info.stars == null) return '?';
    return info.stars + (info.isBot ? '[Bot]' : '');
  };
  const myEst = estimateCities(gs.playerIndex);
  const oppEst = oppIdx !== null ? estimateCities(oppIdx) : null;
  const myActual = myCityCount(gs);

  const state = {
    ts: new Date().toISOString(),
    phase: 'in_game',
    turn: gs.turn,
    replay: gs.replayUrl,
    me: { name: gs.usernames ? gs.usernames[gs.playerIndex] : '?', army: me.total, land: me.tiles, general: rc(gs, gs.myGeneral()) },
    enemies: enemies.map((s) => ({ name: gs.usernames ? gs.usernames[s.i] : '?', army: s.total, land: s.tiles, dead: !!s.dead })),
    enemyGeneralFound: enemyGen ? rc(gs, enemyGen[1]) : null,
    stars: { me: star(gs.playerIndex), opp: star(oppIdx) },
    cities: {
      meActual: myActual,
      meEstimate: myEst ? myEst.cities : null,
      oppEstimate: oppEst ? oppEst.cities : null,
      samples: { me: myEst ? myEst.samples : 0, opp: oppEst ? oppEst.samples : 0 }
    },
    threat,
    lastMove: lastMove ? { from: rc(gs, lastMove.from), to: rc(gs, lastMove.to), half: !!lastMove.is50, purpose: purpose || null } : null
  };

  const head = [
    `回合 ${gs.turn}  (${state.me.name})  兵力 ${me.total} / 地块 ${me.tiles}`,
    ...state.enemies.map((e) => `对手 ${e.name}${e.dead ? ' [已阵亡]' : ''}  兵力 ${e.army} / 地块 ${e.land}`),
    `星级 我 ${state.stars.me} / 对手 ${state.stars.opp}`,
    `塔数 我 实测 ${myActual} 推断 ${myEst ? myEst.cities : '-'} / 对手 推断 ${oppEst ? oppEst.cities : '-'} (样本 ${oppEst ? oppEst.samples : 0})`,
    `我方将军 ${JSON.stringify(state.me.general)}   敌将定位 ${state.enemyGeneralFound ? JSON.stringify(state.enemyGeneralFound) : '未知'}`,
    `最近威胁 ${threat ? `${threat.army} 兵 距将 ${threat.dist} 格 @${JSON.stringify(threat.at)}` : '无'}`,
    `本步 ${state.lastMove ? `${JSON.stringify(state.lastMove.from)} → ${JSON.stringify(state.lastMove.to)}${state.lastMove.purpose ? ' (' + state.lastMove.purpose + ')' : ''}` : '按兵不动'}`,
    `回放 ${gs.replayUrl || ''}`,
    `图例 G=我将 X=敌将 M=我方 E=敌方 -=空地 o=城 #=山 ?=雾中障碍 ,=去过的雾 .=未探索`,
    ''
  ].join('\n');

  try {
    fs.writeFileSync(STATUS_TXT, head + renderBoard(gs) + '\n');
    fs.writeFileSync(STATUS_JSON, JSON.stringify(state, null, 2));
  } catch (e) {}
}

(async () => {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    ...(PROXY ? { proxy: { server: PROXY } } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--window-size=1280,720']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 }
  });

  const page = await context.newPage();

  // 对局中战况由 game_update 直接写文本快照(见 writeLiveStatus);
  // 此定时器只负责空闲期(菜单/排队)的页面文字状态 + 兜底截图 + Surrender 信号监听。
  setInterval(async () => {
    if (!inGame) {
      try {
        const menuText = await page.evaluate(() => (document.body.innerText || '').trim().split('\n').map(s => s.trim()).filter(Boolean).slice(0, 25).join('\n'));
        fs.writeFileSync(STATUS_TXT, `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 不在对局中 — 页面文字状态:\n\n${menuText}\n`);
        fs.writeFileSync(STATUS_JSON, JSON.stringify({ ts: new Date().toISOString(), phase: 'idle', pageText: menuText }, null, 2));
      } catch (e) {}
      try {
        await page.screenshot({ path: STATUS_PNG });
      } catch (e) {}
    }

    // 检测投降信号
    if (fs.existsSync(SURRENDER_FILE)) {
      try {
        fs.unlinkSync(SURRENDER_FILE);
      } catch (e) {}
      const connected = await page.evaluate(() => {
        if (window.socket && window.socket.connected) {
          window.socket.emit('surrender');
          window.socket.emit('leave_game');
          return true;
        }
        return false;
      });
      logMatchEvent(connected
        ? `🏳️ 收到用户投降指令，已向服务器发送 surrender / leave_game`
        : `🏳️ 收到投降指令，但 socket 未连接（指令无法送达），转为强制重置对局`);
      if (!connected) { inGame = false; startQueue(page); }
    }

    // 掉线看门狗:socket 断开时不会有 game_lost/game_won,inGame 会永远卡在 true,
    // 于是既不更新战况也不重新排队。数据流静止超过 45 秒即判定掉线并自行恢复。
    if (inGame && Date.now() - lastUpdateAt > 45000) {
      logMatchEvent(`⛔ 对局数据流已静止 ${Math.round((Date.now() - lastUpdateAt) / 1000)} 秒，判定掉线，重置并重新排队`);
      inGame = false;
      queueFailures = 2; // 强制重载页面,重建 socket
      startQueue(page);
    }
  }, 2000);

  page.on('console', msg => {
    const txt = msg.text();
    if (txt.includes('[browser]') || txt.includes('[v51 bot]') || txt.includes('[headless]')) {
      console.log(txt);
    }
  });

  // 绑定 Node.js 与 Headless Chrome 浏览器的 v51 决策桥梁
  /** 在页面内 fetch 官方星级接口(直接复用浏览器的代理与同源上下文) */
  async function fetchStars(usernames) {
    try {
      const res = await page.evaluate(async (names) => {
        const out = {};
        for (const n of names) {
          try {
            const r = await fetch('/api/starsAndRanks?u=' + encodeURIComponent(n));
            const j = await r.json();
            const s = j.stars && j.stars.duel != null ? Number(j.stars.duel).toFixed(1) : null;
            out[n] = { stars: s, rank: j.ranks ? j.ranks.duel : null, isBot: !!j.isBot };
          } catch (e) { out[n] = null; }
        }
        return out;
      }, usernames);
      starsByName = { ...starsByName, ...res };
      const desc = usernames
        .map((n) => `${n} ★${starsByName[n] && starsByName[n].stars ? starsByName[n].stars : '?'}` +
                    `${starsByName[n] && starsByName[n].rank ? ' #' + starsByName[n].rank : ''}` +
                    `${starsByName[n] && starsByName[n].isBot ? ' [Bot]' : ''}`)
        .join('  |  ');
      logMatchEvent(`⭐ 双方星级: ${desc}`);
    } catch (e) {
      logMatchEvent(`⚠️ 星级查询失败: ${e.message.split('\n')[0]}`);
    }
  }

  await page.exposeFunction('bridgeGameStart', (data) => {
    currentGameData = data;
    inGame = true;
    lastUpdateAt = Date.now();
    hopelessStreak = 0;
    surrendering = false;
    growth.clear();
    gs = new GameState();
    strategy = new Strategy(gs);
    gs.start(data);

    const opponent = data.usernames ? data.usernames.filter((_, idx) => idx !== data.playerIndex).join(', ') : '未知对手';
    const replayLink = `https://generals.io/replays/${encodeURIComponent(data.replay_id)}`;
    
    logMatchEvent(`🎮 匹配成功! 开局对战对手: [${opponent}] (我是 index=${data.playerIndex})`);
    logMatchEvent(`🔗 实时对局/回放地址: ${replayLink}`);
    if (data.usernames) fetchStars(data.usernames);

    try {
      exec(`osascript -e 'display notification "对局开局! 对手: ${opponent}" with title "Generals.io v51 匹配成功!" sound name "Glass"'`);
    } catch (e) {}
  });

  await page.exposeFunction('bridgeGameUpdate', async (data) => {
    if (!gs || !strategy) return;
    lastUpdateAt = Date.now();
    gs.update(data);
    updateGrowthStats(gs);

    // 调用 v51 计算下一步算法路线
    const mv = strategy.nextMove();
    if (mv) {
      // 实时向网页端 window.socket 发送移动操作指令
      await page.evaluate(({ from, to, is50 }) => {
        if (window.socket && window.socket.connected) {
          window.socket.emit('attack', from, to, !!is50);
        }
      }, { from: mv.from, to: mv.to, is50: mv.is50 });
    }

    // 每半回合把完整战况写成文本棋盘 + JSON,供外部实时读取
    writeLiveStatus(mv, strategy.queuePurpose);

    if (gs.turn % 20 === 0) {
      const s = gs.myScore();
      const opp = gs.enemyScores()[0];
      const th = nearestThreat(gs);
      console.log(`[v51 bot] turn=${gs.turn} 我 兵力=${s.total} 地块=${s.tiles} | 对手 兵力=${opp ? opp.total : '?'} 地块=${opp ? opp.tiles : '?'} | 威胁=${th ? th.army + '兵@' + th.dist + '格' : '无'}`);
    }

    // 自动投降判定:兵力差达到阈值且持续 6 个 tick(=3 个整回合)才触发。
    // 限定 turn>100 且对手兵力≥50,避免开局基数太小时的比值噪声。
    if (inGame && !surrendering && gs.turn > 100) {
      const meScore = gs.myScore();
      const oppScore = gs.enemyScores()[0];
      const hopeless = oppScore && meScore.total > 0 &&
                       oppScore.total >= 50 &&
                       oppScore.total > SURRENDER_RATIO * meScore.total;
      hopelessStreak = hopeless ? hopelessStreak + 1 : 0;

      if (hopelessStreak >= 6) {
        surrendering = true;
        const ratio = (oppScore.total / meScore.total).toFixed(1);
        logMatchEvent(`🏳️ 自动投降:对手兵力 ${oppScore.total} 已达我方 ${meScore.total} 的 ${ratio} 倍 (阈值 ${SURRENDER_RATIO}x)，止损进入下一局`);
        await page.evaluate(() => {
          if (window.socket && window.socket.connected) {
            window.socket.emit('surrender');
            window.socket.emit('leave_game');
          }
        });
      }
    }

    // 老家告急时主动播报(比看截图早得多)
    const th = nearestThreat(gs);
    if (th && th.dist <= 3 && th.army >= 10 && gs.turn - (lastDangerTurn || -99) > 20) {
      lastDangerTurn = gs.turn;
      console.log(`[v51 bot] ⚠️ 老家告急: 敌 ${th.army} 兵距将 ${th.dist} 格 (turn=${gs.turn})`);
    }
  });

  await page.exposeFunction('bridgeGameWon', async () => {
    inGame = false;
    const replayLink = currentGameData ? `https://generals.io/replays/${encodeURIComponent(currentGameData.replay_id)}` : '';
    logMatchEvent(`🏆 比赛结束 - 本局获得【胜利】! 官方回放地址: ${replayLink}`);
    archiveReplay('WIN');

    try {
      exec(`osascript -e 'display notification "🏆 恭喜! 本局获得胜利! 回放: ${replayLink}" with title "v51 Bot 结果"'`);
    } catch (e) {}

    // 自动连续排队: 稍等3秒后进入下一局匹配。
    // 不要在这里强制重载页面 —— 局间点不动 1v1 的真正原因是服务器把按钮标成了
    // disabled,重载只会重置 socket 让解禁更慢,交给 startQueue 里的等待逻辑处理。
    logMatchEvent(`🔄 正在自动准备下一局 1v1 匹配…`);
    setTimeout(() => startQueue(page), 3000);
  });

  await page.exposeFunction('bridgeGameLost', async () => {
    inGame = false;
    const replayLink = currentGameData ? `https://generals.io/replays/${encodeURIComponent(currentGameData.replay_id)}` : '';
    logMatchEvent(`💀 比赛结束 - 本局【战败】。 官方回放地址: ${replayLink}`);
    archiveReplay('LOSS');

    try {
      exec(`osascript -e 'display notification "💀 本局战败。 回放: ${replayLink}" with title "v51 Bot 结果"'`);
    } catch (e) {}

    // 自动连续排队: 稍等3秒后进入下一局匹配。
    // 不要在这里强制重载页面 —— 局间点不动 1v1 的真正原因是服务器把按钮标成了
    // disabled,重载只会重置 socket 让解禁更慢,交给 startQueue 里的等待逻辑处理。
    logMatchEvent(`🔄 正在自动准备下一局 1v1 匹配…`);
    setTimeout(() => startQueue(page), 3000);
  });

  // 在页面初始化时精准拦截 window.socket。
  // 注意:挂上一次后不能 clearInterval —— socket.io 断线重连会换一个新的 socket
  // 实例,老实例上的 handler 全部失效,表现为「对局中数据流突然静止、投降也没反应」。
  // 因此持续轮询,发现未挂钩的新实例就重新挂。
  await page.addInitScript(() => {
    setInterval(() => {
      const s = window.socket;
      if (s && s.connected && !s._v51Hooked) {
        s._v51Hooked = true;
        console.log('[browser] ✅ 成功精准挂载网页端 window.socket 实例!');
        s.on('game_start', (d) => window.bridgeGameStart(d));
        s.on('game_update', (d) => window.bridgeGameUpdate(d));
        s.on('game_won', () => window.bridgeGameWon());
        s.on('game_lost', () => window.bridgeGameLost());
        s.on('disconnect', (r) => console.log('[browser] ⚠️ socket 断开: ' + r));
      }
    }, 500);
  });

  console.log(`[headless] 正在通过初始链接访问 ${INITIAL_URL} …`);
  await gotoWithRetry(page, INITIAL_URL);
  await page.waitForTimeout(1500);

  // 设置凭据并重新刷新页面
  console.log(`[headless] 注入 localStorage 凭据并跳转回主页面关闭改名弹窗…`);
  await page.evaluate((uid) => {
    localStorage.setItem('user_id', uid);
    localStorage.setItem('email', 'justinzhouwuxi@gmail.com');
  }, USER_ID);
  
  await gotoWithRetry(page, 'https://generals.io/');
  await page.waitForTimeout(2000);
  await page.keyboard.press('Escape');

  logMatchEvent(`✅ 重新刷新主界面完成 (账号: zjxnb, user_id: ${USER_ID})`);
  await startQueue(page);
  startQueueWatchdog(page);
})();

/** 走代理时首次握手常常偏慢,导航失败重试而不是直接崩掉整个进程 */
async function gotoWithRetry(page, url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      return;
    } catch (e) {
      logMatchEvent(`⚠️ 导航失败 (${i}/${tries}) ${url}: ${e.message.split('\n')[0]}`);
      if (i === tries) throw e;
      await page.waitForTimeout(3000);
    }
  }
}

async function startQueue(page) {
  // 互斥:对局结束的「3 秒后重排」与看门狗可能同时触发,两个 page.goto
  // 并发会互相中止(ERR_ABORTED),必须串行。
  if (queueing) {
    logMatchEvent(`⏭️ 已有排队流程在进行中，跳过本次触发`);
    return;
  }
  queueing = true;
  try {
    logMatchEvent(`🔄 正在检查并确保返回主界面排队…`);

    // 先关掉任何残留弹窗(排行榜/设置/对局结算)。排行榜的标签栏同样有 "1v1",
    // 不清掉的话后面会点到它,陷入「每 20 秒点一次排行榜」的死循环。
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 检查是否在主界面，如果不在(或上次排队失败过)，强制跳转至初始链接并刷新
    const isMainMenu = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('*'));
      return !!btns.find(b => b.innerText && b.innerText.trim() === 'PLAY');
    });

    if (!isMainMenu || queueFailures >= 2) {
      if (queueFailures >= 2) logMatchEvent(`🔁 连续 ${queueFailures} 次排队失败，强制重载页面`);
      logMatchEvent(`🌐 页面未在主界面，使用初始链接重新加载刷新…`);
      await gotoWithRetry(page, INITIAL_URL);
      await page.waitForTimeout(1500);
      await page.evaluate((uid) => {
        localStorage.setItem('user_id', uid);
        localStorage.setItem('email', 'justinzhouwuxi@gmail.com');
      }, USER_ID);
      await gotoWithRetry(page, 'https://generals.io/');
      await page.waitForTimeout(2000);
      await page.keyboard.press('Escape');
    }

    logMatchEvent(`🎮 执行网页端点击 (PLAY -> 1v1)…`);

    // 1. 点击主界面 PLAY 按钮。
    //    必须用真实鼠标事件:element.click() 合成事件时灵时不灵,失灵时弹窗不会打开,
    //    后面就只能对着主菜单干等(2026-07-30 上午即因此空转)。
    const playBox = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('*'))
        .filter((b) => b.children.length === 0)
        .find((b) => b.innerText && b.innerText.trim() === 'PLAY' && b.offsetParent !== null);
      if (!el) return null;
      const btn = el.closest('button,a,div') || el;
      const r = btn.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });

    if (playBox) {
      await page.mouse.click(playBox.x, playBox.y);
    } else {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('*'));
        const p = btns.find(b => b.innerText && b.innerText.trim() === 'PLAY');
        if (p) p.click();
      });
    }

    await page.waitForTimeout(1200);

    // 2. 在「模式选择弹窗内」定位 1v1 按钮取中心坐标,再用真实鼠标点击。
    //    两个坑:① 主菜单背景里也有个 "1v1" 战绩标签,不限定范围会点错;
    //           ② 页面只认真实鼠标事件,element.click() 合成事件静默失败。
    const probe = () => page.evaluate(() => {
      // "players active" 只出现在模式选择弹窗里,排行榜弹窗虽然也有 1v1/FFA/2v2 标签但没有它
      const dialog = Array.from(document.querySelectorAll('div'))
        .filter((d) => {
          const t = d.innerText || '';
          return t.includes('FFA') && t.includes('2v2') && t.includes('players active');
        })
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
      if (!dialog) return null;
      const t = Array.from(dialog.querySelectorAll('*'))
        .filter((e) => e.children.length === 0)
        .find((e) => e.innerText && e.innerText.trim() === '1v1' && e.offsetParent !== null);
      if (!t) return { err: 'no-1v1-button' };
      const btn = t.closest('button,a,div') || t;
      const r = btn.getBoundingClientRect();
      if (!r.width || !r.height) return { err: 'zero-size' };
      return {
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
        // 刚打完一局重连后,服务器会在一小段时间内把模式按钮标为 disabled,
        // 这期间点多少次都无效,只能等它自己解禁(重载页面反而会重置 socket 拖更久)。
        disabled: btn.disabled === true || /disabled/i.test(btn.className || ''),
        html: (btn.outerHTML || '').slice(0, 200)
      };
    });

    // 弹窗行数会变(如活动期间多出 Big Team 一行,1v1 从 y=293 挪到 y=355),
    // 所以坐标必须每次现测;按钮 disabled 期间耐心等待,最多 45 秒。
    let box = null;
    let waited = 0;
    for (let i = 0; i < 180; i++) {
      box = await probe();
      if (box && !box.err && !box.disabled) break;
      // 长时间等待只对「按钮被服务器 disabled」有意义;弹窗压根没开就别干等,
      // 早点退出让看门狗重来一轮(否则会静默空转 3 分钟)。
      if ((!box || box.err) && i >= 8) break;
      if (box && box.disabled && i === 0) logMatchEvent(`⏳ 1v1 按钮被服务器置为 disabled，等待解禁…`);
      if (box && box.disabled && i > 0 && i % 30 === 0) logMatchEvent(`⏳ 仍为 disabled，已等待 ${i} 秒…`);
      await page.waitForTimeout(1000);
      waited++;
    }
    if (waited > 0 && box && !box.err && !box.disabled) {
      logMatchEvent(`✅ 按钮已解禁 (等待 ${waited} 秒)`);
    }

    if (!box || box.err) {
      logMatchEvent(`⚠️ 未能定位 1v1 按钮 (${box ? box.err : 'no-dialog'})`);
    } else {
      // 通用遮挡清除:generals.io 会在玩了几局后弹出 "Want to enable Notifications?"
      // 之类的浮层盖住按钮,点击全部落在遮罩上(按钮本身既没 disabled 也没移动)。
      // 这里用 elementFromPoint 判断按钮是否真的可点,被挡就把那层浮层隐藏掉。
      // 注意:绝不去点弹窗里的 "Enable Notifications" —— 那会触发浏览器权限请求。
      const cleared = await page.evaluate(({ x, y }) => {
        const top = document.elementFromPoint(x, y);
        if (!top) return null;
        const label = (top.innerText || '').trim();
        if (label === '1v1') return null;   // 没被挡
        let el = top;
        while (el && el !== document.body) {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          if ((cs.position === 'fixed' || cs.position === 'absolute') && r.width > 300 && r.height > 100) {
            el.style.display = 'none';
            return (el.innerText || '').trim().slice(0, 60);
          }
          el = el.parentElement;
        }
        return null;
      }, { x: box.x, y: box.y });
      if (cleared) logMatchEvent(`🧹 1v1 按钮被浮层遮挡，已隐藏该浮层: "${cleared.replace(/\s+/g, ' ')}"`);

      if (box.disabled) logMatchEvent(`⏳ 等待 180 秒后按钮仍为 disabled，仍尝试点击 (${box.x}, ${box.y})`);
      else logMatchEvent(`🖱️ 定位到 1v1 按钮 (${box.x}, ${box.y})，真实鼠标点击…`);
      await page.mouse.click(box.x, box.y);
      await page.waitForTimeout(2000);

      // 没进队列就再点一次(按钮可能刚好在就绪的临界点上)
      if (!(await isSearching(page))) {
        const again = await probe();
        if (again && !again.err) {
          await page.mouse.click(again.x, again.y);
          await page.waitForTimeout(2000);
        }
        // inGame 也要看:排队后可能瞬间就匹配上了,此时不在队列不代表点击失败
        if (!inGame && !(await isSearching(page)) && box.html) {
          logMatchEvent(`🔍 点击无效，按钮当前 DOM: ${box.html.replace(/\s+/g, ' ')}`);
        }
      }
    }

    if (await isSearching(page)) {
      queueFailures = 0;
      logMatchEvent(`✅ 已成功进入【Finding a match...】1v1 匹配队列！`);
    } else {
      queueFailures++;
      logMatchEvent(`⚠️ 点击后未进入匹配队列 (连续第 ${queueFailures} 次)，看门狗将在 20 秒内重试`);
    }

  } catch (e) {
    logMatchEvent(`⚠️ 排队点击出现异常: ${e.message.split('\n')[0]}`);
  } finally {
    queueing = false;
  }
}

/** 当前是否处于匹配队列中 */
async function isSearching(page) {
  try {
    return await page.evaluate(() => /Finding a match|Waiting for players|正在寻找/.test(document.body.innerText || ''));
  } catch (e) {
    return false;
  }
}

/** 页面三态: searching(排队中) | menu(主菜单) | unknown(过渡/对局画面/加载中) */
async function pageState(page) {
  try {
    return await page.evaluate(() => {
      const t = document.body.innerText || '';
      if (/Finding a match|Waiting for players|正在寻找/.test(t)) return 'searching';
      const hasPlay = Array.from(document.querySelectorAll('*'))
        .some((b) => b.innerText && b.innerText.trim() === 'PLAY');
      return hasPlay ? 'menu' : 'unknown';
    });
  } catch (e) {
    return 'unknown';
  }
}

/** 页面内 socket 是否仍然连着 */
async function socketAlive(page) {
  try {
    return await page.evaluate(() => !!(window.socket && window.socket.connected));
  } catch (e) {
    return false;
  }
}

/**
 * 排队看门狗:每 20 秒复查一次。
 *
 * 关键教训:曾经只做「排队中 / 不在排队」二元判断,结果在「已匹配上但 game_start
 * 还没送达」的过渡窗口里误判为掉线并重载页面,把刚开局的客户端踢掉直接送掉一局。
 * 因此只有确认停在主菜单时才主动排队;处于未知状态(过渡/对局画面)一律不碰,
 * 只有连续 2 分钟都是未知才认为真卡住了。
 */
function startQueueWatchdog(page) {
  let unknownStreak = 0;
  let deadSocketStreak = 0;
  setInterval(async () => {
    if (inGame || queueing) return;

    // 「页面显示排队中 + socket 已断」是个死角:页面文字一直停在
    // Finding a match...,看门狗以为一切正常,实际永远等不到匹配。
    // 连续 3 次(60 秒)检测到 socket 断开就强制重载页面重建连接。
    if (!(await socketAlive(page))) {
      deadSocketStreak++;
      if (deadSocketStreak >= 3) {
        logMatchEvent(`🔌 socket 已断开 ${deadSocketStreak * 20} 秒仍未恢复，强制重载页面重建连接`);
        deadSocketStreak = 0;
        unknownStreak = 0;
        queueFailures = 2;
        await startQueue(page);
      }
      return;
    }
    deadSocketStreak = 0;

    const st = await pageState(page);
    if (st === 'searching') { unknownStreak = 0; return; }

    if (st === 'menu') {
      unknownStreak = 0;
      logMatchEvent(`🐕 看门狗:停在主菜单且不在队列中，重新排队…`);
      await startQueue(page);
      return;
    }

    unknownStreak++;
    if (unknownStreak >= 6) {
      logMatchEvent(`🐕 页面处于未知状态已 ${unknownStreak * 20} 秒，判定卡死，强制重载`);
      unknownStreak = 0;
      queueFailures = 2;
      await startQueue(page);
    }
  }, 20000);
}
