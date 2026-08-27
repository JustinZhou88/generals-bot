'use strict';

/**
 * 模仿学习排序器策略 v2(线上推理端)。
 *
 * 模型加载:优先 replays/imitation/model2.json(条件 logit,32 维,含"不动"
 * 伪候选);不存在则退回 model.json 的 24 维路径(v1 行为,无伪候选)——向后兼容。
 *
 * 特征逻辑必须与 replays/imitation/FEATURES2.md / extract2.js **完全一致**
 * (f1-f24 与 v1 FEATURES.md / extract.js 一字不动):
 * - 线上视角就是 GameState 本身:terrain/armies 已是含迷雾视图
 *   (-1 空地 / -2 山 / -3 平雾 / -4 雾障)。
 * - "可见" = terrain 非 -3 非 -4(与训练时 own 8 邻域的可见集语义一致)。
 * - f8/f26/f30 的"已知城" = **当前可见**的城(gs.cities,不用 knownCities
 *   记忆,与训练一致)。
 * - 已知敌将(f12/f29)= 记忆(gs.knownGenerals,一旦见过就记住,与训练 mem 一致)。
 * - f20/f23 的兵力总量用计分板(gs.scores[].total = 真实全图兵力和)。
 * - "上一步"(f27/f28)= 实例字段 this.prevMove = {start, end, turn},记
 *   最近一次**返回的真实 move**;返回 {pause} 或 null 不更新。训练侧对应
 *   "该玩家最近一次真实 move,跨半回合追踪,空转不更新"。
 * - 候选:isMine(t) && army[t]>=2,n 为 t 的 4 邻(上、下、左、右顺序),
 *   terrain[n] 非 -2 非 -4;扫描顺序 t 升序;候选集末尾隐含"不动"伪候选
 *   (f25=1,其余 31 维全 0)。
 * - 特征值四舍五入到 3 位小数后打分(与数据集完全同精度)。同分取扫描序
 *   靠前者;伪候选排在末尾,仅**严格**更高分才胜出。
 *
 * nextMove() 返回:
 *   {from, to}    — 真实走子(并更新 this.prevMove);
 *   {pause: true} — 伪候选得分最高,本半回合主动不动(调用方按无 move 处理);
 *   null          — 状态未就绪 / 无合法候选(24 维回退或 PAUSE_OFF 模式)。
 * 环境变量 PAUSE_OFF 非空时忽略伪候选(退化为 v1 式"必走真实最高分")。
 */

const fs = require('fs');
const path = require('path');

const IMIT_DIR = path.join(__dirname, '..', 'replays', 'imitation');
const MODEL2_PATH = path.join(IMIT_DIR, 'model2.json');
const MODEL = fs.existsSync(MODEL2_PATH)
  ? require(MODEL2_PATH)
  : require(path.join(IMIT_DIR, 'model.json'));

const W_VEC = MODEL.w;
const BIAS = MODEL.b || 0;
const FEAT = MODEL.feat || W_VEC.length;
const V2 = FEAT >= 32; // 32 维含伪候选; 24 维走 v1 老路径

function clip(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
function r3(x) { return Math.round(x * 1000) / 1000; }

class ImitationStrategy {
  constructor(gs) {
    this.gs = gs;
    // 最近一次返回的真实 move {start, end, turn};pause/无候选不更新。
    this.prevMove = null;
  }

  /**
   * 枚举全部真实候选并计算 FEAT 维特征(已 3 位小数舍入)。
   * 返回 [{from, to, x}] (扫描顺序), 状态未就绪时返回 null。
   * 伪候选行不在其中(恒为 f25=1 其余 0, 打分时单独处理)。
   */
  candidateFeatures() {
    const gs = this.gs;
    const W = gs.width, H = gs.height, size = gs.size;
    if (!W || !H || !size) return null;
    const me = gs.playerIndex;
    const terr = gs.terrain, army = gs.armies;
    const myGen = gs.generals && gs.generals[me] >= 0 ? gs.generals[me] : -1;
    if (myGen < 0) return null; // 将军已亡/未知,理论不可达
    const normD = W + H;
    const turn = gs.turn;
    const prev = this.prevMove;

    // ---- 每半回合算一次的全局量 ----

    // 可见敌格 + 敌方重心(浮点)
    const enemyTiles = [];
    let erSum = 0, ecSum = 0;
    for (let i = 0; i < size; i++) {
      const v = terr[i];
      if (v >= 0 && v !== me) {
        enemyTiles.push(i);
        erSum += (i / W) | 0;
        ecSum += i % W;
      }
    }
    const hasEnemy = enemyTiles.length > 0;
    const er = hasEnemy ? erSum / enemyTiles.length : 0;
    const ec = hasEnemy ? ecSum / enemyTiles.length : 0;

    // 已知敌将(记忆,与训练 mem.enemyGeneral 同语义)
    let eGen = -1;
    if (gs.knownGenerals) {
      for (const [p, tile] of gs.knownGenerals) {
        if (p !== me) { eGen = tile; break; }
      }
    }

    // 兵力总量(计分板 = 真实全图值)
    let myArmy = 0, allArmy = 0;
    if (gs.scores) {
      for (const s of gs.scores) {
        if (s.dead) continue;
        allArmy += s.total;
        if (s.i === me) myArmy += s.total;
      }
    }
    const f20 = allArmy > 0 ? myArmy / allArmy : 0.5;

    // 当前可见的城(f8/f26/f30 不做记忆,与训练一致)
    const citySet = new Set(gs.cities);

    const gr = (myGen / W) | 0, gc = myGen % W;
    const f13 = (turn % 50) / 50;
    const f14 = (turn % 50) >= 30 ? 1 : 0;
    const f15 = Math.min(turn / 400, 1);
    const vr = er - gr, vc = ec - gc; // f21 方向向量: 我将军 -> 敌重心

    const md = (a, b) => Math.abs(((a / W) | 0) - ((b / W) | 0)) + Math.abs((a % W) - (b % W));
    const distToCentroid = (i) => Math.abs(((i / W) | 0) - er) + Math.abs((i % W) - ec);
    const isFog = (i) => terr[i] === -3 || terr[i] === -4; // 训练中 !visible

    // ---- 候选枚举 + 特征 ----
    const rows = [];

    for (let t = 0; t < size; t++) {
      if (terr[t] !== me || army[t] < 2) continue;
      const tr = (t / W) | 0, tc = t % W;
      const neigh = [];
      if (tr > 0) neigh.push(t - W);
      if (tr < H - 1) neigh.push(t + W);
      if (tc > 0) neigh.push(t - 1);
      if (tc < W - 1) neigh.push(t + 1);

      // f17: src 的 4 邻是否有可见敌格(对该 src 的所有候选相同,先算)
      let f17 = 0;
      for (const q of neigh) {
        if (terr[q] >= 0 && terr[q] !== me) { f17 = 1; break; }
      }

      const srcArmy = army[t];
      const f1 = Math.log(1 + srcArmy) / 5;
      const f2 = t === myGen ? 1 : 0;
      const f9 = md(t, myGen) / normD;
      const f23 = myArmy > 0 ? clip(srcArmy / myArmy, 0, 1) : 0;

      for (const n of neigh) {
        const dTerr = terr[n];
        if (dTerr === -2 || dTerr === -4) continue; // 山 / 雾障 不可走
        const dArmy = army[n]; // 雾=0, 可见=真实(GameState 视图天然如此)
        const nr = (n / W) | 0, nc = n % W;

        const f3 = dTerr === me ? 1 : 0;
        const f4 = dTerr === -1 ? 1 : 0;
        const f5 = dTerr === -3 ? 1 : 0;
        const f6 = (dTerr >= 0 && dTerr !== me) ? 1 : 0;
        const f7 = Math.log(1 + dArmy) / 5;
        const f8 = citySet.has(n) ? 1 : 0;

        let f10 = 1;
        if (hasEnemy) {
          let best = Infinity;
          for (const e of enemyTiles) {
            const d = Math.abs(nr - ((e / W) | 0)) + Math.abs(nc - (e % W));
            if (d < best) best = d;
          }
          f10 = best / normD;
        }

        let f11 = 0;
        if (hasEnemy) {
          const diff = distToCentroid(t) - distToCentroid(n);
          f11 = diff > 1e-9 ? 1 : (diff < -1e-9 ? -1 : 0);
        }

        let f12 = 0;
        if (eGen >= 0) {
          const diff = md(t, eGen) - md(n, eGen);
          f12 = diff > 0 ? 1 : (diff < 0 ? -1 : 0);
        }

        let open = 0;
        {
          const nn = [];
          if (nr > 0) nn.push(n - W);
          if (nr < H - 1) nn.push(n + W);
          if (nc > 0) nn.push(n - 1);
          if (nc < W - 1) nn.push(n + 1);
          for (const q of nn) if (terr[q] === -1 || terr[q] === -3) open++;
        }
        const f16 = open / 4;

        let reveal = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const rr = nr + dr, cc = nc + dc;
            if (rr >= 0 && rr < H && cc >= 0 && cc < W && isFog(rr * W + cc)) reveal++;
          }
        }
        const f18 = reveal / 8;

        const f19 = f6 ? clip((srcArmy - 1 - dArmy) / 50, -1, 1) : 0;

        let f21 = 0;
        if (hasEnemy) {
          const dot = (nr - gr) * vr + (nc - gc) * vc;
          f21 = dot > 0 ? 1 : -1;
        }

        const f22 = (dArmy === 1 && dTerr === me) ? 1 : 0;
        const f24 = md(n, myGen) / normD;

        const x = [f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13, f14, f15,
          f16, f17, f18, f19, f20, f21, f22, f23, f24];

        if (V2) {
          // ---- v2 追加特征 (f25-f32), 与 extract2.js 逐字对应 ----
          const f25 = 0; // 真实步; 伪候选行另行处理
          const f26 = citySet.has(n) ? clip((srcArmy - 1 - dArmy) / 40, -1, 1) : 0;
          const f27 = (prev && t === prev.end && (turn - prev.turn) <= 2) ? 1 : 0;
          const f28 = (prev && t === prev.end && n === prev.start) ? 1 : 0;
          const f29 = f6 ? f12 : 0;
          const f30 = (citySet.has(n) && dTerr >= 0 && dTerr !== me) ? 1 : 0;
          const f31 = (f6 && srcArmy - 1 > dArmy) ? 1 : 0;
          const f32 = f14 * f6;
          x.push(f25, f26, f27, f28, f29, f30, f31, f32);
        }

        rows.push({ from: t, to: n, x: x.map(r3) });
      }
    }

    return rows;
  }

  nextMove() {
    const rows = this.candidateFeatures();
    if (rows === null) return null;

    let bestScore = -Infinity, best = null;
    for (const row of rows) {
      let s = BIAS;
      const x = row.x;
      for (let k = 0; k < FEAT; k++) s += W_VEC[k] * x[k];
      if (s > bestScore) { bestScore = s; best = row; }
    }

    // 伪候选(不动): f25=1 其余全 0 => 得分 = BIAS + w[24]。
    // 排在候选集末尾, 仅严格高于全部真实候选才胜出(与训练排列一致)。
    if (V2 && !process.env.PAUSE_OFF) {
      // PAUSE_BIAS:暂停阈值旋钮(负=少暂停)。语料真实空转率仅 5.8%,
      // 原始 argmax 在自对弈约 40% 暂停偏多,用它校准,无需重训。
      const pauseScore = BIAS + W_VEC[24] + (process.env.PAUSE_BIAS !== undefined ? +process.env.PAUSE_BIAS : 0);
      if (pauseScore > bestScore) return { pause: true };
    }

    if (!best) return null;
    this.prevMove = { start: best.from, end: best.to, turn: this.gs.turn };
    return { from: best.from, to: best.to };
  }
}

module.exports = { ImitationStrategy };
