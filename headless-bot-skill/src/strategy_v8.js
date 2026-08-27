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

    // 老家是否暴露:敌兵最近 30 个半回合内出现在将军 4 格内。
    // 不再是永久锁存——敌人撤了/被清了就恢复正常发育,否则会被一次骚扰
    // 永远吓成"只在家边转圈"。
    {
      const gen = gs.myGeneral();
      for (let t = 0; t < gs.size; t++) {
        if (gs.isEnemy(t) && gs.dist(t, gen) <= 4) { this.lastExposedTurn = gs.turn; break; }
      }
      this.homeExposed = this.lastExposedTurn !== undefined && gs.turn - this.lastExposedTurn < 30;
    }

    // 防守判断可以打断任何现有计划
    const defense = this.checkDefense();
    if (defense) return defense;

    // 继续执行既有计划(校验合法性)
    const queued = this.popValidQueued();
    if (queued) return queued;

    // 开局按兵不动到第 12 回合(=24 半回合),让将军先攒到 ~13 兵,再一波长蛇甩出去、
    // 触角伸得更远,后期不用回家踩着自己的地远程调兵。防守已在上面处理,故不怕早鲨。
    if (gs.turn < 24 && !this.homeExposed) return null;

    // 25 回合产兵节奏(FARM_RATE=50 半回合,所有地块 +1):
    //  - 翻倍前的窗口(最后 ~8 个回合):冲出去尽量多占敌方的地——
    //    踩着翻倍点占的每块敌地都是"我 +1、他 -1"的双倍收益。
    //  - 其余时间:发育/聚兵/侦察,不乱出击(斩首能一波带走时除外)。
    const phase = gs.turn % 50;
    const raidWindow = phase >= 34;

    if (raidWindow) {
      return (
        this.tryStrike(true) || // 窗口内只打"能一波带走"的斩首;兵不够就抢地,不傻集兵
        this.tryCounterCamp() ||
        this.tryRaid() ||
        this.tryHarass() ||
        this.tryExpand() ||
        this.tryScout() ||
        this.tryGather()
      );
    }
    return (
      this.tryStrike() ||
      this.tryCounterCamp() ||
      this.tryScout() ||
      this.tryCaptureCity() ||
      this.tryExpand() ||
      this.tryHarass() ||
      this.tryGather()
    );
  }

  // ---------- 翻倍前突袭:蛇形连吃敌方地块 ----------

  /**
   * 从紧邻敌方领土、兵最多的己方地块出发,蛇形连吃"吃得动"的敌格
   * (每格消耗其驻军+1),吃不动就顺路捡空地。专在产兵翻倍前的窗口用。
   */
  raidWalk(src) {
    const gs = this.gs;
    const path = [src];
    const visited = new Set([src]);
    let strength = gs.armies[src] - 1;
    let cur = src;
    while (strength > 1) {
      let pick = -1, pickScore = -Infinity;
      for (const n of gs.neighbors(cur)) {
        if (visited.has(n)) continue;
        const enemyTile = gs.isEnemy(n) && !gs.isCity(n);
        const emptyTile = gs.terrain[n] === -1 && !gs.isCity(n);
        if (!enemyTile && !emptyTile) continue;
        const cost = enemyTile ? gs.armies[n] + 1 : 1;
        if (strength - cost < 1) continue;
        const score = (enemyTile ? 100 : 0) - cost; // 优先吃敌地(我+1他-1),代价小者先
        if (score > pickScore) { pickScore = score; pick = n; }
      }
      if (pick === -1) break;
      strength -= gs.isEnemy(pick) ? gs.armies[pick] + 1 : 1;
      path.push(pick);
      visited.add(pick);
      cur = pick;
    }
    return path;
  }

  tryRaid() {
    const gs = this.gs;
    // 找兵最多、且紧邻敌方地块的己方前线
    let best = -1, bestA = 2;
    for (let t = 0; t < gs.size; t++) {
      if (!gs.isMine(t) || gs.armies[t] <= 2) continue;
      let touchesEnemy = false;
      for (const n of gs.neighbors(t)) if (gs.isEnemy(n) && !gs.isCity(n)) { touchesEnemy = true; break; }
      if (touchesEnemy && gs.armies[t] > bestA) { bestA = gs.armies[t]; best = t; }
    }
    if (best === -1) return null;
    const walk = this.raidWalk(best);
    if (walk.length < 2) return null;
    // 至少真能吃到一块敌地才值得发动
    let eatsEnemy = false;
    for (const t of walk) if (gs.isEnemy(t)) { eatsEnemy = true; break; }
    if (!eatsEnemy) return null;
    return this.planPath(walk, 'raid');
  }

  // ---------- 反制蹲家:能吃就直接吃掉蹲在家门口的敌兵 ----------

  tryCounterCamp() {
    const gs = this.gs;
    const gen = gs.myGeneral();
    // 找蹲在将军 8 格内最大的敌兵团
    let camper = -1, camperArmy = 0;
    for (let t = 0; t < gs.size; t++) {
      if (!gs.isEnemy(t)) continue;
      if (gs.dist(t, gen) > 8) continue;
      if (gs.armies[t] > camperArmy) { camperArmy = gs.armies[t]; camper = t; }
    }
    if (camper === -1 || camperArmy < 6) return null;

    const src = this.biggestArmyTile([]);
    if (src === -1) return null;
    const { prev, dist } = dijkstra(gs, src, marchCost(gs, { target: camper }));
    if (dist[camper] === Infinity) return null;
    const path = buildPath(prev, camper);
    // 有利可图才吃:兵力明显压过蹲兵 + 路程消耗
    if (gs.armies[src] > camperArmy * 1.3 + path.length) {
      return this.planPath(path, 'counter');
    }
    return null; // 吃不动 → 下游 scout 会去反打它后方(围魏救赵)
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
    const DANGER_RADIUS = 8; // 扫参实测:调大反而更差(为远处虚警回防、拖累经济)
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
    if (threatTile === -1) { this.campCount = 0; return null; }

    // 蹲家识别:威胁若连续多个半回合不向将军推进,就是"蹲家"。
    // 蹲家兵不值得无限回防——那样会被牵着鼻子在家边永远绕圈集兵。
    // 回防过一轮后就转为正常打法:反吃蹲兵/反打其后方(它兵在我家,它家必空)。
    if (this.lastThreatDist !== undefined && threatDist >= this.lastThreatDist) {
      this.campCount = (this.campCount || 0) + 1;
    } else {
      this.campCount = 0;
    }
    this.lastThreatDist = threatDist;
    const camping = this.campCount >= 8 && threatDist >= 3; // 贴脸(<3)永远认真防

    // 将军自身 + 相邻己方兵力是否足以正面挡住(留 1 给相邻地块)
    let localDefense = gs.armies[gen];
    for (const n of gs.neighbors(gen)) if (gs.isMine(n)) localDefense += gs.armies[n] - 1;
    if (localDefense > threatArmy) return null;
    if (camping) return null; // 蹲家:不再无限拉兵回防,交给下游反打逻辑

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

  tryStrike(killOnly = false) {
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
      if (killOnly) continue; // 产兵窗口:兵不够不集兵,把窗口留给抢地
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

    // 老家已暴露:停止"派主力去远处铺地",把兵力留着防守/找将反打。
    if (this.homeExposed) return null;

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
    const src = this.biggestArmyTile([]);
    if (src === -1) return null;

    // 打塔=持续产兵,是长局燃料。选"近且代价小"的城:综合距离 + 驻军。
    // 只要手上有一支兵团能吃下就打(不再因为一时兵力落后就完全不打)。
    let best = null;
    const { prev, dist } = dijkstra(gs, src, marchCost(gs, { allowCity: true }));
    for (const c of gs.knownCities) {
      if (gs.isMine(c)) continue;
      if (!gs.isVisible(c) && gs.isEnemy(c)) continue; // 敌方迷雾里的城,拿不准,跳过
      const garrison = gs.isVisible(c) ? gs.armies[c] : 45;
      const need = garrison + gs.dist(src, c) + 2;
      if (gs.armies[src] <= need) continue; // 这支兵团吃不下
      if (dist[c] === Infinity) continue;
      const cost = dist[c] + garrison * 0.5; // 近 + 驻军少 优先
      if (!best || cost < best.cost) best = { c, cost };
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
    // 方向导向:朝敌方(已接触)或地图中心(未接触)铺,而非同心圆四散。
    // 抢中间/朝敌人的地更有价值,也顺势把兵推向前线便于后续找将/施压。
    const dir = this.expandDirection();
    const gen = gs.myGeneral();
    const gr0 = gs.row(gen), gc0 = gs.col(gen);
    while (budget > 0) {
      let pick = -1;
      let pickScore = -Infinity;
      for (const n of gs.neighbors(cur)) {
        if (visited.has(n)) continue;
        if (gs.terrain[n] !== -1 || gs.isCity(n)) continue; // 只走免费空地
        // 前瞻:能继续打开多少空地(避免死角) + 朝目标方向的推进量
        let opens = 0;
        for (const m of gs.neighbors(n)) {
          if (!visited.has(m) && gs.terrain[m] === -1 && !gs.isCity(m)) opens++;
        }
        const toward = -(Math.abs(gs.row(n) - dir.r) + Math.abs(gs.col(n) - dir.c));
        // 往远伸:偏好离将军更远的格,拉出长触角,而不是在家门口填成一团。
        const reach = Math.abs(gs.row(n) - gr0) + Math.abs(gs.col(n) - gc0);
        const score = opens + 0.5 * toward + 0.6 * reach; // 往远伸,拉长触角
        if (score > pickScore) { pickScore = score; pick = n; }
      }
      if (pick === -1) break;
      path.push(pick);
      visited.add(pick);
      cur = pick;
      budget--;
    }
    return path;
  }

  /** 扩张导向点:敌格重心(已接触)或地图中心(未接触) */
  expandDirection() {
    const gs = this.gs;
    let er = 0, ec = 0, n = 0;
    for (let t = 0; t < gs.size; t++) if (gs.isEnemy(t)) { er += gs.row(t); ec += gs.col(t); n++; }
    if (n) return { r: er / n, c: ec / n };
    return { r: (gs.height - 1) / 2, c: (gs.width - 1) / 2 };
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
