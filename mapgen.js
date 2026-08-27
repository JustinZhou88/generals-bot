'use strict';
/*
 * mapgen.js — 官方同分布的随机 1v1 地图生成器
 *
 * 为什么需要:arena.js 一直在复用那 28~81 张固定的回放地图。在固定地图集上
 * "每代更强"很容易变成对地图的记忆而非真实棋力,而真服每局都是新随机图。
 *
 * 做法:不猜参数,直接从 1804 局真实 1v1 语料拟合(replays/map_profile.json):
 *   尺寸    18~23 见方,按经验联合分布采样(36 种组合)
 *   山比例  经验分位数采样,均值 0.207,范围 0.155~0.261
 *   城数量  9~12(经验分布,均值 10.3),初始驻军 uniform[40,50]
 *   将距    曼哈顿距离按经验分布采样(最小 15,均值 19.7)
 *   连通性  两将必须互通,且互通区覆盖 ≥70% 非山格(拒绝重采)
 *
 * 产出对象可直接喂给 replays/Game.js 的 createFromReplay。
 */

const fs = require('fs');
const path = require('path');

const PROFILE = JSON.parse(fs.readFileSync(path.join(__dirname, 'replays', 'map_profile.json'), 'utf8'));

/** 从 {值: 次数} 直方图里按频率采样 */
function sampleHist(hist, rng) {
  let total = 0;
  for (const k in hist) total += hist[k];
  let r = rng() * total;
  for (const k in hist) { r -= hist[k]; if (r <= 0) return k; }
  return Object.keys(hist)[0];
}

/** mulberry32 —— 固定种子可复现 */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从山集合出发做四邻连通标记 */
function floodFrom(start, W, H, blocked) {
  const size = W * H;
  const seen = new Uint8Array(size);
  const stack = [start];
  seen[start] = 1;
  let count = 1;
  while (stack.length) {
    const t = stack.pop();
    const r = (t / W) | 0, c = t % W;
    const ns = [];
    if (r > 0) ns.push(t - W);
    if (r < H - 1) ns.push(t + W);
    if (c > 0) ns.push(t - 1);
    if (c < W - 1) ns.push(t + 1);
    for (const n of ns) {
      if (seen[n] || blocked[n]) continue;
      seen[n] = 1; count++; stack.push(n);
    }
  }
  return { seen, count };
}

/**
 * 生成一张随机 1v1 地图。
 * @param {number} seed 随机种子(同一 seed 必得同一张图)
 * @returns replay 形状的对象,可直接 Game.createFromReplay
 */
function generateMap(seed) {
  const rng = mulberry32(seed >>> 0);
  const qs = PROFILE.mountainRatio.quantiles;

  for (let attempt = 0; attempt < 200; attempt++) {
    const [W, H] = sampleHist(PROFILE.dims, rng).split(',').map(Number);
    const size = W * H;

    // 山:按经验分位数插值采样比例
    const u = rng() * (qs.length - 1);
    const lo = Math.floor(u), hi = Math.min(qs.length - 1, lo + 1);
    const mtnRatio = qs[lo] + (qs[hi] - qs[lo]) * (u - lo);
    const nMtn = Math.round(mtnRatio * size);
    const nCity = parseInt(sampleHist(PROFILE.cityCount, rng), 10);
    const targetGenD = parseInt(sampleHist(PROFILE.genDist, rng), 10);

    // 随机撒山
    const blocked = new Uint8Array(size);
    const mountains = [];
    const order = Array.from({ length: size }, (_, i) => i);
    for (let i = size - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const t = order[i]; order[i] = order[j]; order[j] = t; }
    for (let i = 0; i < nMtn; i++) { const t = order[i]; blocked[t] = 1; mountains.push(t); }

    // 城:落在非山格上(城不阻断通行,但初期是障碍)
    const cities = [], cityArmies = [];
    const free = order.slice(nMtn);
    for (let i = 0; i < nCity && i < free.length; i++) {
      cities.push(free[i]);
      cityArmies.push(PROFILE.cityArmy.min + ((rng() * (PROFILE.cityArmy.max - PROFILE.cityArmy.min + 1)) | 0));
    }
    const citySet = new Set(cities);

    // 将军候选:非山、非城
    const cand = free.slice(cities.length);
    if (cand.length < 2) continue;

    // 连通性:以任一候选格为起点洪泛,要求覆盖 ≥70% 非山格
    const { seen, count } = floodFrom(cand[0], W, H, blocked);
    if (count < (size - nMtn) * 0.7) continue;

    // 在连通区内挑一对满足目标距离的将军位(允许 ±2 容差,逐步放宽)
    const pool = cand.filter((t) => seen[t] && !citySet.has(t));
    if (pool.length < 2) continue;
    let g1 = -1, g2 = -1;
    for (let tol = 0; tol <= 4 && g1 < 0; tol++) {
      for (let tries = 0; tries < 400; tries++) {
        const a = pool[(rng() * pool.length) | 0];
        const b = pool[(rng() * pool.length) | 0];
        if (a === b) continue;
        const d = Math.abs(((a / W) | 0) - ((b / W) | 0)) + Math.abs((a % W) - (b % W));
        if (d >= 15 && Math.abs(d - targetGenD) <= tol) { g1 = a; g2 = b; break; }
      }
    }
    if (g1 < 0) continue;

    return {
      version: 19,
      id: 'gen' + seed,
      mapWidth: W,
      mapHeight: H,
      usernames: ['A', 'B'],
      stars: [0, 0],
      cities,
      cityArmies,
      generals: [g1, g2],
      mountains,
      moves: [],
      afks: [],
      teams: undefined,
      map_title: '',
    };
  }
  throw new Error('地图生成失败(200 次采样均不满足约束),seed=' + seed);
}

/** 批量生成 n 张图,种子确定 ⇒ 结果可复现 */
function generateMaps(n, baseSeed = 1) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(generateMap(baseSeed + i * 7919));
  return out;
}

module.exports = { generateMap, generateMaps };

// 自检:生成一批图并把统计和真实语料对照
if (require.main === module) {
  const n = parseInt(process.argv[2] || '2000', 10);
  const maps = generateMaps(n, 12345);
  const W = [], mtn = [], city = [], gd = [], carm = [];
  for (const m of maps) {
    const size = m.mapWidth * m.mapHeight;
    W.push(size);
    mtn.push(m.mountains.length / size);
    city.push(m.cities.length);
    for (const a of m.cityArmies) carm.push(a);
    const [a, b] = m.generals;
    gd.push(Math.abs(((a / m.mapWidth) | 0) - ((b / m.mapWidth) | 0)) + Math.abs((a % m.mapWidth) - (b % m.mapWidth)));
  }
  const mean = (x) => x.reduce((p, q) => p + q, 0) / x.length;
  console.log(`生成 ${n} 张图`);
  console.log(`  面积     均值 ${mean(W).toFixed(1)}   (语料 385.1)`);
  console.log(`  山比例   均值 ${mean(mtn).toFixed(4)}  (语料 0.2070)`);
  console.log(`  城数量   均值 ${mean(city).toFixed(2)}    (语料 10.29)`);
  console.log(`  城驻军   均值 ${mean(carm).toFixed(2)}    (语料 44.99)`);
  console.log(`  双将距   均值 ${mean(gd).toFixed(2)}    (语料 19.68)`);
}
