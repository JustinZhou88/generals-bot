'use strict';
/*
 * belief.js — 敌将位置的后验信念,以及"每步能消掉多少概率质量"的侦察目标选择。
 *
 * 为什么要这个:作弊实验测出"找将"值 +27.1pp 存活率(51.5% → 78.6%),
 * 转化系数约为"每 +10pp 找将率 ≈ +6pp 胜率"。但三次启发式改法
 * (未见格加权 v37 / 约束传播 v38 / 专职小队 v39)每次只值 +2~3pp,
 * 因为它们都在回答"往哪个方向走",而不是"哪一步能排除掉最多可能性"。
 *
 * 这里改成维护真正的位置后验:
 *   先验   —— 用 1804 局语料实测的双将曼哈顿距离分布(d=15 起,d=15~16 占 25.5%,
 *              到 d=21 累计 71.5%)。bot 此前完全没用过这个信息。
 *   硬证据 —— 敌将不会移动,凡是**曾经看见过**的格子概率归零(everSeen);
 *              已知的山和城也归零。
 *   软证据 —— 对手的领地是从他将军长出来的,所以离已见敌格越近的未见格越可能。
 *
 * 目标选择 —— 不再是"最深"或"最近",而是**单位步数能观测到的概率质量最大**:
 *   score(t) = (站到 t 上能新看见的格子的概率和) / (走到 t 的步数 + 1)
 * 这是信息增益率,直接对应"最快把不确定性消掉"。
 */

const path = require('path');
const PROFILE = require(path.join(__dirname, '..', 'replays', 'map_profile.json'));

// 双将距离的经验先验(归一化);语料最小 15、最大 37
const DIST_PRIOR = (() => {
  const raw = PROFILE.genDist || {};
  let total = 0;
  for (const k in raw) total += raw[k];
  const arr = new Float64Array(200);
  for (const k in raw) arr[+k] = raw[k] / total;
  return arr;
})();

class GeneralBelief {
  constructor() {
    this.bel = null;
    this.size = -1;
  }

  /** 每半回合调用:更新后验 */
  update(gs) {
    const gen = gs.myGeneral();
    if (gen === undefined || gen < 0) return;

    if (!this.bel || this.size !== gs.size) {
      this.size = gs.size;
      this.bel = new Float64Array(gs.size);
      for (let t = 0; t < gs.size; t++) {
        const d = gs.dist(t, gen);
        this.bel[t] = d < DIST_PRIOR.length ? DIST_PRIOR[d] : 0;
      }
    }

    // 硬证据:看过的格子、已知的山与城,概率归零(敌将不动 ⇒ 看过没有就永远没有)
    for (let t = 0; t < gs.size; t++) {
      if (this.bel[t] === 0) continue;
      if (!gs.isUnseen(t)) { this.bel[t] = 0; continue; }
      if (gs.discoveredMountains.has(t) || gs.knownCities.has(t)) this.bel[t] = 0;
    }

    let sum = 0;
    for (let t = 0; t < gs.size; t++) sum += this.bel[t];
    if (sum <= 0) { // 后验塌缩(理论上不该发生):退回均匀分布在未见格上
      for (let t = 0; t < gs.size; t++) this.bel[t] = gs.isUnseen(t) && gs.isPassable(t) ? 1 : 0;
      sum = 0;
      for (let t = 0; t < gs.size; t++) sum += this.bel[t];
      if (sum <= 0) return;
    }
    for (let t = 0; t < gs.size; t++) this.bel[t] /= sum;
  }

  /**
   * 选侦察目标:最大化"单位步数观测到的概率质量"。
   * @param {object} gs
   * @param {Float64Array|number[]} dist  从侦察部队出发的步数(Infinity 表示不可达)
   * @param {number} beta  软证据强度:离已见敌格越近越可能(0 = 关闭)
   * @returns {number} 目标格,-1 表示无解
   */
  bestTarget(gs, dist, dfEnemy, beta) {
    if (!this.bel) return -1;
    const W = gs.width, H = gs.height;
    // 软证据加权后的有效概率
    const eff = new Float64Array(gs.size);
    for (let t = 0; t < gs.size; t++) {
      if (this.bel[t] <= 0) continue;
      const near = (dfEnemy && dfEnemy[t] >= 0) ? dfEnemy[t] : 25;
      eff[t] = this.bel[t] / (1 + beta * near);
    }

    let best = -1, bestScore = 0;
    for (let t = 0; t < gs.size; t++) {
      const d = dist[t];
      if (d === Infinity || d === undefined) continue;
      // 站到 t 上能新看见的格子 = t 的 8 邻域(含自身)里还没看过的
      let gain = 0;
      const r = (t / W) | 0, c = t % W;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || rr >= H || cc < 0 || cc >= W) continue;
          const n = rr * W + cc;
          if (gs.isUnseen(n)) gain += eff[n];
        }
      }
      if (gain <= 0) continue;
      const score = gain / (d + 1); // 信息增益率
      if (score > bestScore) { bestScore = score; best = t; }
    }
    return best;
  }

  /** 后验熵(nats):用来观察不确定性有没有真的在降 */
  entropy() {
    if (!this.bel) return 0;
    let h = 0;
    for (let i = 0; i < this.bel.length; i++) {
      const p = this.bel[i];
      if (p > 0) h -= p * Math.log(p);
    }
    return h;
  }
}

module.exports = { GeneralBelief, DIST_PRIOR };
