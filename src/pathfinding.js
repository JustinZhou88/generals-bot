'use strict';

/**
 * 寻路模块:带权 Dijkstra + BFS 距离场。
 * 权重设计是 bot 强度的关键之一:
 *   - 走自己的地块最便宜(顺路还能收编沿途兵力)
 *   - 空地次之
 *   - 敌方地块按其驻军加权(打穿要消耗兵力)
 *   - 城市额外加权(除非目标就是它)
 */

class MinHeap {
  constructor() { this.a = []; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].d <= a[i].d) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].d < a[m].d) m = l;
        if (r < a.length && a[r].d < a[m].d) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

/** 单点 Dijkstra,返回 { dist, prev },可用 buildPath 还原路径 */
function dijkstra(gs, source, costFn) {
  const dist = new Float64Array(gs.size).fill(Infinity);
  const prev = new Int32Array(gs.size).fill(-1);
  dist[source] = 0;
  const heap = new MinHeap();
  heap.push({ t: source, d: 0 });
  while (heap.size) {
    const { t, d } = heap.pop();
    if (d > dist[t]) continue;
    for (const n of gs.neighbors(t)) {
      const c = costFn(n);
      if (c === Infinity) continue;
      const nd = d + c;
      if (nd < dist[n]) {
        dist[n] = nd;
        prev[n] = t;
        heap.push({ t: n, d: nd });
      }
    }
  }
  return { dist, prev };
}

function buildPath(prev, target) {
  const path = [];
  let cur = target;
  while (cur !== -1) {
    path.push(cur);
    cur = prev[cur];
  }
  return path.reverse(); // [source, ..., target]
}

/** 默认行军代价 */
function marchCost(gs, opts = {}) {
  const { allowCity = false, target = -1 } = opts;
  return (t) => {
    if (!gs.isPassable(t)) return Infinity;
    let c = 1;
    // 己方地块:只有"有兵可收(>1)"才优待;1 兵地纯属过路、无收益,不再优待,
    // 避免为了贴着自己地走而绕远路、重复走。
    if (gs.isMine(t)) c = gs.armies[t] > 1 ? 0.5 : 1.0;
    else if (gs.isEnemy(t)) c = 1 + gs.armies[t] * 0.15; // 打穿敌地有代价
    if (gs.isCity(t) && t !== target && !gs.isMine(t)) {
      if (!allowCity) return Infinity;               // 默认绕开中立/敌方城
      c += gs.armies[t] * 0.3;
    }
    return c;
  };
}

/**
 * 集兵专用代价:调兵的目的是"越走兵越多",所以专挑兵多的己方地走(顺路收编),
 * 强烈避开 1 兵地(踩上去收不到兵还浪费步数,性价比极低)。
 */
function gatherCost(gs) {
  return (t) => {
    if (!gs.isPassable(t)) return Infinity;
    if (gs.isMine(t)) {
      const a = gs.armies[t];
      if (a <= 1) return 1.6;               // 1 兵地:收不到兵还浪费步数,强烈避开
      // 兵越多越便宜:6-8 兵的地是重点顺路收编对象,路径会主动拐过去扫
      return Math.max(0.15, 0.9 - a * 0.1); // 2兵→0.7  4兵→0.5  6兵→0.3  8兵+→0.15
    }
    if (gs.isEnemy(t)) return 2 + gs.armies[t] * 0.2;      // 集兵途中别去啃敌地
    if (gs.isCity(t)) return Infinity;
    return 1.3;                                            // 空地也不划算,尽量绕
  };
}

/** 从多个源点出发的 BFS 距离场(如:到我方边境的距离) */
function bfsDistance(gs, sources) {
  const dist = new Int32Array(gs.size).fill(-1);
  const q = [];
  for (const s of sources) { dist[s] = 0; q.push(s); }
  let head = 0;
  while (head < q.length) {
    const t = q[head++];
    for (const n of gs.neighbors(t)) {
      if (dist[n] === -1) {
        dist[n] = dist[t] + 1;
        q.push(n);
      }
    }
  }
  return dist;
}

module.exports = { dijkstra, buildPath, marchCost, gatherCost, bfsDistance };
