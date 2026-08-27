'use strict';
/*
 * stranded_audit.js — 量"聚好的兵被搁在原地"的规模
 *
 * 【用户提出】"一些已经聚集好的兵由于可能有其他判断中间插入,
 * 暂时被抛弃在了某些位置,这或许不利。"
 *
 * 这个现象已有旁证:planPath 会清空 queue(没有续接机制),
 * strike_audit 实测 41/88 次斩首被截断、被 defend 截断的那批只走了 6.5/21.4 步。
 * 但"到底有多少兵、被搁了多久"从没量过。
 *
 * 定义:一个"滞留兵堆" = 我方非将军格,兵力 >= THRESH,
 * 且在过去 WINDOW 个半回合里**兵力没有减少过**(= 没有从这里出过兵;
 * 只增不减说明它只是在被动收农产,没人来用它)。
 *
 * 用法: node stranded_audit.js --cand ./src/strategy_v51.js --games 30
 */

const fs = require('fs');
const path = require('path');
const Game = require('./replays/Game');
const { GameState } = require('./src/gamestate');
const { injectView } = require('./arena');

const CORPUS = path.join(__dirname, 'replays', 'corpus');
const CAP = 1500;
const THRESH = 15;   // 多大算"聚好的兵"
const WINDOW = 30;   // 半回合:连续多久没动过算滞留

const argv = process.argv.slice(2);
const opt = { cand: './src/strategy_v51.js', games: 30, handoff: 100, seed: 1 };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--cand') opt.cand = argv[++i];
  else if (argv[i] === '--games') opt.games = parseInt(argv[++i], 10);
  else if (argv[i] === '--seed') opt.seed = parseInt(argv[++i], 10);
}

const CandMod = require(opt.cand);
const Cand = CandMod.Strategy || CandMod;
const FbMod = require('./src/strategy_v29.js');
const Fallback = FbMod.Strategy || FbMod;

let totSamples = 0, totStrandedTiles = 0, totStrandedArmy = 0, totMyArmy = 0;
const strandedRuns = [];   // 每个滞留兵堆持续了多少半回合

function play(replay, corpusIdx) {
  const game = Game.createFromReplay(replay);
  const oppP = corpusIdx, myP = 1 - corpusIdx;
  const gsMe = new GameState(), gsOpp = new GameState();
  gsMe.start({ playerIndex: myP, replay_id: 'st', usernames: ['me', 'corpus'], teams: undefined });
  gsOpp.start({ playerIndex: oppP, replay_id: 'st', usernames: ['me', 'corpus'], teams: undefined });
  const me = new Cand(gsMe), fb = new Fallback(gsOpp);
  const oppMoves = replay.moves.filter((m) => m.index === oppP).sort((a, b) => a.turn - b.turn);
  let mi = 0;

  const lastDrop = new Map();   // tile -> 最后一次兵力减少的半回合
  const prevArmy = new Map();
  const runStart = new Map();   // tile -> 本次滞留从哪个半回合开始算

  while (!game.isOver() && game.turn < CAP) {
    injectView(gsMe, game, myP);
    let mv = null; try { mv = me.nextMove(); } catch (e) {}
    if (mv && Number.isInteger(mv.from)) game.inputBuffer[myP].push([mv.from, mv.to, !!mv.is50]);

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

    // 只在中后期统计(开局本来就在攒兵,不算滞留)
    if (game.turn < 100) continue;
    const gen = gsMe.myGeneral();
    let stTiles = 0, stArmy = 0, myArmy = 0;
    for (let t = 0; t < gsMe.size; t++) {
      if (!gsMe.isMine(t)) { lastDrop.delete(t); prevArmy.delete(t); runStart.delete(t); continue; }
      const a = gsMe.armies[t];
      myArmy += Math.max(0, a - 1);
      const pa = prevArmy.get(t);
      if (pa !== undefined && a < pa) {
        // 兵力减少 = 从这里出过兵,滞留计时清零
        if (runStart.has(t)) { strandedRuns.push(game.turn - runStart.get(t)); runStart.delete(t); }
        lastDrop.set(t, game.turn);
      }
      prevArmy.set(t, a);
      if (t === gen || gsMe.isCity(t)) continue;
      if (a < THRESH) { runStart.delete(t); continue; }
      const ld = lastDrop.get(t);
      const stillFor = game.turn - (ld === undefined ? 100 : ld);
      if (stillFor >= WINDOW) {
        stTiles++; stArmy += a - 1;
        if (!runStart.has(t)) runStart.set(t, game.turn);
      }
    }
    totSamples++; totStrandedTiles += stTiles; totStrandedArmy += stArmy; totMyArmy += myArmy;
  }
  for (const [t, s] of runStart) strandedRuns.push(game.turn - s);
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

const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[(s.length / 2) | 0]; };
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

console.log(`策略 ${opt.cand}   ${played} 局   (滞留定义: 非将军非城、兵>=${THRESH}、连续 ${WINDOW} 个半回合没出过兵)\n`);
console.log(`  采样时点 ${totSamples} 个(ht>=100)`);
console.log(`  平均每时点滞留兵堆   ${(totStrandedTiles / Math.max(1, totSamples)).toFixed(2)} 个`);
console.log(`  平均每时点滞留兵力   ${(totStrandedArmy / Math.max(1, totSamples)).toFixed(1)}`);
console.log(`  ★ 滞留兵占我方可动兵力 ${(totStrandedArmy / Math.max(1, totMyArmy) * 100).toFixed(1)}%`);
if (strandedRuns.length) {
  console.log(`  滞留时长(半回合)     中位 ${med(strandedRuns)}   均值 ${mean(strandedRuns).toFixed(1)}   p90 ${[...strandedRuns].sort((a, b) => a - b)[(strandedRuns.length * 0.9) | 0]}`);
  console.log(`  滞留事件数           ${strandedRuns.length} 次,${(strandedRuns.length / Math.max(1, played)).toFixed(1)} 次/局`);
}
