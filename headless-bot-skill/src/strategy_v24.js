'use strict';

const { dijkstra, buildPath, marchCost, gatherCost, bfsDistance } = require('./pathfinding');

// 可调参数(默认=当前实测值;env 覆盖用于向高手画像收敛的自动调参)
const P = (k, d) => (process.env[k] !== undefined ? +process.env[k] : d);

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

    // 对手是否已"看到过"我的家:敌方地块到过将军 2 格内(其视野必然覆盖将军)。
    // 一旦看到就永远知道位置——这是决定敢不敢投资中立塔的关键。
    if (!this.homeSeen) {
      const gen = gs.myGeneral();
      for (let t = 0; t < gs.size; t++) {
        if (gs.isEnemy(t) && gs.dist(t, gen) <= 2) { this.homeSeen = true; break; }
      }
    }

    // 家门威胁分两个概念(高手数据:被摸到家时行动率 89% = 平时,绝不冻结):
    //  - homeThreatNow/homeThreatArmy:此刻将军 5 格内最强敌兵(≥6)——只在它在场时
    //    锁住"够用的守备量",盈余照常机动出击(高手期间 1/3 动作都在打敌格);
    //  - homeExposed(30 半回合记忆):只用于"敢不敢投资中立塔"的判断。
    {
      const gen = gs.myGeneral();
      this.homeThreatNow = false;
      this.homeThreatArmy = 0;
      for (let t = 0; t < gs.size; t++) {
        if (!gs.isEnemy(t) || gs.armies[t] < 6) continue;
        if (gs.dist(t, gen) <= 5) {
          this.homeThreatNow = true;
          if (gs.armies[t] > this.homeThreatArmy) this.homeThreatArmy = gs.armies[t];
          this.lastExposedTurn = gs.turn;
        }
      }
      this.homeExposed = this.lastExposedTurn !== undefined && gs.turn - this.lastExposedTurn < 30;
    }

    // 对手突然打塔侦测:其总兵力单帧骤降 ~35-60 = 他把兵投进城里了。
    // 这一刻他没有进攻能力——正是我们也去打塔补经济的安全窗口。
    {
      const top = gs.enemyScores()[0];
      if (top) {
        if (this.prevOppTotal !== undefined) {
          const drop = this.prevOppTotal - top.total;
          if (drop >= 35 && drop <= 60) this.oppCityWindow = gs.turn + 50;
        }
        this.prevOppTotal = top.total;
      }
    }

    // 防守判断可以打断任何现有计划
    const defense = this.checkDefense();
    if (defense) return defense;

    // 继续执行既有计划(校验合法性)
    const queued = this.popValidQueued();
    if (queued) return queued;

    // 消视野:对手只要在将军 2 格内留一块地(哪怕 1 兵),就能一直盯着我家的一举一动。
    // 这种"眼"必须立刻拔掉,优先级高于一切经济/进攻动作。
    const deny = this.tryDenyVision();
    if (deny) return deny;

    // 开局按兵不动到第 12 回合(=24 半回合),让将军先攒到 ~13 兵,再一波长蛇甩出去、
    // 触角伸得更远,后期不用回家踩着自己的地远程调兵。防守已在上面处理,故不怕早鲨。
    if (gs.turn < 24 && !this.homeExposed) return null;

    // 开局波次编舞(25 回合前):第 1 波 13 兵一条路走完不回头;
    // 第 2 波从家出、踩 2 格自己的地接上前线,余下一次性走完;
    // 第 3、4 波同样从家一次性走完。波与波之间按兵不动攒兵——
    // 绝不在家周围零敲碎打填地(那是之前"填满周边"的病根)。
    if (gs.turn < 50) {
      const wave = this.openingWave();
      if (wave) return wave;
      if (this.waveCount < 4) return null; // 波间等待攒兵,不做任何小动作
    }

    // 35~50 回合:集兵踩踏对手地建立优势——25~35 扩完地后,把兵收拢起来
    // 一路碾过对手的地(他 -1 我 +1),赶在 50 回合翻倍前把地面优势做出来。
    // 还没接触到对手时没人可踩,照常扩地/侦察,别把兵白白聚回家。
    if (gs.turn >= 70 && gs.turn < 100) {
      let contact = false;
      for (let t = 0; t < gs.size; t++) if (gs.isEnemy(t)) { contact = true; break; }
      if (contact) {
        return (
          this.tryStrike() ||
          this.tryCounterCamp() ||
          this.tryCaptureCity(true) || // 顺手吃得下的塔别放过
          this.tryRaid() ||    // 踩踏:蛇形连吃敌地
          this.tryCaptureCity() || // 高手 t60~90 就拿首城:踩踏间隙就地凑塔
          this.tryHarass() ||
          this.tryGather() ||  // 没得吃就聚兵到前线,准备下一口
          this.tryExpand() ||
          this.tryScout()
        );
      }
      return this.tryStrike() || this.tryCaptureCity(true) || this.tryExpand() || this.tryScout() || this.tryGather();
    }

    // 25 回合产兵节奏(FARM_RATE=50 半回合,所有地块 +1),第 50 回合起的每个周期:
    //  - 偷袭窗口(翻倍前 ~10 回合,phase>=30):没有更高优先级的事就去咬敌地/吃塔,
    //    踩着翻倍点占的每块敌地都是"我 +1、他 -1"的双倍收益;
    //  - 窗口前的集兵段:按"主力到前线的距离"自动倒推提前量,窗口开启时兵团正好到位;
    //  - 其余时间:发育/侦察/吃便宜塔。
    const phase = gs.turn % 50;

    if (gs.turn >= 100 && phase >= P('RAID_START', 30)) {
      return (
        this.tryStrike() ||      // 斩首永远最高;窗口前已集过兵,不会傻站着
        this.tryCounterCamp() ||
        this.tryCaptureCity(true) || // 翻倍前顺手吃塔 = 下个周期立刻多一个产兵点
        this.tryRaid() ||
        this.tryHarass() ||
        this.tryExpand() ||
        this.tryScout() ||
        this.tryGather()
      );
    }
    // 前两轮(50 回合=100 半回合)重心是扩地:扩张排在塔/侦察之前
    if (gs.turn < 100) {
      return (
        this.tryStrike() ||
        this.tryCounterCamp() ||
        this.tryCaptureCity(true) || // 立刻吃得下的塔顺手拿,不排队
        this.tryExpand() ||
        this.tryCaptureCity() ||
        this.tryScout() ||
        this.tryHarass() ||
        this.tryGather()
      );
    }
    // 发育段(phase<30):预集兵按提前量启动;t150 起进入收拢期
    // (高手此后集中度持续爬坡:前5兵团 20%→27%),兜底动作变为收拢散兵。
    // 注:高手还有 ~30% 的刻意空转(蓄力),第一版实现没做出效果反丢经济,已撤,
    // 待用更好的机制(如按兵力密度决定是否值得动)再攻。
    const preGather = (() => {
      const lead = this.gatherLead();
      if (lead !== null && phase >= P('RAID_START', 30) - lead) return this.tryGather();
      return null;
    })();
    const consolidate = gs.turn >= P('CONSOL_START', 300) ? this.tryGather() : null;
    return (
      this.tryStrike() ||
      this.tryCounterCamp() ||
      this.tryCaptureCity(true) ||
      preGather ||
      this.tryCaptureCity() || // 塔在侦察之前:否则主力兵团总被侦察抢走,永远凑不齐吃塔的兵
      this.tryScout() ||
      this.tryModelMove() ||   // 混合体:发育段日常走子交给模仿学习排序器(469局高手行为)
      this.tryExpand() ||
      this.tryHarass() ||
      consolidate ||
      this.tryGather()
    );
  }

  /**
   * 模仿学习走子(混合体的"日常行军"):用 469 局高手数据训的排序器选步。
   * 规则仍握着生死权(斩首/防守/反蹲/攻城/波次/节奏都在它之前),
   * 模型只接管"没有紧急事项时往哪走"。两道安全罩:
   *  - 兵临城下不掏将军(模型没有防守概念);
   *  - 禁止立即折返(线性模型无记忆会来回震荡——高手回头率只有 3.5%)。
   */
  tryModelMove() {
    if (process.env.NO_MODEL) return null;
    if (this.imitator === undefined) {
      try {
        const { ImitationStrategy } = require('./imitation');
        this.imitator = new ImitationStrategy(this.gs); // 共享同一 GameState 视角
      } catch (e) { this.imitator = null; } // 模型文件缺失时静默退回纯规则
    }
    if (!this.imitator) return null;
    let mv = null;
    try { mv = this.imitator.nextMove(); } catch (e) { return null; }
    if (!mv) return null;
    const gs = this.gs;
    if (this.homeThreatNow && mv.from === gs.myGeneral()) return null; // 罩1
    if (this.lastModelMv && mv.from === this.lastModelMv.to && mv.to === this.lastModelMv.from) return null; // 罩2
    this.lastModelMv = mv;
    return mv;
  }

  /** 集兵提前量:主力兵团到"最靠近敌人的前线"的步数 + 余量(封顶 16 个半回合) */
  gatherLead() {
    const gs = this.gs;
    const enemy = [];
    for (let t = 0; t < gs.size; t++) if (gs.isEnemy(t)) enemy.push(t);
    if (!enemy.length) return null;
    const src = this.biggestArmyTile([]);
    if (src === -1) return null;
    const df = bfsDistance(gs, enemy);
    let front = -1, bd = Infinity;
    for (let t = 0; t < gs.size; t++) {
      if (gs.isMine(t) && df[t] !== -1 && df[t] < bd) { bd = df[t]; front = t; }
    }
    if (front === -1) return null;
    return Math.min(P('LEAD_CAP', 16), gs.dist(src, front) + 4);
  }

  // ---------- 消视野:拔掉盯着我家的"眼" ----------

  tryDenyVision() {
    const gs = this.gs, gen = gs.myGeneral();
    // 将军 2 格内的敌方地块 = 它的视野能罩住将军,挑驻军最少的先拔
    let spy = -1, spyArmy = Infinity;
    for (let t = 0; t < gs.size; t++) {
      if (!gs.isEnemy(t)) continue;
      if (gs.dist(t, gen) > 2) continue;
      if (gs.armies[t] < spyArmy) { spyArmy = gs.armies[t]; spy = t; }
    }
    if (spy === -1) return null;
    // 就近找能一口吃掉它的己方兵(将军本身也行——清门口的眼就是防守)
    let src = -1, bestD = Infinity;
    for (let t = 0; t < gs.size; t++) {
      if (!gs.isMine(t) || gs.armies[t] <= 1) continue;
      const d = gs.dist(t, spy);
      if (d > 4) continue;
      if (gs.armies[t] > spyArmy + d + 1 && d < bestD) { bestD = d; src = t; }
    }
    if (src === -1) return null;
    const { prev, dist } = dijkstra(gs, src, marchCost(gs, { target: spy }));
    if (dist[spy] === Infinity) return null;
    return this.planPath(buildPath(prev, spy), 'deny');
  }

  // ---------- 开局波次 ----------

  openingWave() {
    const gs = this.gs;
    if (this.waveCount === undefined) this.waveCount = 0;
    if (this.waveCount >= 4) return null; // 四波走完,交回常规逻辑
    const gen = gs.myGeneral();
    // 每波都用将军攒下的全部兵"一次性走完":第 1 波 turn24 自然有 13 兵;
    // 后面的波至少攒到 4 兵再出,避免两三兵的小碎波。
    const minArmy = this.waveCount === 0 ? 2 : 3;
    if (gs.armies[gen] < minArmy) return null;
    // own 前缀:第 1 波直接踏空地;第 2 波按规格踩 2 格自己的地;
    // 第 3、4 波家已被自己的地包住,允许最多 6 格自己的地穿到前线
    // (评分里空地绝对优先,所以一见空地立刻拐出去,不会真走满 6 格)。
    const ownPrefix = this.waveCount === 0 ? 0 : this.waveCount === 1 ? 2 : 6;
    const avoidStubs = this.waveCount === 0; // 首轮不扩 T 型断头地,保持蛇形连走
    const path = this.waveWalk(gen, ownPrefix, avoidStubs);
    if (path.length >= 2) { this.waveCount++; return this.planPath(path, 'expand'); }
    // 攒了不少兵却无路可走(方向被山/地形封死):放弃编舞,交回常规逻辑
    if (gs.armies[gen] >= 8) this.waveCount = 4;
    return null;
  }

  /**
   * 从 start 出发的"不回头"波次行走:最多先踩 ownPrefixMax 格自己的地(接上前线),
   * 一旦踏入空地就只走空地,直到兵力用完。visited 保证绝不回头。
   * 用束搜索找"整条路吃到最多空地"的走法——贪心一步一看会把蛇走进死角,
   * 13 兵只铺 7 格;束搜索能规划出人手那种走满的长蛇,自然也绕开 T 型断头地。
   */
  waveWalk(start, ownPrefixMax, avoidStubs = false) {
    const gs = this.gs;
    const dir = this.expandDirection();
    const BW = 6; // 束宽
    let beam = [{ path: [start], visited: new Set([start]), budget: gs.armies[start] - 1, ownUsed: 0, onEmpties: false, empties: 0 }];
    let best = beam[0];
    while (beam.length) {
      const next = [];
      for (const st of beam) {
        if (st.budget <= 0) continue;
        const cur = st.path[st.path.length - 1];
        for (const n of gs.neighbors(cur)) {
          if (st.visited.has(n)) continue;
          // 平雾(-3)必然是无障碍空地(山/城在雾里显示为 -4,neighbors 已过滤),
          // 人类开局就是径直往雾里铺的——波次也一样,别被视野困在家门口。
          const ter = gs.terrain[n];
          const empty = (ter === -1 || ter === -3) && !gs.isCity(n);
          const ownOk = gs.isMine(n) && !st.onEmpties && st.ownUsed < ownPrefixMax;
          if (!empty && !ownOk) continue;
          const ns = {
            path: st.path.concat(n),
            visited: new Set(st.visited),
            budget: st.budget - 1 + (empty ? 0 : Math.max(0, gs.armies[n] - 1)),
            ownUsed: st.ownUsed + (empty ? 0 : 1),
            onEmpties: st.onEmpties || empty,
            empties: st.empties + (empty ? 1 : 0),
          };
          ns.visited.add(n);
          next.push(ns);
        }
      }
      if (!next.length) break;
      // 主排序:吃到的空地数;并列时偏向"朝敌方向推进"的路线
      next.sort((a, b) => {
        if (b.empties !== a.empties) return b.empties - a.empties;
        const la = a.path[a.path.length - 1], lb = b.path[b.path.length - 1];
        const da = Math.abs(gs.row(la) - dir.r) + Math.abs(gs.col(la) - dir.c);
        const db = Math.abs(gs.row(lb) - dir.r) + Math.abs(gs.col(lb) - dir.c);
        return da - db;
      });
      beam = next.slice(0, BW);
      if (beam[0].empties > best.empties) best = beam[0];
    }
    return best.path;
  }

  // ---------- 翻倍前突袭:蛇形连吃敌方地块 ----------

  /**
   * 从紧邻敌方领土、兵最多的己方地块出发,蛇形连吃"吃得动"的敌格
   * (每格消耗其驻军+1),吃不动就顺路捡空地。专在产兵翻倍前的窗口用。
   */
  /** 进攻目标点:已知敌将用敌将,否则用敌方地块重心(高手吃敌格比我们深 2 格——直插腹地) */
  enemyGoalPoint() {
    const gs = this.gs;
    for (const [p, g] of gs.knownGenerals) {
      if (p === gs.playerIndex || gs.isTeammate(p)) continue;
      const s = gs.scores.find((x) => x.i === p);
      if (s && !s.dead) return { r: gs.row(g), c: gs.col(g) };
    }
    let er = 0, ec = 0, n = 0;
    for (let t = 0; t < gs.size; t++) if (gs.isEnemy(t)) { er += gs.row(t); ec += gs.col(t); n++; }
    return n ? { r: er / n, c: ec / n } : null;
  }

  raidWalk(src) {
    const gs = this.gs;
    const goal = this.enemyGoalPoint();
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
        // 敌地绝对优先;其次朝敌将/敌重心方向推进(高手模式:直插腹地而非啃外围);代价最后
        const dGoal = goal ? Math.abs(gs.row(n) - goal.r) + Math.abs(gs.col(n) - goal.c) : 0;
        const score = (enemyTile ? 1000 : 0) - dGoal * P('DGOAL_W', 0.5) - cost; // 0.5=画像调参最优(3 时方向过猛,硬啃贵格)
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
    const SCOUT_MIN = P('SCOUT_MIN', 20);
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

    // 侦察代价:敌方 1 兵地是"尾迹线索"(对手扩张留下的 1 兵链往往通向其兵力库/老家),
    // 优先沿着走;大驻军敌地贵,别硬闯;城不穿。
    const scoutCost = (t) => {
      if (!gs.isPassable(t)) return Infinity;
      if (gs.isCity(t) && !gs.isMine(t)) return Infinity;
      if (gs.isMine(t)) return gs.armies[t] > 1 ? 0.5 : 1.0;
      if (gs.isEnemy(t)) return gs.armies[t] <= 1 ? 0.3 : 1 + gs.armies[t] * 0.3;
      return 1.0; // 迷雾/空地
    };
    // 目标:可达的"敌方一侧"格子(迷雾 -3 / 迷雾障碍 -4 / 敌格)中,沿该方向投影最深的
    const { prev, dist } = dijkstra(gs, src, scoutCost);
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
    // 大兵团出门侦察只带一半(is50):另一半留守原地,兼顾探路与防守——
    // 这是高手 is50 的典型用法(bot 此前完全没有这个动作)
    const split = gs.armies[src] >= P('SPLIT_MIN', 24);
    return this.planPath(buildPath(prev, target), 'scout', split);
  }

  // ---------- 队列管理 ----------

  planPath(path, purpose, is50First = false) {
    this.queue = [];
    for (let i = 0; i + 1 < path.length; i++) {
      this.queue.push({ from: path[i], to: path[i + 1] });
    }
    // 首步半推(is50):只带一半兵出发,另一半留在原地(高手每局约2.7次的分兵手法)
    if (is50First && this.queue.length) this.queue[0].is50 = true;
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
    // 开局(前25回合)对手的开局蛇常从 6~8 格外路过,并不是来打你——
    // 别为此掐掉自己的扩张波;只有真贴近(<=5)才回防。
    const DANGER_RADIUS = gs.turn < 50 ? 5 : 8;
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

  /**
   * 2~3 兵的小地一步扩一格:尾迹地每次翻倍后变成 2 兵,每块都能白捡一格新地
   * (1 步 = 1 地,效率极限)。这是"不同心圆"的核心——扩张由散布各处的
   * 小兵点开花,而不是一坨大军滚圆圈。大兵团留给蛇形长蛇/攻塔/进攻。
   */
  tryTrickle() {
    const gs = this.gs;
    const dir = this.expandDirection();
    let best = null;
    for (let t = 0; t < gs.size; t++) {
      if (!gs.isMine(t)) continue;
      const a = gs.armies[t];
      if (a < 2 || a > P('TRICKLE_MAX', 3)) continue; // 只用小兵点花,大兵团另有用途
      for (const n of gs.neighbors(t)) {
        if (!gs.isOpenLand(n)) continue; // 可见空地或平雾(-3 必无障碍)都算
        let opens = 0;
        for (const m of gs.neighbors(n)) if (gs.isOpenLand(m)) opens++;
        const toward = -(Math.abs(gs.row(n) - dir.r) + Math.abs(gs.col(n) - dir.c));
        const score = opens + 0.5 * toward;
        if (!best || score > best.score) best = { from: t, to: n, score };
      }
    }
    return best ? { from: best.from, to: best.to } : null;
  }

  tryExpand() {
    const gs = this.gs;

    // 0) 小兵开花(1步1地)
    const trickle = this.tryTrickle();
    if (trickle) return trickle;

    // 1) 前线蛇形连吃:选"兵最多、且紧邻可见空地"的前线地块,规划一条穿过空地的
    //    蛇形路径一次提交。用前线兵(而非全局最大兵团,后者常堆在内陆够不到边)。
    let frontier = -1, frontierArmy = 1;
    for (let t = 0; t < gs.size; t++) {
      if (!gs.isMine(t) || gs.armies[t] <= 1) continue;
      let touchesEmpty = false;
      for (const n of gs.neighbors(t)) {
        if (gs.isOpenLand(n)) { touchesEmpty = true; break; }
      }
      if (touchesEmpty && gs.armies[t] > frontierArmy) { frontierArmy = gs.armies[t]; frontier = t; }
    }
    if (frontier !== -1) {
      const walk = this.expansionWalk(frontier);
      if (walk.length >= 2) return this.planPath(walk, 'expand');
    }

    // 威胁当下压在家门口才停"派主力远征铺地";只是被摸到过≠不动(高手数据)。
    if (this.homeThreatNow) return null;

    // 2) 没有前线兵紧邻空地(兵都堆在内陆)→ 把最大兵团推向"附近"的空地。
    //    只吃近处便宜地(dist<=EXPAND_REACH):远处空地不值得让主力长途跋涉,
    //    否则兵力摊薄、无法集结斩首/防守——这正是"地多却被破家"的根因。
    const EXPAND_REACH = P('EXPAND_REACH', 8); // 8=画像调参最优(触角伸更远,贴近高手周长比)
    const src = this.biggestArmyTile([]);
    if (src === -1) return null;
    const { prev, dist } = dijkstra(gs, src, marchCost(gs));
    let target = -1, bd = Infinity;
    for (let t = 0; t < gs.size; t++) {
      if (gs.isOpenLand(t) && dist[t] <= EXPAND_REACH && dist[t] < bd) { bd = dist[t]; target = t; }
    }
    if (target === -1) return null;
    return this.planPath(buildPath(prev, target), 'expand');
  }

  // ---------- 4. 攻城 ----------

  tryCaptureCity(immediateOnly = false) {
    const gs = this.gs;
    const src = this.biggestArmyTile([]);
    if (src === -1) return null;

    const top = gs.enemyScores()[0];
    const myTotal = gs.myScore().total;

    // 时机规则(用户校准):
    //  - 对手的塔:兵力落后不超过 30 且吃得动 → 吃(既削他产兵又壮自己)。
    //  - 中立塔:只在"均势(兵力差 <10)且对手还没发现我家"时投资——
    //    投 40+ 兵进塔的窗口必须安全,家已暴露时投塔=给对手偷家窗口。
    const canEnemyCity = !top || myTotal >= top.total - 30;
    // 塔是手段不是目的:终极目的是斩首,塔为斩首供兵(拉锯战续航)。
    let enemyGenKnown = false;
    for (const [p] of gs.knownGenerals) {
      if (p === gs.playerIndex || gs.isTeammate(p)) continue;
      const s = gs.scores.find((x) => x.i === p);
      if (s && !s.dead) { enemyGenKnown = true; break; }
    }
    // 每回合增兵对比:将军/城各 +1,地块每 25 回合 +1。
    // 对手城数只能按已知的算(迷雾里的看不见),略有低估但方向正确。
    let myCities = 0, oppCities = 0;
    for (const c of gs.knownCities) {
      if (gs.isMine(c)) myCities++;
      else if (gs.isEnemy(c)) oppCities++;
    }
    const myIncome = 1 + myCities + gs.myScore().tiles / 25;
    const oppIncome = top ? 1 + oppCities + top.tiles / 25 : 0;
    const incomeBehind = top && oppIncome > myIncome;
    // 对手刚把 ~45 兵投进塔:此刻他没有进攻能力,是我们跟着打塔的安全窗口,
    // 常规门槛(均势/家暴露)一律豁免——不能让他白白拉开产能差。
    const oppJustBought = this.oppCityWindow !== undefined && gs.turn < this.oppCityWindow;

    // 中立塔按高手曲线配额(36局:t100≈0.86座,t150≈1.86,t200≈2.67):
    // 目标持城 = 1 + floor((回合-100)/50),t60 起开打。配额没满才追塔——
    // 高手是"按节奏补产能",不是逢塔必打(无配额时凑塔聚兵会挤掉一切,实测大退步)。
    const realT = gs.turn / 2;
    const cityTarget = realT < P('CITY_START', 55) ? 0 : 1 + Math.max(0, Math.floor((realT - 100) / P('CITY_STEP', 50)));
    const underQuota = myCities < cityTarget;
    const canNeutralCity = oppJustBought || (!this.homeThreatNow && underQuota);

    const eligible = (c) => (gs.isEnemy(c) ? canEnemyCity : canNeutralCity);

    const { prev, dist } = dijkstra(gs, src, marchCost(gs, { allowCity: true }));

    // 1) 立刻吃得下的城(只考虑看得见=驻军已知的):直接拿
    let best = null;
    for (const c of gs.knownCities) {
      if (gs.isMine(c) || !gs.isVisible(c) || !eligible(c)) continue;
      if (dist[c] === Infinity) continue;
      const need = gs.armies[c] + gs.dist(src, c) + 2;
      if (gs.armies[src] <= need) continue;
      const score = dist[c] + gs.armies[c] * 0.5; // 近 + 驻军少优先
      if (!best || score < best.score) best = { c, score };
    }
    if (best) return this.planPath(buildPath(prev, best.c), 'city');
    if (immediateOnly) return null; // 快速通道:只做"立刻吃得下"的顺手拿,不聚兵

    // 2) 差一点吃不下但城不远(<=8 格)且兵团已过 1/3:就地把散兵聚到主力,凑够再吃。
    //    门槛按高手数据放宽(高手首城中位 t89.5,我们此前 t148 就是凑得太磨蹭)。
    //    仍不做跨图长征聚兵——那是之前实测的退步做法。
    for (const c of gs.knownCities) {
      if (gs.isMine(c) || !gs.isVisible(c) || !eligible(c)) continue;
      if (dist[c] === Infinity || dist[c] > 8) continue;
      if (gs.armies[src] > gs.armies[c] * 0.35) {
        const mv = this.gatherToward(src);
        if (mv) return mv;
      }
    }
    return null;
  }

  // ---------- 5. 骚扰 / 蚕食 ----------

  tryHarass() {
    const gs = this.gs;
    const goal = this.enemyGoalPoint();
    // 用前线兵直接吃相邻的敌方弱格;同等收益优先选"更靠近敌将方向"的(直插不啃边)
    let best = null;
    for (let t = 0; t < gs.size; t++) {
      if (!gs.isMine(t) || gs.armies[t] <= 1) continue;
      for (const n of gs.neighbors(t)) {
        if (gs.isEnemy(n) && gs.armies[t] > gs.armies[n] + 1 && !gs.isCity(n)) {
          const gain = gs.armies[t] - gs.armies[n];
          const dGoal = goal ? Math.abs(gs.row(n) - goal.r) + Math.abs(gs.col(n) - goal.c) : 0;
          const score = gain - dGoal * P('HARASS_W', 1);
          if (!best || score > best.score) best = { from: t, to: n, score };
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

  /**
   * 向 target 集兵:选"性价比最高"的兵源——单位步数收到的兵最多,
   * 而不是无脑拖全图最大兵团跑长途(那样浪费大量步数)。
   * 路径本身也走 gatherCost(专挑富地、绕开 1 兵地)。
   */
  gatherToward(target) {
    const gs = this.gs;
    const gen = gs.myGeneral();
    // 从 target 反向建最短路树,一次算出所有兵源到 target 的收兵路径
    const { prev, dist } = dijkstra(gs, target, gatherCost(gs));
    let best = -1, bestEff = 0;
    for (let t = 0; t < gs.size; t++) {
      if (!gs.isMine(t) || t === target || t === gen) continue; // 不掏将军
      if (gs.armies[t] < 3) continue;                           // 太小的散兵不值得动
      if (dist[t] === Infinity) continue;
      const eff = (gs.armies[t] - 1) / (dist[t] + 1);           // 每步收兵数
      if (eff > bestEff) { bestEff = eff; best = t; }
    }
    if (best === -1) return null;
    const p = buildPath(prev, best); // [target ... best]
    p.reverse();                     // [best ... target]
    return this.planPath(p, 'gather');
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
        // 威胁当下在场:留够"挡住它"的守备量(威胁+5),盈余照常机动——
        // 高手被摸家时行动率不降,靠的就是"锁够用的,其余照打"。
        // 威胁不在场:中后期留一半,早期只留 1(开局要用将军兵扩张)。
        const reserve = this.homeThreatNow
          ? Math.max(this.homeThreatArmy + 5, Math.ceil(a * 0.5))
          : (gs.turn > 100 ? Math.ceil(a * 0.5) : 1);
        a = a - reserve;
      }
      if (a > bestA) { bestA = a; best = t; }
    }
    return best;
  }
}

module.exports = { Strategy };
