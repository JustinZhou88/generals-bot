'use strict';
/*
 * city_gate_audit.js — 逐门统计 tryCaptureCity 到底被哪一道门槛卡住
 *
 * 城市经济是今天拿到三个独立确认的差距(对手 2.27~3.11 vs 我方 1.32~1.48)。
 * `homeseen_audit.js` 已经排除了 `!homeSeen`(只封掉 11% 的机会)。
 * 这里在离线自对弈里用**我方迷雾视角**逐半回合统计每道门的通过/拦截:
 *
 *   门1 已知且中立           gs.knownCities 里、terrain<0
 *   门2 **此刻可见**          gs.isVisible(c)   ← 嫌疑门:真人会记住雾里的塔照样去打
 *   门3 在我这一侧            dist(c,将军) <= dist(c,最近敌格)   (cityDefensible)
 *   门4 兵够吃得下            biggestArmy > armies[c] + dist + 2
 *
 * 用法: node city_gate_audit.js --cand ./src/strategy.js --games 30
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

const G = { samples: 0, known: 0, neutral: 0, visible: 0, myside: 0, affordable: 0,
            neutralInvisible: 0, invisibleButMyside: 0 };

function tally(gs) {
  const gen = gs.myGeneral();
  if (gen === undefined || gen < 0) return;
  G.samples++;
  const enemy = [];
  for (let t = 0; t < gs.size; t++) if (gs.isEnemy(t)) enemy.push(t);
  let big = 0;
  for (let t = 0; t < gs.size; t++) if (gs.isMine(t) && gs.armies[t] > big) big = gs.armies[t];
  for (const c of gs.knownCities) {
    if (gs.isMine(c) || gs.isEnemy(c)) continue;
    G.known++;
    G.neutral++;
    const vis = gs.isVisible(c);
    let dEn = Infinity;
    for (const t of enemy) { const dd = gs.dist(c, t); if (dd < dEn) dEn = dd; }
    const mySide = !enemy.length || gs.dist(c, gen) <= dEn;
    if (vis) G.visible++; else { G.neutralInvisible++; if (mySide) G.invisibleButMyside++; }
    if (!vis) continue;
    if (!mySide) continue;
    G.myside++;
    if (big > gs.armies[c] + gs.dist(gen, c) + 2) G.affordable++;
  }
}

function listCorpus() {
  return fs.readdirSync(CORPUS).filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'pick.json').sort();
}
function play(replay, corpusIdx) {
  const game = Game.createFromReplay(replay);
  const oppP = corpusIdx, myP = 1 - corpusIdx;
  const gsMe = new GameState(), gsOpp = new GameState();
  gsMe.start({ playerIndex: myP, replay_id: 'cg', usernames: ['me', 'corpus'], teams: undefined });
  gsOpp.start({ playerIndex: oppP, replay_id: 'cg', usernames: ['me', 'corpus'], teams: undefined });
  const me = new Cand(gsMe), fb = new Fallback(gsOpp);
  const oppMoves = replay.moves.filter((m) => m.index === oppP).sort((a, b) => a.turn - b.turn);
  let mi = 0;
  while (!game.isOver() && game.turn < CAP) {
    injectView(gsMe, game, myP);
    if (game.turn >= 60 && game.turn % 10 === 0) tally(gsMe);
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
}

const files = listCorpus();
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

const per = (x) => (x / Math.max(1, G.samples)).toFixed(2);
const pct = (x, y) => (x / Math.max(1, y) * 100).toFixed(1) + '%';
console.log(`${opt.cand}   ${played} 局,${G.samples} 个采样时点(ht>=60,每 5 回合一次)\n`);
console.log(`  每时点平均的中立塔候选(逐门过滤):`);
console.log(`    门0 已知且中立            ${per(G.neutral).padStart(6)} 个`);
console.log(`    门2 且**此刻可见**         ${per(G.visible).padStart(6)} 个   通过率 ${pct(G.visible, G.neutral)}`);
console.log(`    门3 且在我这一侧          ${per(G.myside).padStart(6)} 个   通过率 ${pct(G.myside, G.visible)}`);
console.log(`    门4 且兵够吃得下          ${per(G.affordable).padStart(6)} 个   通过率 ${pct(G.affordable, G.myside)}`);
console.log(`\n  ★ 被"此刻不可见"挡掉的中立塔      ${per(G.neutralInvisible).padStart(6)} 个/时点  = ${pct(G.neutralInvisible, G.neutral)} 的已知中立塔`);
console.log(`     其中还在我这一侧(本该能打)     ${per(G.invisibleButMyside).padStart(6)} 个/时点`);
