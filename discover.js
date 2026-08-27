'use strict';
/*
 * discover.js — 直接量"找将能力"(随机图版)
 *
 * 为什么要单独测:找不到敌将,tryStrike(斩首)就永远不触发,整局只能发育。
 * 实战第二局 328 个半回合全程没找到对手将军 —— 胜率指标看不出这一点,
 * 必须用直接指标(发现率 / 发现回合中位数)。这是项目里反复吃过亏的教训。
 *
 * 用法: node discover.js --a ./src/strategy_v29.js --b ./src/strategy_v28.js --games 120
 *   同时报告双方各自的找将表现(互为对手,同一批随机图)。
 */

const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const Game = require('./replays/Game');
const { GameState } = require('./src/gamestate');
const { injectView } = require('./arena');
const { generateMap } = require('./mapgen');

const CAP = 800; // 半回合;超过这个还没找到就算没找到

function discoveryGame(mapObj, SA, SB) {
  const game = Game.createFromReplay(mapObj);
  const gsA = new GameState(), gsB = new GameState();
  gsA.start({ playerIndex: 0, replay_id: 'd', usernames: ['A', 'B'], teams: undefined });
  gsB.start({ playerIndex: 1, replay_id: 'd', usernames: ['A', 'B'], teams: undefined });
  const a = new SA(gsA), b = new SB(gsB);
  let foundA = null, foundB = null;
  while (!game.isOver() && game.turn < CAP) {
    injectView(gsA, game, 0); let ma = null; try { ma = a.nextMove(); } catch (e) {}
    injectView(gsB, game, 1); let mb = null; try { mb = b.nextMove(); } catch (e) {}
    if (ma && Number.isInteger(ma.from)) game.inputBuffer[0].push([ma.from, ma.to, !!ma.is50]);
    if (mb && Number.isInteger(mb.from)) game.inputBuffer[1].push([mb.from, mb.to, !!mb.is50]);
    game.update();
    if (foundA === null && gsA.knownGenerals.has(1)) foundA = Math.floor(game.turn / 2);
    if (foundB === null && gsB.knownGenerals.has(0)) foundB = Math.floor(game.turn / 2);
  }
  const aDead = game.deaths.indexOf(game.sockets[0]) >= 0;
  const bDead = game.deaths.indexOf(game.sockets[1]) >= 0;
  return { foundA, foundB, winner: bDead && !aDead ? 0 : (aDead && !bDead ? 1 : -1) };
}

if (require.main === module && process.argv[2] === '--worker') {
  const job = JSON.parse(process.argv[3]);
  const { Strategy: SA } = require(job.a);
  const { Strategy: SB } = require(job.b);
  const out = { fa: [], fb: [], nA: 0, nB: 0, n: 0, winA: 0 };
  for (let i = 0; i < job.games; i++) {
    const m = generateMap(job.seed + i * 7919);
    // 偶数局 A 执先手,奇数局交换,消除出生点偏差
    const r = i % 2 === 0 ? discoveryGame(m, SA, SB) : discoveryGame(m, SB, SA);
    const [fA, fB] = i % 2 === 0 ? [r.foundA, r.foundB] : [r.foundB, r.foundA];
    const aIdx = i % 2 === 0 ? 0 : 1;
    out.n++;
    if (fA !== null) { out.nA++; out.fa.push(fA); }
    if (fB !== null) { out.nB++; out.fb.push(fB); }
    if (r.winner === aIdx) out.winA++;
  }
  process.send(out);
  process.exit(0);
}

function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[(s.length / 2) | 0]; }

async function main() {
  const argv = process.argv.slice(2);
  const opt = { games: 120, seed: 20260727, jobs: Math.max(1, Math.min(os.cpus().length - 1, 6)) };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--a') opt.a = argv[++i];
    else if (argv[i] === '--b') opt.b = argv[++i];
    else if (argv[i] === '--games') opt.games = parseInt(argv[++i], 10);
    else if (argv[i] === '--seed') opt.seed = parseInt(argv[++i], 10);
    else if (argv[i] === '--jobs') opt.jobs = parseInt(argv[++i], 10);
  }
  if (!opt.a || !opt.b) { console.error('用法: node discover.js --a <策略A> --b <策略B> [--games N]'); process.exit(1); }

  const per = Math.ceil(opt.games / opt.jobs);
  const jobs = [];
  for (let k = 0; k < opt.jobs; k++) {
    jobs.push({ a: path.resolve(__dirname, opt.a), b: path.resolve(__dirname, opt.b), games: per, seed: opt.seed + k * 1000003 });
  }

  const agg = { fa: [], fb: [], nA: 0, nB: 0, n: 0, winA: 0 };
  await new Promise((resolve) => {
    let done = 0;
    for (const j of jobs) {
      const ch = fork(__filename, ['--worker', JSON.stringify(j)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let err = '';
      ch.stderr.on('data', (d) => { err += d.toString(); });
      ch.on('message', (m) => {
        agg.fa.push(...m.fa); agg.fb.push(...m.fb);
        agg.nA += m.nA; agg.nB += m.nB; agg.n += m.n; agg.winA += m.winA;
      });
      ch.on('exit', (c) => { if (c !== 0 && err) console.error(err.slice(0, 400)); if (++done === jobs.length) resolve(); });
    }
  });

  const row = (name, found, total, turns) => {
    const rate = total ? (found / total * 100).toFixed(1) : '0.0';
    console.log(`  ${name.padEnd(30)} 找到敌将 ${String(found).padStart(4)}/${total}  = ${rate.padStart(5)}%   发现回合中位数 ${median(turns) ?? '—'}`);
  };
  console.log(`\n找将能力对比(${agg.n} 局随机图,正反手各半,上限 ${CAP / 2} 回合)`);
  row(path.basename(opt.a), agg.nA, agg.n, agg.fa);
  row(path.basename(opt.b), agg.nB, agg.n, agg.fb);
  console.log(`  (顺带:A 对 B 胜率 ${(agg.winA / agg.n * 100).toFixed(1)}%)`);
}

if (require.main === module && process.argv[2] !== '--worker') main();
