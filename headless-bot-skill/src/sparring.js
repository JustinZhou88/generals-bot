'use strict';
/*
 * sparring.js — "集兵围攻"陪练对手(Sieger)
 *
 * 为什么需要它:离线擂台里所有 bot 都是散兵游勇打法,没有任何一个会像真人那样
 * 把兵捏成一坨推过来。所以"抗真人重拳"这项能力在擂台上根本不扣分 —— 这正是
 * v28 在擂台上赢遍 27 个前代、却被用户 5 局赢 4 局的原因。
 *
 * 建模依据(protodump_live 实录):用户在第 1 局 ht156 已有 56 兵团,
 * ht238~247 稳定维持 82~86 兵团推到 bot 家门口;bot 总兵 220+ 却全摊在 82 块地上,
 * 凑不出任何东西来挡,眼看着地块从 82 掉到 71 然后被斩。
 *
 * 设计原则:
 *   1. **不作弊** —— 敌将位置必须自己侦察出来(继承 v29 的 tryScout)。
 *      记忆里的教训:让陪练从第 0 回合就知道敌将位置,是没有任何真人能达到的
 *      最坏情况,拿它调参会把防守调进死胡同(v3 那次 5 个防守改动全部实测更差)。
 *   2. 经济/开局/侦察全部复用 v29,只替换中盘行为 —— 这样它是个**合格的对手**,
 *      而不是一个只会冲锋的沙包,测出来的"抗压能力"才有意义。
 *   3. 中盘只做两件事:把兵聚成一坨(SIEGE_MIN);够了就沿最短路推向敌将。
 *
 * 用法:当普通策略用即可,例如
 *   node ladder.js --cand ./src/strategy_v29.js --vs-file ./src/sparring.js
 *   node siege_test.js        # 专用的"抗围攻生存率"指标
 */

const { Strategy: Base } = require('./strategy_v29');
const { dijkstra, buildPath, marchCost, bfsDistance } = require('./pathfinding');

const P = (k, d) => (process.env[k] !== undefined ? +process.env[k] : d);

class Sieger extends Base {
  nextMove() {
    const gs = this.gs;
    if (gs.myGeneral() === undefined || gs.myGeneral() < 0) return null;

    // 前期完全交给 v29:开局波次、抢地、找将,都要合格才谈得上围攻
    const SIEGE_START = P('SIEGE_START', 120); // 半回合
    if (gs.turn < SIEGE_START) return super.nextMove();

    // 防守/既有计划仍然优先(不能被偷家),沿用基类
    const defense = this.checkDefense();
    if (defense) return defense;

    const target = this.enemyGeneralTile();

    // 还没找到敌将:照常发育 + 侦察(靠基类),但顺手把兵往前线聚
    if (target === -1) {
      const ph = gs.turn % 50;
      if (ph >= P('TRAMPLE_PHASE', 30)) {
        const raid = this.tryRaid();
        if (raid) return raid;
      }
      const scouted = super.nextMove();
      if (scouted) return scouted;
      return this.massUp();
    }

    // 翻倍前 ~10 个真实回合(phase>=30)出去践踏对手的地 —— 用户本人的招牌打法:
    // "我总是在距离翻倍还剩 10 turn 左右的时候出去践踏对手的土地"。
    // 踩在翻倍点上占的每块敌地都是"我 +1、他 -1"的双倍收益,这正是真人 t50 占地
    // (51~61)远高于语料赢家(42)的原因。平时攒兵,窗口一开就用主力去踩。
    const phase = gs.turn % 50;
    if (phase >= P('TRAMPLE_PHASE', 30)) {
      const raid = this.tryRaid();
      if (raid) return raid;
      const harass = this.tryHarass();
      if (harass) return harass;
    }

    // 找到了敌将:攒够就推,不够就继续攒
    const src = this.mainStack();
    if (src !== -1) {
      const need = gs.armies[target] + gs.dist(src, target) + P('SIEGE_MARGIN', 5);
      const enough = gs.armies[src] >= Math.max(P('SIEGE_MIN', 60), need);
      if (enough) {
        const { prev, dist } = dijkstra(gs, src, marchCost(gs, {}));
        if (dist[target] !== Infinity) {
          const path = buildPath(prev, target);
          if (path.length >= 2) return this.planPath(path, 'siege');
        }
      }
    }
    // 兵不够:继续把散兵并进主力
    const mass = this.massUp(target);
    if (mass) return mass;
    return super.nextMove();
  }

  /** 已知的存活敌方将军位置;未知返回 -1 */
  enemyGeneralTile() {
    const gs = this.gs;
    for (const [p, tile] of gs.knownGenerals) {
      if (p === gs.playerIndex || gs.isTeammate(p)) continue;
      const s = gs.scores.find((x) => x.i === p);
      if (s && !s.dead) return tile;
    }
    return -1;
  }

  /** 主力兵团所在地(排除将军本身:将军的兵是驻军,不是野战部队) */
  mainStack() {
    const gs = this.gs;
    const gen = gs.myGeneral();
    let best = -1, bestA = 1;
    for (let t = 0; t < gs.size; t++) {
      if (!gs.isMine(t) || t === gen) continue;
      if (gs.armies[t] > bestA) { bestA = gs.armies[t]; best = t; }
    }
    return best;
  }

  /**
   * 集结:把散兵并进主力兵团(而不是分散推向前线)。
   * 集结点 = 现有主力所在地;没有主力就用最靠近敌人的己方地块起一个。
   */
  massUp(goal) {
    const gs = this.gs;
    let rally = this.mainStack();
    if (rally === -1 || gs.armies[rally] <= 2) {
      const enemy = [];
      for (let t = 0; t < gs.size; t++) if (gs.isEnemy(t)) enemy.push(t);
      if (enemy.length) {
        const df = bfsDistance(gs, enemy);
        let bd = Infinity;
        for (let t = 0; t < gs.size; t++) {
          if (gs.isMine(t) && df[t] !== -1 && df[t] < bd) { bd = df[t]; rally = t; }
        }
      } else rally = gs.myGeneral();
    }
    if (rally === -1 || rally === undefined) return null;
    // 集结点朝目标方向靠:主力已经很大时,边推进边吸收沿途散兵
    if (goal !== undefined && goal >= 0 && gs.armies[rally] >= P('SIEGE_MIN', 60)) {
      const { prev, dist } = dijkstra(gs, rally, marchCost(gs, {}));
      if (dist[goal] !== Infinity) {
        const path = buildPath(prev, goal);
        if (path.length >= 2) return this.planPath(path, 'siege');
      }
    }
    return this.gatherToward(rally);
  }
}

module.exports = { Strategy: Sieger };
