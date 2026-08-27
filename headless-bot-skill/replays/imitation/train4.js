#!/usr/bin/env node
'use strict';
/*
 * 走子排序器 v4 —— 分局势拟合(按对局阶段分桶,每桶一个 MLP)。
 *
 * 动机(用户提出):现在是一个全局模型,不管开局、中盘、还是残局都用同一套权重,
 * 而高手在不同局势下的选择差别很大 —— 平均出来的模型会把这些差别抹平。
 * v25 当时靠手搓交互特征(城×够不够吃、后半周期×敌格)去凑条件行为,那是治标。
 *
 * 分桶依据(先量了样本量再定的):
 *   早 t<100 半回合(<50 真实回合)  30181 决策点
 *   中 100<=t<300                  57225
 *   晚 t>=300                       26237
 * 本来还想按"占优/劣势"再细分,但早期几乎全是均势(占优 381、劣势 50),
 * 样本撑不住;优劣势交给桶内 MLP 用 f20(兵力份额)自己学。
 *
 * 模型: 每桶 score(x) = b + wlin·x + v·tanh(W1 x + b1),与 train3 同构同口径。
 * 输出: model4.json = { type:'bucketed', feat, H, buckets:[{maxTurn, ...权重}] }
 *
 * 用法: node train4.js [--hidden 32] [--epochs 12] [--lr 0.002]
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const TRAIN = path.join(DIR, 'dataset2.jsonl');
const HELD = path.join(DIR, 'heldout2.jsonl');
const OUT = path.join(DIR, 'model4.json');

const FEAT = 32;

// 分桶边界(半回合)。t < maxTurn 落入该桶,最后一桶 Infinity 兜底。
const BUCKETS = [
  { name: '早(<50回合)', maxTurn: 100 },
  { name: '中(50~150回合)', maxTurn: 300 },
  { name: '晚(>150回合)', maxTurn: Infinity },
];

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { hidden: 32, epochs: 12, lr: 0.002, seed: 7, batch: 32, l2: 1e-6 };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--hidden') o.hidden = +a[++i];
    else if (a[i] === '--epochs') o.epochs = +a[++i];
    else if (a[i] === '--lr') o.lr = +a[++i];
    else if (a[i] === '--seed') o.seed = +a[++i];
    else if (a[i] === '--batch') o.batch = +a[++i];
    else if (a[i] === '--l2') o.l2 = +a[++i];
  }
  return o;
}
const OPT = parseArgs();
const H = OPT.hidden;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 流式载入并打包(见 train3.js 的说明:文件 546MiB,不能整读) */
function load(file) {
  const starts = [], counts = [], ys = [], turns = [];
  let X = new Float32Array(1 << 22);
  let used = 0, total = 0, maxCands = 0;
  const fd = fs.openSync(file, 'r');
  const CHUNK = 1 << 22;
  const buf = Buffer.allocUnsafe(CHUNK);
  let rem = '';
  const handle = (line) => {
    if (line.length < 2) return;
    const ex = JSON.parse(line);
    const m = ex.c.length;
    if (m > maxCands) maxCands = m;
    starts.push(total); counts.push(m); ys.push(ex.y); turns.push(ex.t);
    const need = used + m * FEAT;
    if (need > X.length) {
      let cap = X.length;
      while (cap < need) cap *= 2;
      const nx = new Float32Array(cap); nx.set(X.subarray(0, used)); X = nx;
    }
    for (const cand of ex.c) {
      for (let k = 0; k < FEAT; k++) X[used + k] = cand[k];
      used += FEAT;
    }
    total += m;
  };
  let bytes;
  while ((bytes = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) {
    const data = rem + buf.toString('utf8', 0, bytes);
    let st = 0, i;
    while ((i = data.indexOf('\n', st)) !== -1) { handle(data.slice(st, i)); st = i + 1; }
    rem = data.slice(st);
  }
  fs.closeSync(fd);
  if (rem.length > 1) handle(rem);
  return {
    X, starts: Int32Array.from(starts), counts: Int32Array.from(counts),
    y: Int32Array.from(ys), turn: Int32Array.from(turns), n: starts.length, maxCands,
  };
}

function bucketOf(turn) {
  for (let b = 0; b < BUCKETS.length; b++) if (turn < BUCKETS[b].maxTurn) return b;
  return BUCKETS.length - 1;
}

/** 一个桶的模型 + 训练/评估(结构与 train3 完全一致,便于横向比较) */
function makeModel(rng) {
  const W1 = new Float64Array(H * FEAT), b1 = new Float64Array(H);
  const v = new Float64Array(H), wlin = new Float64Array(FEAT);
  const gauss = () => {
    let u = 0, w = 0;
    while (u === 0) u = rng(); while (w === 0) w = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
  };
  const s1 = Math.sqrt(2 / FEAT), sv = Math.sqrt(1 / H);
  for (let i = 0; i < W1.length; i++) W1[i] = gauss() * s1;
  for (let h = 0; h < H; h++) v[h] = gauss() * sv;
  return { W1, b1, v, wlin, b: 0 };
}

function trainBucket(M, data, idxs, label) {
  const mk = (n) => ({ m: new Float64Array(n), s: new Float64Array(n) });
  const AD = { W1: mk(M.W1.length), b1: mk(H), v: mk(H), wlin: mk(FEAT), b: mk(1) };
  let adamT = 0;
  const B1 = 0.9, B2 = 0.999, EPS = 1e-8;
  const gW1 = new Float64Array(M.W1.length), gb1 = new Float64Array(H);
  const gv = new Float64Array(H), gwlin = new Float64Array(FEAT), gb = new Float64Array(1);
  const TANH = []; for (let i = 0; i < data.maxCands; i++) TANH.push(new Float64Array(H));
  const scores = new Float64Array(data.maxCands);
  const rng = mulberry32(OPT.seed + 17);

  const scoreOne = (off, tanhOut) => {
    let s = M.b;
    for (let k = 0; k < FEAT; k++) s += M.wlin[k] * data.X[off + k];
    for (let h = 0; h < H; h++) {
      let z = M.b1[h];
      const base = h * FEAT;
      for (let k = 0; k < FEAT; k++) z += M.W1[base + k] * data.X[off + k];
      const t = Math.tanh(z);
      if (tanhOut) tanhOut[h] = t;
      s += M.v[h] * t;
    }
    return s;
  };
  M._score = scoreOne;

  const adam = (param, grad, st, lr) => {
    adamT++;
    const bc1 = 1 - Math.pow(B1, adamT), bc2 = 1 - Math.pow(B2, adamT);
    for (let i = 0; i < param.length; i++) {
      const g = grad[i] + OPT.l2 * param[i];
      st.m[i] = B1 * st.m[i] + (1 - B1) * g;
      st.s[i] = B2 * st.s[i] + (1 - B2) * g * g;
      param[i] -= lr * (st.m[i] / bc1) / (Math.sqrt(st.s[i] / bc2) + EPS);
      grad[i] = 0;
    }
  };

  const order = Int32Array.from(idxs);
  let best = null, bestLoss = Infinity, since = 0;
  for (let e = 1; e <= OPT.epochs; e++) {
    for (let i = order.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const t = order[i]; order[i] = order[j]; order[j] = t; }
    const lr = OPT.lr * (1 - 0.7 * (e - 1) / Math.max(1, OPT.epochs - 1));
    let lossSum = 0, cnt = 0, inBatch = 0;
    for (let oi = 0; oi < order.length; oi++) {
      const i = order[oi];
      const st = data.starts[i], m = data.counts[i], y = data.y[i];
      let mx = -Infinity;
      for (let j = 0; j < m; j++) { scores[j] = scoreOne((st + j) * FEAT, TANH[j]); if (scores[j] > mx) mx = scores[j]; }
      let Z = 0;
      for (let j = 0; j < m; j++) { scores[j] = Math.exp(scores[j] - mx); Z += scores[j]; }
      lossSum += -Math.log(Math.max(scores[y] / Z, 1e-12)); cnt++;
      for (let j = 0; j < m; j++) {
        const g = scores[j] / Z - (j === y ? 1 : 0);
        if (g === 0) continue;
        const off = (st + j) * FEAT;
        for (let k = 0; k < FEAT; k++) gwlin[k] += g * data.X[off + k];
        gb[0] += g;
        const th = TANH[j];
        for (let h = 0; h < H; h++) {
          gv[h] += g * th[h];
          const dz = g * M.v[h] * (1 - th[h] * th[h]);
          if (dz === 0) continue;
          gb1[h] += dz;
          const base = h * FEAT;
          for (let k = 0; k < FEAT; k++) gW1[base + k] += dz * data.X[off + k];
        }
      }
      if (++inBatch >= OPT.batch) {
        const sc = 1 / inBatch;
        for (let k = 0; k < gW1.length; k++) gW1[k] *= sc;
        for (let k = 0; k < H; k++) { gb1[k] *= sc; gv[k] *= sc; }
        for (let k = 0; k < FEAT; k++) gwlin[k] *= sc;
        gb[0] *= sc;
        const t0 = adamT;
        adam(M.W1, gW1, AD.W1, lr); adamT = t0;
        adam(M.b1, gb1, AD.b1, lr); adamT = t0;
        adam(M.v, gv, AD.v, lr); adamT = t0;
        adam(M.wlin, gwlin, AD.wlin, lr); adamT = t0;
        const bArr = [M.b]; adam(bArr, gb, AD.b, lr); M.b = bArr[0];
        inBatch = 0;
      }
    }
    const avg = lossSum / cnt;
    if (avg < bestLoss - 1e-4) {
      bestLoss = avg; since = 0;
      best = { W1: Float64Array.from(M.W1), b1: Float64Array.from(M.b1), v: Float64Array.from(M.v), wlin: Float64Array.from(M.wlin), b: M.b };
    } else if (++since >= 3) break;
    if (e % 4 === 0 || e === OPT.epochs) console.log(`    ${label} epoch ${e}: 训练NLL=${avg.toFixed(4)}`);
  }
  if (best) { M.W1.set(best.W1); M.b1.set(best.b1); M.v.set(best.v); M.wlin.set(best.wlin); M.b = best.b; }
}

/** 用一组"按桶选模型"的规则在留出集上评估 */
function evaluate(models, data, single) {
  const scores = new Float64Array(data.maxCands);
  let n = 0, top1 = 0, top3 = 0;
  const perB = BUCKETS.map(() => ({ n: 0, t1: 0 }));
  for (let i = 0; i < data.n; i++) {
    const b = bucketOf(data.turn[i]);
    const M = single || models[b];
    const st = data.starts[i], m = data.counts[i], y = data.y[i];
    let mx = -Infinity;
    for (let j = 0; j < m; j++) {
      let s = M.b;
      const off = (st + j) * FEAT;
      for (let k = 0; k < FEAT; k++) s += M.wlin[k] * data.X[off + k];
      for (let h = 0; h < H; h++) {
        let z = M.b1[h];
        const base = h * FEAT;
        for (let k = 0; k < FEAT; k++) z += M.W1[base + k] * data.X[off + k];
        s += M.v[h] * Math.tanh(z);
      }
      scores[j] = s; if (s > mx) mx = s;
    }
    const expHit = (ref, k) => {
      let G = 0, E = 0;
      for (let j = 0; j < m; j++) { if (scores[j] > ref) G++; else if (scores[j] === ref) E++; }
      return Math.min(Math.max((k - G) / E, 0), 1);
    };
    const h1 = expHit(scores[y], 1);
    top1 += h1; top3 += expHit(scores[y], 3); n++;
    perB[b].n++; perB[b].t1 += h1;
  }
  return { top1: top1 / n, top3: top3 / n, perB };
}

(function main() {
  const t0 = Date.now();
  console.log('载入数据…');
  const tr = load(TRAIN), he = load(HELD);
  console.log(`训练 ${tr.n} 决策点 / 留出 ${he.n};隐层 H=${H}`);

  const idxs = BUCKETS.map(() => []);
  for (let i = 0; i < tr.n; i++) idxs[bucketOf(tr.turn[i])].push(i);
  BUCKETS.forEach((b, i) => console.log(`  ${b.name}: ${idxs[i].length} 决策点`));

  const rng = mulberry32(OPT.seed);
  const models = BUCKETS.map(() => makeModel(rng));
  BUCKETS.forEach((b, i) => {
    console.log(`\n训练 ${b.name} …`);
    trainBucket(models[i], tr, idxs[i], b.name);
  });

  const ev = evaluate(models, he);
  console.log(`\n分桶模型 留出集: top1 = ${(ev.top1 * 100).toFixed(2)}%   top3 = ${(ev.top3 * 100).toFixed(2)}%   (全局 MLP 基线 59.64% / 77.49%)`);
  BUCKETS.forEach((b, i) => {
    const p = ev.perB[i];
    console.log(`    ${b.name.padEnd(16)} ${p.n} 点   top1 ${(p.t1 / p.n * 100).toFixed(2)}%`);
  });

  fs.writeFileSync(OUT, JSON.stringify({
    type: 'bucketed', feat: FEAT, H,
    buckets: BUCKETS.map((b, i) => ({
      name: b.name,
      maxTurn: b.maxTurn === Infinity ? null : b.maxTurn,
      wlin: Array.from(models[i].wlin, (x) => +x.toFixed(6)),
      b: +models[i].b.toFixed(6),
      W1: Array.from(models[i].W1, (x) => +x.toFixed(6)),
      b1: Array.from(models[i].b1, (x) => +x.toFixed(6)),
      v: Array.from(models[i].v, (x) => +x.toFixed(6)),
    })),
  }));
  console.log(`\n已写入 ${path.basename(OUT)}   总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})();
