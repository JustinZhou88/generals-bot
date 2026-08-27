'use strict';
/*
 * city_gather_audit.js — 打塔的攒兵到底攒不攒得成?
 *
 * `city_gate_audit.js` 已定位瓶颈在门4(兵够吃得下),通过率只有 5.7%。
 * 而 `tryCaptureCity` 的第二分支本来就有攒兵逻辑:
 *   塔在 6 格内 && armies[src] > armies[c]*0.5  →  gatherToward(src)
 *
 * 问题是它攒不攒得成。记忆里有一条旁证([[siege-metric-and-failed-fixes]]):
 * "兵刚并进主力,立刻被 raid/harass/scout/模型走子按 biggestArmyTile 取走花掉"。
 * 如果这里也是同一个病,那 big/need 这个比值会长期卡在 0.5~1.0 之间上不去。
 *
 * 量法:每半回合找"最容易吃的合格中立塔",算 ratio = 我方最大兵堆 / 需要的兵,
 * 记录每局这个 ratio 的峰值、以及停留在各区间的时长。
 *
 * 用法: node city_gather_audit.js --cand ./src/strategy.js --games 30
 */

const fs = require('fs');
const path = require('path');
const Game = require('./replays/Game');
const { GameState } = require('./src/gamestate');
const { injectView } = require('./arena');

const CORPUS = path.join(__dirname, 'replays', 'corpus');
const CAP = 1500;
const argv = process.argv.slice(2);
const opt = { cand: './src/strategy.js', games: 30, handoff: 100, seed: 1 };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--cand') opt.cand = argv[++i];
  else if (argv[i] === '--games') opt.games = parseInt(argv[++i], 10);
  else if (argv[i] === '--seed') opt.seed = parseInt(argv[++i], 10);
}
const CandMod = require(opt.cand);
const Cand = CandMod.Strategy || CandMod;
const FbMod = require('./src/strategy_v29.js');
const Fallback = FbMod.Strategy || FbMod;

const bands = { '<0.3': 0, '0.3~0.5': 0, '0.5~0.8': 0, '0.8~1.0': 0, '>=1.0': 0 };
const peaks = [];
let noCity = 0, samples = 0;

function probe(gs) {
  const gen = gs.myGeneral();
  if (gen === undefined || gen < 0) return null;
  const enemy = [];
  for (let t = 0; t < gs.size; t++) if (gs.isEnemy(t)) enemy.push(t);
  let big = 0;
  for (let t = 0; t < gs.size; t++) if (gs.isMine(t) && gs.armies[t] > big) big = gs.armies[t];
  let best = null;
  for (const c of gs.knownCities) {
    if (gs.isMine(c) || gs.isEnemy(c) || !gs.isVisible(c)) continue;
    let dEn = Infinity;
    for (const t of enemy) { const dd = gs.dist(c, t); if (dd < dEn) dEn = dd; }
    if (enemy.length && gs.dist(c, gen) > dEn) continue;      // cityDefensible
    const need = gs.armies[c] + gs.dist(gen, c) + 2;
    const ratio = big / Math.max(1, need);
    if (!best || ratio > best.ratio) best = { ratio, need, big };
  }
  return best;
}

function play(replay, corpusIdx) {
  const game = Game.createFromReplay(replay);
  const oppP = corpusIdx, myP = 1 - corpusIdx;
  const gsMe = new GameState(), gsOpp = new GameState();
  gsMe.start({ playerIndex: myP, replay_id: 'cga', usernames: ['me', 'corpus'], teams: undefined });
  gsOpp.start({ playerIndex: oppP, replay_id: 'cga', usernames: ['me', 'corpus'], teams: undefined });
  const me = new Cand(gsMe), fb = new Fallback(gsOpp);
  const oppMoves = replay.moves.filter((m) => m.index === oppP).sort((a, b) => a.turn - b.turn);
  let mi = 0, peak = 0;
  while (!game.isOver() && game.turn < CAP) {
    injectView(gsMe, game, myP);
    if (game.turn >= 60) {
      samples++;
      const b = probe(gsMe);
      if (!b) noCity++;
      else {
        if (b.ratio > peak) peak = b.ratio;
        const r = b.ratio;
        if (r < 0.3) bands['<0.3']++;
        else if (r < 0.5) bands['0.3~0.5']++;
        else if (r < 0.8) bands['0.5~0.8']++;
        else if (r < 1.0) bands['0.8~1.0']++;
        else bands['>=1.0']++;
      }
    }
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
  }
  peaks.push(peak);
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
const tot = Object.values(bands).reduce((a, b) => a + b, 0);
console.log(`${opt.cand}   ${played} 局,${samples} 个采样半回合(ht>=60)\n`);
console.log(`  没有任何合格中立塔的时点  ${(noCity / Math.max(1, samples) * 100).toFixed(1)}%`);
console.log(`\n  有塔时,ratio = 我方最大兵堆 / 吃塔所需 的分布:`);
for (const [k, v] of Object.entries(bands)) {
  console.log(`    ${k.padEnd(9)} ${(v / Math.max(1, tot) * 100).toFixed(1).padStart(5)}%`);
}
console.log(`\n  ★ 每局 ratio 峰值  中位 ${med(peaks).toFixed(2)}   均值 ${mean(peaks).toFixed(2)}`);
console.log(`     峰值就没到过 1.0 的局  ${peaks.filter((p) => p < 1).length}/${peaks.length} = ${(peaks.filter((p) => p < 1).length / Math.max(1, peaks.length) * 100).toFixed(0)}%`);
console.log(`     峰值卡在 0.5~1.0(攒了但没攒够) ${peaks.filter((p) => p >= 0.5 && p < 1).length}/${peaks.length}`);
