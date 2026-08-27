'use strict';
/*
 * corpus_arena.js — 语料驱动的多样化对手(解决"验证集过窄/过拟合")
 *
 * 用户的批评是对的:此前的验证集只有 Among 一个强敌 + 用户本人,
 * 照着它优化就是过拟合到少数几个人的打法。
 *
 * 这里用你给的 1845 局真实语料(6 个不同玩家)当对手来源:
 *   - 地图直接用真实对局的地图;
 *   - 对手在前 HANDOFF 个半回合**回放真实玩家的招法**(开局阶段双方基本互不干扰,
 *     所以回放是有效的;非法招法直接跳过);
 *   - 之后交给一个 bot 策略接管,保证对局能打完。
 *
 * 这样一次就能拿到 6 种风格、上千种真实开局当对手,比任何单一陪练都宽。
 *
 * 用法: node corpus_arena.js --cand ./src/strategy_v51.js --games 300 [--handoff 100]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const Game = require('./replays/Game');
const { GameState } = require('./src/gamestate');
const { injectView } = require('./arena');

const CORPUS = path.join(__dirname, 'replays', 'corpus');
const CAP = 1500;

function listCorpus() {
  return fs.readdirSync(CORPUS)
    .filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'pick.json')
    .sort();
}

/**
 * 一局:候选 bot vs "语料开局 + bot 接管"的对手。
 * @param replay 语料对局(提供地图与对手招法)
 * @param corpusIdx 对手在该回放里的玩家下标(我们打另一边)
 */
function play(replay, corpusIdx, Cand, Fallback, handoff) {
  const game = Game.createFromReplay(replay);
  const oppP = corpusIdx, myP = 1 - corpusIdx;
  const gsMe = new GameState(), gsOpp = new GameState();
  gsMe.start({ playerIndex: myP, replay_id: 'ca', usernames: ['me', 'corpus'], teams: undefined });
  gsOpp.start({ playerIndex: oppP, replay_id: 'ca', usernames: ['me', 'corpus'], teams: undefined });
  const me = new Cand(gsMe), fallback = new Fallback(gsOpp);

  // 对手的真实招法队列(只取它自己的)
  const oppMoves = replay.moves.filter((m) => m.index === oppP).sort((a, b) => a.turn - b.turn);
  let mi = 0;

  while (!game.isOver() && game.turn < CAP) {
    injectView(gsMe, game, myP);
    let mv = null; try { mv = me.nextMove(); } catch (e) {}
    if (mv && Number.isInteger(mv.from)) game.inputBuffer[myP].push([mv.from, mv.to, !!mv.is50]);

    if (game.turn < handoff) {
      // 回放对手的真实招法(该半回合的所有招)
      while (mi < oppMoves.length && oppMoves[mi].turn <= game.turn) {
        const m = oppMoves[mi++];
        game.inputBuffer[oppP].push([m.start, m.end, m.is50]);
      }
    } else {
      injectView(gsOpp, game, oppP);
      let om = null; try { om = fallback.nextMove(); } catch (e) {}
      if (om && Number.isInteger(om.from)) game.inputBuffer[oppP].push([om.from, om.to, !!om.is50]);
    }
    game.update();
  }
  const meDead = game.deaths.indexOf(game.sockets[myP]) >= 0;
  const oppDead = game.deaths.indexOf(game.sockets[oppP]) >= 0;
  let win;
  if (oppDead && !meDead) win = 1;
  else if (meDead && !oppDead) win = 0;
  else {
    const a = game.scores.find((s) => s.i === myP), b = game.scores.find((s) => s.i === oppP);
    win = a.tiles === b.tiles ? 0.5 : (a.tiles > b.tiles ? 1 : 0);
  }
  return { win, turns: game.turn };
}

if (require.main === module && process.argv[2] === '--worker') {
  const job = JSON.parse(process.argv[3]);
  const { Strategy: Cand } = require(job.cand);
  const { Strategy: Fallback } = require(job.fallback);
  const files = job.files;
  let w = 0, n = 0, dec = 0;
  for (const f of files) {
    let r;
    try { r = JSON.parse(fs.readFileSync(path.join(CORPUS, f))); } catch (e) { continue; }
    if (!r.mapWidth || !r.generals || r.generals.length !== 2) continue;
    for (const idx of [0, 1]) { // 两侧各打一次,消除出生点偏差
      let res;
      try { res = play(r, idx, Cand, Fallback, job.handoff); } catch (e) { continue; }
      w += res.win; n++;
      if (res.win === 0 || res.win === 1) dec++;
    }
  }
  process.send({ w, n, dec });
  process.exit(0);
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = { games: 200, handoff: 100, jobs: Math.max(1, Math.min(os.cpus().length - 1, 6)),
    fallback: './src/sparring.js' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cand') opt.cand = argv[++i];
    else if (argv[i] === '--games') opt.games = parseInt(argv[++i], 10);
    else if (argv[i] === '--handoff') opt.handoff = parseInt(argv[++i], 10);
    else if (argv[i] === '--jobs') opt.jobs = parseInt(argv[++i], 10);
    else if (argv[i] === '--fallback') opt.fallback = argv[++i];
  }
  if (!opt.cand) { console.error('用法: node corpus_arena.js --cand <策略> [--games N] [--handoff 半回合]'); process.exit(1); }

  const all = listCorpus().slice(0, opt.games);
  const per = Math.ceil(all.length / opt.jobs);
  const agg = { w: 0, n: 0, dec: 0 };
  const t0 = Date.now();
  await new Promise((resolve) => {
    let done = 0;
    for (let k = 0; k < opt.jobs; k++) {
      const files = all.slice(k * per, (k + 1) * per);
      if (!files.length) { if (++done === opt.jobs) resolve(); continue; }
      const job = { cand: path.resolve(__dirname, opt.cand), fallback: path.resolve(__dirname, opt.fallback), files, handoff: opt.handoff };
      const ch = fork(__filename, ['--worker', JSON.stringify(job)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let err = '';
      ch.stderr.on('data', (d) => { err += d.toString(); });
      ch.on('message', (m) => { agg.w += m.w; agg.n += m.n; agg.dec += m.dec; });
      ch.on('exit', (c) => { if (c !== 0 && err) console.error(err.slice(0, 400)); if (++done === opt.jobs) resolve(); });
    }
  });
  const z = 1.959964, p = agg.w / agg.n, d = 1 + z * z / agg.n;
  const c = p + z * z / (2 * agg.n), sd = z * Math.sqrt(p * (1 - p) / agg.n + z * z / (4 * agg.n * agg.n));
  console.log(`\n语料驱动擂台: ${path.basename(opt.cand)}  vs  真实开局(前 ${opt.handoff} 半回合回放) + ${path.basename(opt.fallback)} 接管`);
  console.log(`  ${agg.n} 局(${all.length} 张真实地图 × 双向)   胜率 ${(p * 100).toFixed(2)}%  95%CI[${((c - sd) / d * 100).toFixed(2)}, ${((c + sd) / d * 100).toFixed(2)}]`);
  console.log(`  分出胜负 ${agg.dec}/${agg.n}   耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (require.main === module && process.argv[2] !== '--worker') main();
