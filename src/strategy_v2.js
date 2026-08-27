'use strict';

const { dijkstra, buildPath, marchCost, bfsDistance } = require('./pathfinding');

/**
 * 策略核心。每个半回合 (game_update) 调用一次 nextMove(),返回 {from, to} 或 null。
 *
 * 决策优先级:
 *   1. 防守 —— 将军受威胁时回防
 *   2. 斩首 —— 已知敌方将军且兵力足够时集结强攻
 *   3. 扩张 —— 前 50 回合以及有廉价空地时抢地(land = 每回合产兵)
 *   4. 攻城 —— 兵力盈余时拿城(城 = 稳定产兵点)
 *   5. 骚扰/蚕食 —— 推进前线,吃敌方地块
 *   6. 聚兵 —— 把内陆散兵收拢到前线
 */
class Strategy {
  constructor(gs) {
    this.gs = gs;
    this.queue = [];          // 计划中的移动路径 [{from,to}, ...]
    this.queuePurpose = null; // 'defend' | 'strike' | 'expand' | 'city' | 'gather' | 'harass'
    this.lastLandCount = 0;
  }

  nextMove() {
    const gs = this.gs;
    if (gs.myGeneral() === undefined || gs.myGeneral() < 0) return null;

    // 防守判断可以打断任何现有计划
    const defense = this.checkDefense();
    if (defense) return defense;

    // 继续执行既有计划(校验合法性)
    const queued = this.popValidQueued();
    if (queued) return queued;

    // 依优先级生成新计划
    return (
      this.tryStrike() ||
      this.tryScout() ||
      this.tryExpand() ||
      this.tryCaptureCity() ||
      this.tryHarass() ||
      this.tryGather()
    );
  }

  // ---------- 找将侦察(核心缺失环:先得找到敌将,斩首才谈得上) ----------

  /**
   * 沿"我方将军→敌方重心"的方向,把一支兵推进到敌方一侧最深处(迷雾/敌格),
   * 一路揭开视野,迟早撞见藏在雾里的敌将;找到后 tryStrike 接管。
   * 老版本从不主动侦察,所以半数对局到死都没见过敌将。
   */
  tryScout() {
    const gs = this.gs;
    const SCOUT_MIN = 20; // 擂台实测:10~20 同为最优(71.7% vs 无侦察版),30 起下滑
    const gen = gs.myGeneral();

    const enemy = [];
    for (let t = 0; t < gs.size; t++) if (gs.isEnemy(t)) enemy.push(t);
    if (!enemy.length) return null; // 还没接触敌人,方向未知,先扩张

    const src = this.biggestArmyTile([]);
    if (src === -1 || gs.armies[src] < SCOUT_MIN) return null;

    // 方向向量:我方将军 → 敌格重心
    let er = 0, ec = 0;
    for (const t of enemy) { er += gs.row(t); ec += gs.col(t); }
    er /= enemy.length; ec /= enemy.length;
    const gr = gs.row(gen), gc = gs.col(gen);
    const dr = er - gr, dc = ec - gc;

    // 目标:可达的"敌方一侧"格子(迷雾 -3 / 迷雾障碍 -4 / 敌格)中,沿该方向投影最深的
    const { prev, dist } = dijkstra(gs, src, marchCost(gs, { allowCity: true }));
    let target = -1, bestProj = -Infinity;
    for (let t = 0; t < gs.size; t++) {
      if (dist[t] === Infinity) continue;
      const ter = gs.terrain[t];
      const theirSide = ter === -3 || ter === -4 || gs.isEnemy(t);
      if (!theirSide) continue;
      const proj = (gs.row(t) - gr) * dr + (gs.col(t) - gc) * dc;
      if (proj > bestProj) { bestProj = proj; target = t; }
    }
    if (target === -1) return null;
    return this.planPath(buildPath(prev, target), 'scout');
  }

  // ---------- 队列管理 ----------

  planPath(path, purpose) {
    this.queue = [];
    for (let i = 0; i + 1 < path.length; i++) {
      this.queue.push({ from: path[i], to: path[i + 1] });
    }
    this.queuePurpose = purpose;
    return this.popValidQueued();
  }

  popValidQueued() {
    const gs = this.gs;
    while (this.queue.length) {
      const mv = this.queue.shift();
      if (gs.isMine(mv.from) && gs.armies[mv.from] > 1 && gs.isPassable(mv.to)) {
        return mv;
      }
      // 路径失效(兵没跟上/地丢了),放弃剩余计划
      this.queue = [];
      this.queuePurpose = null;
    }
    return null;
  }

  // ---------- 1. 防守 ----------

  checkDefense() {
    const gs = this.gs;
    const gen = gs.myGeneral();
    const DANGER_RADIUS = 8;
    const MIN_THREAT = 6; // 太小的敌兵不值得全军回防

    // 找最靠近将军且够大的敌方兵团(以到将军的步数为准,近的更危险)
    let threatTile = -1;
    let threatArmy = 0;
    let threatDist = Infinity;
    for (let t = 0; t < gs.size; t++) {
      if (!gs.isEnemy(t)) continue;
      if (gs.armies[t] < MIN_THREAT) continue;
      const d = gs.dist(t, gen);
      if (d > DANGER_RADIUS) continue;
      // 越近越优先;同距离取兵多的
      if (d < threatDist || (d === threatDist && gs.armies[t] > threatArmy)) {
        threatArmy = gs.armies[t];
        threatTile = t;
        threatDist = d;
      }
    }
    if (threatTile === -1) return null;

    // 将军自身 + 相邻己方兵力是否足以正面挡住(留 1 给相邻地块)
    let localDefense = gs.armies[gen];
    for (const n of gs.neighbors(gen)) if (gs.isMine(n)) localDefense += gs.armies[n] - 1;
    if (localDefense > threatArmy) return null;

    // 需要外援。关键:必须能在敌人到达将军之前赶到,否则等于白送。
    // 用 BFS 步数场衡量各己方地块到将军的步数,只考虑 <= 敌人步数的兵团。
    const stepsToGen = bfsDistance(gs, [gen]);
    let src = -1;
    let srcArmy = 0;
    for (let t = 0; t < gs.size; t++) {
      if (!gs.isMine(t) || t === gen || gs.armies[t] <= 1) continue;
      const st = stepsToGen[t];
      if (st === -1 || st > threatDist) continue; // 赶不及,忽略
      if (gs.armies[t] > srcArmy) {
        srcArmy = gs.armies[t];
        src = t;
      }
    }

    // 没有能及时赶到的援军 → 退而求其次,派最大兵团尽力回防(总比不动强)
    if (src === -1) src = this.biggestArmyTile([gen]);

    if (src !== -1 && this.queuePurpose !== 'defend') {
      const { prev, dist } = dijkstra(gs, src, marchCost(gs));
      if (dist[gen] < Infinity) {
        return this.planPath(buildPath(prev, gen), 'defend');
      }
    }
    return this.popValidQueued();
  }

  // ---------- 2. 斩首 ----------

  tryStrike() {
    const gs = this.gs;
    for (const [p, genTile] of gs.knownGenerals) {
      if (p === gs.playerIndex || gs.isTeammate(p)) continue;
      const enemyScore = gs.scores.find((s) => s.i === p);
      if (!enemyScore || enemyScore.dead) continue;

      const src = this.biggestArmyTile([genTile]);
      if (src === -1) continue;

      // 估算沿途需要消耗:粗略要求出发兵力 > 敌将驻军 + 路径长度 + 余量
      const { prev, dist } = dijkstra(gs, src, marchCost(gs, { allowCity: true, target: genTile }));
      if (dist[genTile] === Infinity) continue;
      const path = buildPath(prev, genTile);
      const need = gs.armies[genTile] + path.length + 2;
      if (gs.armies[src] > need) {
        return this.planPath(path, 'strike');
      }
      // 兵力不足但目标明确:向敌将方向聚兵
      const gatherMove = this.gatherToward(src);
      if (gatherMove) return gatherMove;
    }
    return null;
  }

  // ---------- 3. 扩张 ----------

  tryExpand() {
    const gs = this.gs;

    // 1) 前线蛇形连吃:选"兵最多、且紧邻可见空地"的前线地块,规划一条穿过空地的
    //    蛇形路径一次提交。用前线兵(而非全局最大兵团,后者常堆在内陆够不到边)。
    let frontier = -1, frontierArmy = 1;
    for (let t = 0; t < gs.size; t++) {
      if (!gs.isMine(t) || gs.armies[t] <= 1) continue;
      let touchesEmpty = false;
      for (const n of gs.neighbors(t)) {
        if (gs.terrain[n] === -1 && !gs.isCity(n)) { touchesEmpty = true; break; }
      }
      if (touchesEmpty && gs.armies[t] > frontierArmy) { frontierArmy = gs.armies[t]; frontier = t; }
    }
    if (frontier !== -1) {
      const walk = this.expansionWalk(frontier);
      if (walk.length >= 2) return this.planPath(walk, 'expand');
    }

    // 2) 没有前线兵紧邻空地(兵都堆在内陆)→ 把最大兵团推向"附近"的空地。
    //    只吃近处便宜地(dist<=EXPAND_REACH):远处空地不值得让主力长途跋涉,
    //    否则兵力摊薄、无法集结斩首/防守——这正是"地多却被破家"的根因。
    const EXPAND_REACH = 5; // 擂台实测最优:过贪(摊薄被破家)或过怯(开局停滞)都更弱
    const src = this.biggestArmyTile([]);
    if (src === -1) return null;
    const { prev, dist } = dijkstra(gs, src, marchCost(gs));
    let target = -1, bd = Infinity;
    for (let t = 0; t < gs.size; t++) {
      if (gs.terrain[t] === -1 && !gs.isCity(t) && dist[t] <= EXPAND_REACH && dist[t] < bd) { bd = dist[t]; target = t; }
    }
    if (target === -1) return null;
    return this.planPath(buildPath(prev, target), 'expand');
  }

  // ---------- 4. 攻城 ----------

  tryCaptureCity() {
    const gs = this.gs;
    const myArmy = gs.myScore().total;
    const topEnemy = gs.enemyScores()[0];

    // 兵力没有明显盈余就不冒险攻城(城会持续损耗)
    if (topEnemy && myArmy < topEnemy.total * 0.9) return null;

    const src = this.biggestArmyTile([]);
    if (src === -1) return null;

    let best = null;
    const { prev, dist } = dijkstra(gs, src, marchCost(gs, { allowCity: true }));
    for (const c of gs.knownCities) {
      if (gs.isMine(c)) continue;
      if (!gs.isVisible(c) && gs.isEnemy(c)) continue;
      const need = (gs.isVisible(c) ? gs.armies[c] : 45) + gs.dist(src, c) + 2;
      if (gs.armies[src] <= need) continue;
      if (dist[c] === Infinity) continue;
      if (!best || dist[c] < best.d) best = { c, d: dist[c] };
    }
    if (!best) return null;
    return this.planPath(buildPath(prev, best.c), 'city');
  }

  // ---------- 5. 骚扰 / 蚕食 ----------

  tryHarass() {
    const gs = this.gs;
    // 用前线兵直接吃相邻的敌方弱格
    let best = null;
    for (let t = 0; t < gs.size; t++) {
      if (!gs.isMine(t) || gs.armies[t] <= 1) continue;
      for (const n of gs.neighbors(t)) {
        if (gs.isEnemy(n) && gs.armies[t] > gs.armies[n] + 1 && !gs.isCity(n)) {
          const gain = gs.armies[t] - gs.armies[n];
          if (!best || gain > best.gain) best = { from: t, to: n, gain };
        }
      }
    }
    return best ? { from: best.from, to: best.to } : null;
  }

  // ---------- 6. 聚兵 ----------

  tryGather() {
    const gs = this.gs;
    // 目标:最靠近敌人的前线己方地块;没有敌情则聚向将军
    const enemyTiles = [];
    for (let t = 0; t < gs.size; t++) if (gs.isEnemy(t)) enemyTiles.push(t);

    let target;
    if (enemyTiles.length) {
      const df = bfsDistance(gs, enemyTiles);
      target = -1;
      let bd = Infinity;
      for (let t = 0; t < gs.size; t++) {
        if (gs.isMine(t) && df[t] !== -1 && df[t] < bd) { bd = df[t]; target = t; }
      }
    } else {
      target = gs.myGeneral();
    }
    if (target === -1 || target === undefined) return null;
    return this.gatherToward(target);
  }

  /** 把(除目标外)最大的兵团往 target 挪一条路径 */
  gatherToward(target) {
    const gs = this.gs;
    const src = this.biggestArmyTile([target]);
    if (src === -1 || src === target) return null;
    const { prev, dist } = dijkstra(gs, src, marchCost(gs));
    if (dist[target] === Infinity) return null;
    return this.planPath(buildPath(prev, target), 'gather');
  }

  // ---------- 工具 ----------

  /**
   * 从 src 出发贪心走一条穿过空地的路径:每步选"能打开最多后续空地"的相邻空地,
   * 直到兵力用尽或无空地可吃。一个 N 兵的兵团沿直线能连吃约 N-1 格空地。
   * 返回 [src, t1, t2, ...];长度 < 2 表示没地可扩。
   */
  expansionWalk(src) {
    const gs = this.gs;
    const path = [src];
    const visited = new Set([src]);
    let budget = gs.armies[src] - 1; // 还能吃下多少格空地
    let cur = src;
    while (budget > 0) {
      let pick = -1;
      let pickScore = -1;
      for (const n of gs.neighbors(cur)) {
        if (visited.has(n)) continue;
        if (gs.terrain[n] !== -1 || gs.isCity(n)) continue; // 只走免费空地
        // 前瞻一步:优先去能继续打开更多空地的方向,避免走进死角
        let opens = 0;
        for (const m of gs.neighbors(n)) {
          if (!visited.has(m) && gs.terrain[m] === -1 && !gs.isCity(m)) opens++;
        }
        if (opens > pickScore) { pickScore = opens; pick = n; }
      }
      if (pick === -1) break;
      path.push(pick);
      visited.add(pick);
      cur = pick;
      budget--;
    }
    return path;
  }

  /** 兵力最大的己方地块(可排除若干地块;将军保底留兵) */
  biggestArmyTile(exclude) {
    const gs = this.gs;
    const ex = new Set(exclude);
    const gen = gs.myGeneral();
    let best = -1, bestA = 1;
    for (let t = 0; t < gs.size; t++) {
      if (!gs.isMine(t) || ex.has(t)) continue;
      let a = gs.armies[t];
      if (t === gen) {
        // 将军地块要留守:中后期不轻易掏空
        const reserve = gs.turn > 100 ? Math.ceil(a * 0.5) : 1;
        a = a - reserve;
      }
      if (a > bestA) { bestA = a; best = t; }
    }
    return best;
  }
}

module.exports = { Strategy };
