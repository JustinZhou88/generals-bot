'use strict';
/*
 * idle_audit.js — 量"按兵不动"的半回合到底有多少、浪费了什么
 *
 * 【用户提出】按兵不动期间,调兵的速度/路径能不能"隐形地"优化?
 * 理论基础是成立的:在自己领地里移动**不消耗兵力**(栈 A → (A-1)+1 = A),
 * 只消耗时间;而空转的半回合,时间本来就是白扔的 —— 所以空转期调兵是真正免费的。
 *
 * 这里先量清楚:
 *   (1) nextMove 返回 null(不出招)的半回合有多少,分布在哪些阶段;
 *   (2) 空转当下,有多少兵是"能动却没动"的(armies>1 的非将军格);
 *   (3) 这些兵离前线(最近敌格/最近己方边界)有多远 —— 决定预置有没有价值。
 *
 * 用法: node idle_audit.js --cand ./src/strategy_v51.js --games 40
 */

const fs = require('fs');
const path = require('path');
const Game = require('./replays/Game');
const { GameState } = require('./src/gamestate');
const { injectView } = require('./arena');

const CORPUS = path.join(__dirname, 'replays', 'corpus');
const CAP = 1500;

const argv = process.argv.slice(2);
const opt = { cand: './src/strategy_v51.js', games: 40, handoff: 100, seed: 1 };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--cand') opt.cand = argv[++i];
  else if (argv[i] === '--games') opt.games = parseInt(argv[++i], 10);
  else if (argv[i] === '--seed') opt.seed = parseInt(argv[++i], 10);
}

const CandMod = require(opt.cand);
const Cand = CandMod.Strategy || CandMod;
const FbMod = require('./src/strategy_v29.js');
const Fallback = FbMod.Strategy || FbMod;

const PHASES = [[0, 24], [24, 50], [50, 100], [100, 200], [200, 400], [400, 1e9]];
const stat = PHASES.map(() => ({ idle: 0, total: 0, idleArmy: 0, idleTiles: 0, farSum: 0, farN: 0 }));

function phaseIdx(halfTurn) {
  for (let i = 0; i < PHASES.length; i++) if (halfTurn >= PHASES[i][0] && halfTurn < PHASES[i][1]) return i;
  return PHASES.length - 1;
}

function play(replay, corpusIdx) {
  const game = Game.createFromReplay(replay);
  const oppP = corpusIdx, myP = 1 - corpusIdx;
  const gsMe = new GameState(), gsOpp = new GameState();
  gsMe.start({ playerIndex: myP, replay_id: 'ia', usernames: ['me', 'corpus'], teams: undefined });
  gsOpp.start({ playerIndex: oppP, replay_id: 'ia', usernames: ['me', 'corpus'], teams: undefined });
  const me = new Cand(gsMe), fb = new Fallback(gsOpp);
  const oppMoves = replay.moves.filter((m) => m.index === oppP).sort((a, b) => a.turn - b.turn);
  let mi = 0;

  while (!game.isOver() && game.turn < CAP) {
    injectView(gsMe, game, myP);
    let mv = null; try { mv = me.nextMove(); } catch (e) {}
    const pi = phaseIdx(game.turn);
    stat[pi].total++;
    if (!mv || !Number.isInteger(mv.from)) {
      stat[pi].idle++;
      // 空转当下:有多少兵能动却没动
      const gen = gsMe.myGeneral();
      let army = 0, tiles = 0;
      const enemy = [];
      for (let t = 0; t < gsMe.size; t++) if (gsMe.isEnemy(t)) enemy.push(t);
      for (let t = 0; t < gsMe.size; t++) {
        if (!gsMe.isMine(t) || t === gen) continue;
        if (gsMe.armies[t] <= 1) continue;
        army += gsMe.armies[t] - 1; tiles++;
        if (enemy.length) {
          let d = Infinity;
          for (const e of enemy) { const dd = gsMe.dist(t, e); if (dd < d) d = dd; }
          stat[pi].farSum += d; stat[pi].farN++;
        }
      }
      stat[pi].idleArmy += army; stat[pi].idleTiles += tiles;
    } else {
      game.inputBuffer[myP].push([mv.from, mv.to, !!mv.is50]);
    }

    if (game.turn < opt.handoff) {
      while (mi < oppMoves.length && oppMoves[mi].turn <= game.turn) {
        const m = oppMoves[mi++];
        game.inputBuffer[oppP].push([m.start, m.end, !!m.is50]);
      }
    } else {
      injectView(gsOpp, game, oppP);
      let ov = null; try { ov = fb.nextMove(); } catch (e) {}
      if (ov && Number.isInteger(ov.from)) game.inputBuffer[oppP].push([ov.from, ov.to, !!ov.is50]);
    }
    game.update();
  }
}

const files = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'pick.json').sort();
let rng = opt.seed;
const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
let played = 0;
for (let i = 0; i < opt.games && files.length; i++) {
  const f = files[Math.floor(rand() * files.length)];
  let rep;
  try { rep = JSON.parse(fs.readFileSync(path.join(CORPUS, f), 'utf8')); } catch (e) { continue; }
  if (!rep.generals || rep.generals.length !== 2) continue;
  try { play(rep, i % 2); played++; } catch (e) {}
}

console.log(`策略 ${opt.cand}   ${played} 局\n`);
console.log(`半回合区间      空转/总数        空转率   空转时闲置兵(均)  闲置格(均)  离最近敌格(均)`);
let ti = 0, tt = 0;
for (let i = 0; i < PHASES.length; i++) {
  const s = stat[i];
  if (!s.total) continue;
  ti += s.idle; tt += s.total;
  const lbl = `ht${PHASES[i][0]}~${PHASES[i][1] === 1e9 ? '∞' : PHASES[i][1]}`;
  console.log(`  ${lbl.padEnd(12)} ${String(s.idle).padStart(6)}/${String(s.total).padEnd(7)} ` +
    `${(s.idle / s.total * 100).toFixed(1).padStart(6)}%   ` +
    `${(s.idle ? s.idleArmy / s.idle : 0).toFixed(1).padStart(10)}   ` +
    `${(s.idle ? s.idleTiles / s.idle : 0).toFixed(1).padStart(8)}   ` +
    `${(s.farN ? s.farSum / s.farN : 0).toFixed(1).padStart(10)}`);
}
console.log(`  ${'合计'.padEnd(12)} ${String(ti).padStart(6)}/${String(tt).padEnd(7)} ${(ti / tt * 100).toFixed(1).padStart(6)}%`);
console.log(`\n  平均每局空转 ${(ti / Math.max(1, played)).toFixed(1)} 个半回合`);
