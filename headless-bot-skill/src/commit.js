'use strict';
/*
 * commit.js — 运行时的"此刻该不该出击"局面判断器
 *
 * 训练侧: replays/imitation/commit_extract.js + commit_train.js
 *   标签 = 该玩家在未来 20 个半回合内是否从对手手里夺走 >= 3 块地(可观测的进攻窗口)
 *   语料 1751 局,17.6 万样本;留出集 AUC 0.847 / 准确率 76.8%
 *   对照:bot 原来写死的 phase>=34 规则 AUC 只有 0.551(0.5=抛硬币)
 *
 * 为什么需要它:主力兵团的规模/保护/站位五种改动全部实测失败,共同原因是
 * **出手时机本身是错的** —— 任何固定规则都会在错误的时刻生效。
 *
 * 特征必须与 commit_extract.js 的 stateFeatures 逐位一致,否则线下指标
 * 不代表线上行为(v22 那次 client.js 静默吞掉 is50 的教训)。
 * 训练侧从真实地图重建迷雾视角,运行时 gs 本身就是迷雾视角,两者应当等价。
 */

const fs = require('fs');
const path = require('path');

const MODEL_PATH = path.join(__dirname, '..', 'replays', 'imitation', 'commit_model.json');
const MODEL = fs.existsSync(MODEL_PATH) ? require(MODEL_PATH) : null;

const FEAT = 14;
const clip = (x, lo, hi) => (x < lo ? lo : (x > hi ? hi : x));
const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * 从 GameState 算 14 维局面特征。必须与 commit_extract.js 的 stateFeatures 同式。
 * @returns {number[]|null}
 */
function stateFeatures(gs) {
  const gen = gs.myGeneral();
  if (gen === undefined || gen < 0) return null;
  const W = gs.width, H = gs.height, size = gs.size, normD = W + H;

  // 兵力/地块总量:用计分板(等价于训练侧对真实地图求和,含迷雾中的部分)
  const my = gs.myScore();
  const enemies = gs.enemyScores();
  const opp = enemies[0] || { total: 0, tiles: 0 };
  const myLand = my.tiles, oppLand = opp.tiles;
  const myArmy = my.total, oppArmy = opp.total;

  // 主力(排除将军)、可见敌格与其重心
  let mainStack = 0, mainTile = -1;
  const enemyTiles = [];
  let er = 0, ec = 0;
  for (let t = 0; t < size; t++) {
    if (gs.isMine(t)) {
      if (t !== gen && gs.armies[t] > mainStack) { mainStack = gs.armies[t]; mainTile = t; }
    } else if (gs.isEnemy(t)) {
      enemyTiles.push(t);
      er += gs.row(t); ec += gs.col(t);
    }
  }
  const nVis = enemyTiles.length;
  if (nVis) { er /= nVis; ec /= nVis; }

  let dMain = normD;
  if (mainTile >= 0 && nVis) {
    for (const t of enemyTiles) {
      const d = gs.dist(mainTile, t);
      if (d < dMain) dMain = d;
    }
  }

  let threat = 0;
  for (const t of enemyTiles) {
    if (gs.armies[t] >= 6 && gs.dist(t, gen) <= 5) { threat = 1; break; }
  }

  let myCities = 0, oppCities = 0;
  for (const c of gs.knownCities) {
    if (gs.isMine(c)) myCities++;
    else if (gs.isEnemy(c)) oppCities++;
  }

  let enemyGenKnown = 0;
  for (const [p] of gs.knownGenerals) {
    if (p === gs.playerIndex || gs.isTeammate(p)) continue;
    const s = gs.scores.find((x) => x.i === p);
    if (s && !s.dead) { enemyGenKnown = 1; break; }
  }

  const dGenEnemy = nVis ? (Math.abs(gs.row(gen) - er) + Math.abs(gs.col(gen) - ec)) : normD;

  return [
    r3((gs.turn % 50) / 50),
    r3(clip(gs.turn / 800, 0, 1)),
    r3(myLand / Math.max(1, myLand + oppLand)),
    r3(myArmy / Math.max(1, myArmy + oppArmy)),
    r3(mainStack / Math.max(1, myArmy)),
    r3(Math.log(1 + mainStack) / 5),
    r3(dMain / normD),
    enemyGenKnown,
    threat,
    r3(nVis / size),
    r3(clip(myCities / 5, 0, 1)),
    r3(clip(oppCities / 5, 0, 1)),
    r3(dGenEnemy / normD),
    r3(clip(myArmy / Math.max(1, myLand) / 10, 0, 1)),
  ];
}

/** P(此刻是进攻窗口);模型缺失时返回 null,调用方退回原来的相位规则 */
function commitProb(gs) {
  if (!MODEL) return null;
  const x = stateFeatures(gs);
  if (!x) return null;
  let s = MODEL.b;
  for (let k = 0; k < FEAT; k++) s += MODEL.w[k] * x[k];
  for (let h = 0; h < MODEL.H; h++) {
    let z = MODEL.b1[h];
    const base = h * FEAT;
    for (let k = 0; k < FEAT; k++) z += MODEL.W1[base + k] * x[k];
    s += MODEL.v[h] * Math.tanh(z);
  }
  return 1 / (1 + Math.exp(-s));
}

module.exports = { stateFeatures, commitProb, FEAT, hasModel: !!MODEL };
