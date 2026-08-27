'use strict';
/*
 * ladder.js — 离线全代际擂台(候选 vs 所有前代)
 *
 * 前提(已由 conformance.js 证明):离线模拟器与官方服务器逐帧一致,
 * 且 mapgen.js 产出与真实语料同分布的随机地图 —— 所以离线胜率
 * 就是官方胜率的无偏估计,只是快了几千倍。
 *
 * 判定标准(对应"每一代必须比前面任何一代都强"):
 *   对每个前代对手跑 N 局(每张随机图正反手各一局),算胜率的
 *   Wilson 95% 置信区间下界。下界 > 50% 才算"显著强于该对手"。
 *   全部前代都显著强(或至少无一显著弱)才算这一代合格。
 *
 * 用法:
 *   node ladder.js --cand ./src/strategy_v28.js --vs 1-27 --games 40
 *   node ladder.js --cand ./src/strategy_v28.js --vs 24,25,26,27 --games 100
 *   node ladder.js --worker <json>        # 内部使用
 */

const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const Game = require('./replays/Game');
const { GameState } = require('./src/gamestate');
const { injectView } = require('./arena');
const { generateMap } = require('./mapgen');

const CAP = 3000; // 半回合上限(官方对局实测 300~1500,3000 足够收敛)

// ---------- 单局 ----------
function playGame(mapObj, StratA, StratB, cap) {
  const game = Game.createFromReplay(mapObj);
  const gsA = new GameState(), gsB = new GameState();
  gsA.start({ playerIndex: 0, replay_id: 'ladder', usernames: ['A', 'B'], teams: undefined });
  gsB.start({ playerIndex: 1, replay_id: 'ladder', usernames: ['A', 'B'], teams: undefined });
  const botA = new StratA(gsA), botB = new StratB(gsB);

  while (!game.isOver() && game.turn < cap) {
    for (const [p, gs, bot] of [[0, gsA, botA], [1, gsB, botB]]) {
      injectView(gs, game, p);
      let mv = null;
      try { mv = bot.nextMove(); } catch (e) { mv = null; }
      if (mv && Number.isInteger(mv.from) && Number.isInteger(mv.to)) {
        game.inputBuffer[p].push([mv.from, mv.to, !!mv.is50]);
      }
    }
    game.update();
  }

  const aDead = game.deaths.indexOf(game.sockets[0]) >= 0;
  const bDead = game.deaths.indexOf(game.sockets[1]) >= 0;
  if (bDead && !aDead) return { winner: 0, decisive: true, turns: game.turn };
  if (aDead && !bDead) return { winner: 1, decisive: true, turns: game.turn };
  // 未分胜负(达到上限):按地块判,单独统计
  const sa = game.scores.find((s) => s.i === 0), sb = game.scores.find((s) => s.i === 1);
  const winner = sa.tiles === sb.tiles ? -1 : (sa.tiles > sb.tiles ? 0 : 1);
  return { winner, decisive: false, turns: game.turn };
}

// ---------- Wilson 95% 置信区间 ----------
function wilson(wins, n) {
  if (!n) return { lo: 0, hi: 1, p: 0 };
  const z = 1.959964;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { p, lo: (c - s) / d, hi: (c + s) / d };
}

// ---------- worker:跑一个对手的全部对局 ----------
// 注意必须同时判断 require.main:否则被 roundrobin.js(它自己也用 --worker)
// require 进来时会误触发,拿着别人的 job 结构去 require(undefined)。
if (require.main === module && process.argv[2] === '--worker') {
  const job = JSON.parse(process.argv[3]);
  const { Strategy: SA } = require(job.cand);
  const { Strategy: SB } = require(job.opp);
  let candWins = 0, oppWins = 0, draws = 0, indecisive = 0, turnsSum = 0, n = 0;
  for (let i = 0; i < job.games; i++) {
    const mapObj = generateMap(job.seed + i * 7919);
    // 偶数局候选执先手(index0),奇数局执后手 —— 消除出生点偏差
    const candFirst = i % 2 === 0;
    const r = candFirst
      ? playGame(mapObj, SA, SB, CAP)
      : playGame(mapObj, SB, SA, CAP);
    const candIdx = candFirst ? 0 : 1;
    if (r.winner === candIdx) candWins++;
    else if (r.winner === -1) draws++;
    else oppWins++;
    if (!r.decisive) indecisive++;
    turnsSum += r.turns; n++;
  }
  process.send({ opp: job.opp, candWins, oppWins, draws, indecisive, avgTurns: turnsSum / n, games: n });
  process.exit(0);
}

// ---------- 主程序 ----------
function parseVersions(spec) {
  const out = [];
  for (const part of spec.split(',')) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) { for (let i = +m[1]; i <= +m[2]; i++) out.push(i); }
    else out.push(parseInt(part, 10));
  }
  return out.filter((x) => Number.isInteger(x));
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = { games: 40, seed: 90210, vs: '1-27', jobs: Math.max(1, Math.min(os.cpus().length - 1, 8)) };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cand') opt.cand = argv[++i];
    else if (argv[i] === '--vs') opt.vs = argv[++i];
    else if (argv[i] === '--games') opt.games = parseInt(argv[++i], 10);
    else if (argv[i] === '--seed') opt.seed = parseInt(argv[++i], 10);
    else if (argv[i] === '--jobs') opt.jobs = parseInt(argv[++i], 10);
  }
  if (!opt.cand) { console.error('必须指定 --cand <策略文件>'); process.exit(1); }

  const versions = parseVersions(opt.vs);
  const jobs = versions.map((v) => ({
    cand: path.resolve(__dirname, opt.cand),
    opp: path.resolve(__dirname, `./src/strategy_v${v}.js`),
    label: `v${v}`,
    games: opt.games,
    seed: opt.seed,
  }));

  console.log(`擂台: ${opt.cand}  vs  ${versions.length} 个前代版本,每个 ${opt.games} 局(随机图,正反手各半)`);
  console.log(`并行 ${opt.jobs} 进程,单局上限 ${CAP} 半回合\n`);

  const t0 = Date.now();
  const results = [];
  let idx = 0, running = 0;

  await new Promise((resolve) => {
    function launch() {
      while (running < opt.jobs && idx < jobs.length) {
        const job = jobs[idx++];
        running++;
        const child = fork(__filename, ['--worker', JSON.stringify(job)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        let errBuf = '';
        child.stderr.on('data', (d) => { errBuf += d.toString(); });
        child.on('message', (m) => {
          const w = wilson(m.candWins, m.candWins + m.oppWins + m.draws);
          results.push({ label: job.label, ...m, ...w });
          const flag = w.lo > 0.5 ? '✅显著强' : (w.hi < 0.5 ? '❌显著弱' : '〰️无显著差异');
          console.log(`  ${job.label.padEnd(5)} 候选 ${String(m.candWins).padStart(3)} - ${String(m.oppWins).padEnd(3)} ` +
            `胜率 ${(w.p * 100).toFixed(1)}%  95%CI[${(w.lo * 100).toFixed(1)}, ${(w.hi * 100).toFixed(1)}]  ${flag}` +
            `${m.indecisive ? `  (${m.indecisive} 局未分胜负)` : ''}`);
        });
        child.on('exit', (code) => {
          if (code !== 0 && errBuf) console.error(`  ${job.label} 子进程异常: ${errBuf.slice(0, 400)}`);
          running--;
          if (idx >= jobs.length && running === 0) resolve();
          else launch();
        });
      }
    }
    launch();
  });

  results.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const totW = results.reduce((s, r) => s + r.candWins, 0);
  const totL = results.reduce((s, r) => s + r.oppWins, 0);
  const totD = results.reduce((s, r) => s + r.draws, 0);
  const overall = wilson(totW, totW + totL + totD);
  const weaker = results.filter((r) => r.hi < 0.5);
  const notStronger = results.filter((r) => r.lo <= 0.5);

  console.log(`\n================ 擂台总结 ================`);
  console.log(`总战绩: ${totW} 胜 - ${totL} 负 - ${totD} 平   总胜率 ${(overall.p * 100).toFixed(1)}%  95%CI[${(overall.lo * 100).toFixed(1)}, ${(overall.hi * 100).toFixed(1)}]`);
  console.log(`显著强于: ${results.length - notStronger.length}/${results.length} 个前代`);
  if (weaker.length) console.log(`⚠️ 显著弱于: ${weaker.map((r) => `${r.label}(${(r.p * 100).toFixed(0)}%)`).join(', ')}`);
  else console.log(`✅ 没有任何一个前代显著强于候选`);
  if (notStronger.length) console.log(`   未能显著胜过(但也不弱): ${notStronger.filter(r=>r.hi>=0.5).map((r) => `${r.label}(${(r.p * 100).toFixed(0)}%)`).join(', ') || '无'}`);
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (require.main === module && process.argv[2] !== '--worker') main();
module.exports = { playGame, wilson };
