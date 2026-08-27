'use strict';
/*
 * human_fidelity.js — 造一个"合成真人"当陪练,并检验它到底像不像真人
 *
 * 【用户提出】用高手语料深度学习造一个真人出来。
 *
 * 为什么这是根问题:今天两次翻车(v54 在 siege/corpus/直接对位三个裁判上全正,
 * 真人实战 0-11)都是同一个原因 —— **离线没有真人**。
 * corpus_arena 的对手是"语料开局 + bot 接管",siege_test 的陪练是手写的集兵猎杀型,
 * 两者都不会像真人那样"带兵硬推找到你的将军、发现后持续增兵跟上"。
 *
 * 造假人最难的部分是"怎么知道它像"。今天正好把真人的行为统计量出来了
 * (opp_profile.js / nemesis_audit.js,109 局),可以直接当校准靶子:
 *
 *   真人实测靶子(109 局):
 *     找到对手将军的局占比        59%(63/107)
 *     发现那一格的兵力 中位       25      (>=20 兵占 57%,<=2 兵仅 5%)
 *     整局夺城次数 均值           2.27    (夺城回合中位 t220)
 *     t120 最大野战兵团           ~22
 *     每半回合走子率              0.74~0.81
 *
 * 本脚本:把 ImitationStrategy(纯模仿,无任何规则)当对手,与候选 bot 对打,
 * 测出同一批统计量,和上面的靶子逐项对照。**先证明它像,才有资格当裁判。**
 *
 * 用法: node human_fidelity.js --cand ./src/strategy.js --games 40
 *       PAUSE_BIAS=-2 node human_fidelity.js ...     # 调暂停率
 */

const fs = require('fs');
const path = require('path');
const Game = require('./replays/Game');
const { GameState } = require('./src/gamestate');
const { injectView } = require('./arena');
const { generateMap } = require('./mapgen');

const CAP = 1200;
const argv = process.argv.slice(2);
const opt = { cand: './src/strategy.js', games: 40, seed: 1 };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--cand') opt.cand = argv[++i];
  else if (argv[i] === '--games') opt.games = parseInt(argv[++i], 10);
  else if (argv[i] === '--seed') opt.seed = parseInt(argv[++i], 10);
}

const CandMod = require(opt.cand);
const Cand = CandMod.Strategy || CandMod;
const { ImitationStrategy } = require('./src/imitation3');

// 真人靶子(2026-07-30,109 局实测)
const TARGET = {
  foundRate: 59, foundArmyMed: 25, foundArmyGe20: 57, foundArmyLe2: 5,
  cityCaps: 2.27, field120: 22, moveRate: 0.775,
};

function visibleMask(game, p) {
  const map = game.map, W = map.width, H = map.height;
  const vis = new Uint8Array(W * H);
  for (let t = 0; t < W * H; t++) {
    if (map.tileAt(t) !== p) continue;
    const r = (t / W) | 0, c = t % W;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < H && cc >= 0 && cc < W) vis[rr * W + cc] = 1;
    }
  }
  return vis;
}
function maxField(game, p, citySet) {
  let m = 0; const gen = game.generals[p];
  for (let t = 0; t < game.map.width * game.map.height; t++) {
    if (game.map.tileAt(t) !== p) continue;
    if (t === gen || citySet.has(t)) continue;
    const a = game.map.armyAt(t);
    if (a > m) m = a;
  }
  return m;
}

const stats = [];
let rng = opt.seed;
const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

for (let g = 0; g < opt.games; g++) {
  const mapObj = generateMap(Math.floor(rand() * 1e9));
  let game;
  try { game = Game.createFromReplay(mapObj); } catch (e) { continue; }
  const humanP = g % 2, botP = 1 - humanP;
  const gsH = new GameState(), gsB = new GameState();
  gsH.start({ playerIndex: humanP, replay_id: 'hf', usernames: ['a', 'b'], teams: undefined });
  gsB.start({ playerIndex: botP, replay_id: 'hf', usernames: ['a', 'b'], teams: undefined });
  const human = new ImitationStrategy(gsH);
  const bot = new Cand(gsB);
  const citySet = new Set(mapObj.cities || []);
  const botGen = mapObj.generals[botP];

  let humanMoves = 0, pauses = 0, nulls = 0;
  let found = -1, foundArmy = null, field120 = null, cityCaps = 0;
  const cityOwner = {};
  for (const c of citySet) cityOwner[c] = game.map.tileAt(c);

  while (!game.isOver() && game.turn < CAP) {
    injectView(gsH, game, humanP);
    let hv = null; try { hv = human.nextMove(); } catch (e) {}
    if (hv && Number.isInteger(hv.from)) { game.inputBuffer[humanP].push([hv.from, hv.to, !!hv.is50]); humanMoves++; }
    else if (hv && hv.pause) pauses++;
    else nulls++;

    injectView(gsB, game, botP);
    let bv = null; try { bv = bot.nextMove(); } catch (e) {}
    if (bv && Number.isInteger(bv.from)) game.inputBuffer[botP].push([bv.from, bv.to, !!bv.is50]);

    game.update();
    const rt = Math.floor(game.turn / 2);
    if (found < 0 && game.generals[botP] >= 0 && visibleMask(game, humanP)[botGen]) {
      found = rt;
      // 与 nemesis_audit 同口径:取能看到的、兵最少的那一格
      let bestA = Infinity;
      const W = game.map.width, H = game.map.height;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = ((botGen / W) | 0) + dr, cc = (botGen % W) + dc;
        if (rr < 0 || rr >= H || cc < 0 || cc >= W) continue;
        const t = rr * W + cc;
        if (game.map.tileAt(t) !== humanP) continue;
        const a = game.map.armyAt(t);
        if (a < bestA) bestA = a;
      }
      foundArmy = bestA === Infinity ? null : bestA;
    }
    if (game.turn === 240) field120 = maxField(game, humanP, citySet);
    for (const c of citySet) {
      const now = game.map.tileAt(c);
      if (now !== cityOwner[c]) { if (now === humanP && cityOwner[c] !== humanP) cityCaps++; cityOwner[c] = now; }
    }
  }
  const turns = Math.max(1, Math.floor(game.turn / 2));
  const humanWon = game.deaths.indexOf(game.sockets[humanP]) < 0;
  stats.push({ found, foundArmy, field120, cityCaps, humanWon, turns,
    moveRate: humanMoves / Math.max(1, turns * 2),
    pauseRate: pauses / Math.max(1, turns * 2), nullRate: nulls / Math.max(1, turns * 2) });
}

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[(s.length / 2) | 0]; };
const fa = stats.filter((s) => s.foundArmy !== null).map((s) => s.foundArmy);
const cmp = (label, got, want, tol) => {
  const ok = Math.abs(got - want) <= tol;
  console.log(`  ${label.padEnd(26)} 合成 ${got.toFixed(1).padStart(7)}   真人靶子 ${String(want).padStart(6)}   ${ok ? '✓' : '✗ 差 ' + (got - want).toFixed(1)}`);
};

console.log(`合成真人(纯 ImitationStrategy,无任何规则) vs ${opt.cand}   ${stats.length} 局\n`);
console.log(`【保真度对照】`);
cmp('找到对手将军的局占比 %', stats.filter((s) => s.found >= 0).length / stats.length * 100, TARGET.foundRate, 12);
cmp('发现那格兵力 中位', med(fa), TARGET.foundArmyMed, 10);
cmp('  其中 >=20 兵 %', fa.filter((x) => x >= 20).length / Math.max(1, fa.length) * 100, TARGET.foundArmyGe20, 15);
cmp('  其中 <=2 兵 %', fa.filter((x) => x <= 2).length / Math.max(1, fa.length) * 100, TARGET.foundArmyLe2, 10);
cmp('整局夺城次数 均值', mean(stats.map((s) => s.cityCaps)), TARGET.cityCaps, 1.0);
cmp('t120 最大野战兵团', mean(stats.filter((s) => s.field120 !== null).map((s) => s.field120)), TARGET.field120, 8);
cmp('每半回合走子率', mean(stats.map((s) => s.moveRate)), TARGET.moveRate, 0.12);

console.log(`\n【合成真人自身的行为】`);
console.log(`  主动暂停率 ${(mean(stats.map((s) => s.pauseRate)) * 100).toFixed(1)}%   无候选/未就绪率 ${(mean(stats.map((s) => s.nullRate)) * 100).toFixed(1)}%`);
console.log(`  它对 ${opt.cand} 的胜率 ${(stats.filter((s) => s.humanWon).length / stats.length * 100).toFixed(1)}%   局长中位 ${med(stats.map((s) => s.turns))} 回合`);
console.log(`  (真人对我们是 ~44%(48/109);局长中位 157)`);
