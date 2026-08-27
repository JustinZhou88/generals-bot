#!/usr/bin/env node
'use strict';
/*
 * 走子排序器 v3 —— 非线性 MLP(纯 JS,零依赖)。
 *
 * 动机:v2 是条件 logit(线性)。线性打分器无法表达"条件行为" —— 例如
 * "兵够才靠近城、兵不够就绕开"必须靠手搓交互特征(f26/f31/f32)才能表达,
 * 每多一种条件就得手搓一个特征。MLP 让这些交互自己长出来。
 *
 * 模型: score(x) = b + wlin·x + v·tanh(W1 x + b1)
 *   保留线性直连通路(wlin),既稳定训练,也保证至少不弱于 v2 的表达能力。
 * 损失: 每个决策点在候选集上 softmax,-log P(专家所选)。与 v2 完全同口径。
 * 优化: Adam + mini-batch(决策点为单位) + 在 heldout 上早停。
 *
 * 数据: dataset2.jsonl / heldout2.jsonl,每行 {g,t,c:[[32 floats],...],y}
 *       末位候选恒为"不动"伪候选(f25=1)。
 * 输出: model3.json {type:'mlp', feat, H, wlin, b, W1, b1, v}
 *
 * 用法: node train3.js [--hidden 24] [--epochs 12] [--lr 0.002] [--seed 7]
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const TRAIN = path.join(DIR, process.env.TRAIN_FILE || 'dataset2.jsonl');
const HELD = path.join(DIR, process.env.HELD_FILE || 'heldout2.jsonl');
const OUT = path.join(DIR, 'model3.json');

const FEAT = 32;

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { hidden: 24, epochs: 12, lr: 0.002, seed: 7, batch: 32, l2: 1e-6 };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--hidden') o.hidden = +a[++i];
    else if (a[i] === '--epochs') o.epochs = +a[++i];
    else if (a[i] === '--lr') o.lr = +a[++i];
    else if (a[i] === '--seed') o.seed = +a[++i];
    else if (a[i] === '--batch') o.batch = +a[++i];
    else if (a[i] === '--l2') o.l2 = +a[++i];
    else if (a[i] === '--out') o.out = a[++i];
  }
  return o;
}
const OPT = parseArgs();
const H = OPT.hidden;
const MODEL_OUT = OPT.out ? path.join(DIR, OPT.out) : OUT;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 流式载入并打包成 TypedArray(之后每个 epoch 零解析开销) ----------
// 注:dataset2.jsonl 有 546MiB,超过 V8 单字符串上限,不能 readFileSync('utf8');
// 且每个决策点平均约 55 个候选(共约 600 万),不能先堆成 JS 数组再打包。
// 因此这里边读边直接写进可增长的 Float32Array。
function load(file) {
  const starts = [], counts = [], ys = [];
  let X = new Float32Array(1 << 22); // 4M floats 起步,不够则翻倍
  let used = 0, total = 0, maxCands = 0;

  const fd = fs.openSync(file, 'r');
  const CHUNK = 1 << 22;
  const buf = Buffer.allocUnsafe(CHUNK);
  let rem = '';
  const handleLine = (line) => {
    if (line.length < 2) return;
    const ex = JSON.parse(line);
    const m = ex.c.length;
    if (m > maxCands) maxCands = m;
    starts.push(total); counts.push(m); ys.push(ex.y);
    const need = used + m * FEAT;
    if (need > X.length) {
      let cap = X.length;
      while (cap < need) cap *= 2;
      const nx = new Float32Array(cap);
      nx.set(X.subarray(0, used));
      X = nx;
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
    let start = 0, idx;
    while ((idx = data.indexOf('\n', start)) !== -1) { handleLine(data.slice(start, idx)); start = idx + 1; }
    rem = data.slice(start);
  }
  fs.closeSync(fd);
  if (rem.length > 1) handleLine(rem);

  return {
    X, starts: Int32Array.from(starts), counts: Int32Array.from(counts),
    y: Int32Array.from(ys), n: starts.length, totalCands: total, maxCands,
  };
}

// ---------- 参数 ----------
const rng = mulberry32(OPT.seed);
const gauss = () => { // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const W1 = new Float64Array(H * FEAT);
const b1 = new Float64Array(H);
const v = new Float64Array(H);
const wlin = new Float64Array(FEAT);
let b = 0;
{
  const s1 = Math.sqrt(2 / FEAT), sv = Math.sqrt(1 / H);
  for (let i = 0; i < W1.length; i++) W1[i] = gauss() * s1;
  for (let h = 0; h < H; h++) v[h] = gauss() * sv;
}

// Adam 状态
const mk = (n) => ({ m: new Float64Array(n), s: new Float64Array(n) });
const AD = { W1: mk(W1.length), b1: mk(H), v: mk(H), wlin: mk(FEAT), b: mk(1) };
let adamT = 0;
const B1 = 0.9, B2 = 0.999, EPS = 1e-8;

function adamStep(param, grad, st, lr) {
  adamT++;
  const bc1 = 1 - Math.pow(B1, adamT), bc2 = 1 - Math.pow(B2, adamT);
  for (let i = 0; i < param.length; i++) {
    const g = grad[i] + OPT.l2 * param[i];
    st.m[i] = B1 * st.m[i] + (1 - B1) * g;
    st.s[i] = B2 * st.s[i] + (1 - B2) * g * g;
    param[i] -= lr * (st.m[i] / bc1) / (Math.sqrt(st.s[i] / bc2) + EPS);
    grad[i] = 0;
  }
}

// ---------- 前向 ----------
const zbuf = new Float64Array(H);
const tbuf = new Float64Array(H);
function scoreOne(X, off, tanhOut) {
  let s = b;
  for (let k = 0; k < FEAT; k++) s += wlin[k] * X[off + k];
  for (let h = 0; h < H; h++) {
    let z = b1[h];
    const base = h * FEAT;
    for (let k = 0; k < FEAT; k++) z += W1[base + k] * X[off + k];
    const t = Math.tanh(z);
    if (tanhOut) tanhOut[h] = t;
    s += v[h] * t;
  }
  return s;
}

// ---------- 训练 ----------
const gW1 = new Float64Array(W1.length), gb1 = new Float64Array(H);
const gv = new Float64Array(H), gwlin = new Float64Array(FEAT), gb = new Float64Array(1);
let TANH = [];
function ensureCands(m) { while (TANH.length < m) TANH.push(new Float64Array(H)); }

function trainEpoch(data, order, lr) {
  let lossSum = 0, cnt = 0, inBatch = 0;
  ensureCands(data.maxCands);
  const scores = new Float64Array(data.maxCands);
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    const st = data.starts[i], m = data.counts[i], y = data.y[i];
    let mx = -Infinity;
    for (let j = 0; j < m; j++) {
      scores[j] = scoreOne(data.X, (st + j) * FEAT, TANH[j]);
      if (scores[j] > mx) mx = scores[j];
    }
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
        const dz = g * v[h] * (1 - th[h] * th[h]);
        if (dz === 0) continue;
        gb1[h] += dz;
        const base = h * FEAT;
        for (let k = 0; k < FEAT; k++) gW1[base + k] += dz * data.X[off + k];
      }
    }

    if (++inBatch >= OPT.batch) {
      const scale = 1 / inBatch;
      for (let k = 0; k < gW1.length; k++) gW1[k] *= scale;
      for (let k = 0; k < H; k++) { gb1[k] *= scale; gv[k] *= scale; }
      for (let k = 0; k < FEAT; k++) gwlin[k] *= scale;
      gb[0] *= scale;
      const t0 = adamT;
      adamStep(W1, gW1, AD.W1, lr); adamT = t0;
      adamStep(b1, gb1, AD.b1, lr); adamT = t0;
      adamStep(v, gv, AD.v, lr); adamT = t0;
      adamStep(wlin, gwlin, AD.wlin, lr); adamT = t0;
      const bArr = [b];
      adamStep(bArr, gb, AD.b, lr);
      b = bArr[0];
      inBatch = 0;
    }
  }
  return lossSum / cnt;
}

// ---------- 评估(口径与 train2.js 完全一致:平分 tie-break 的期望命中) ----------
function evaluate(data) {
  let n = 0, top1 = 0, top3 = 0, nll = 0;
  let nReal = 0, t1Real = 0, nIdle = 0, t1Idle = 0, pauseFalse = 0;
  const scores = new Float64Array(data.maxCands);
  for (let i = 0; i < data.n; i++) {
    const st = data.starts[i], m = data.counts[i], y = data.y[i];
    const pauseIdx = m - 1;
    let mx = -Infinity;
    for (let j = 0; j < m; j++) { scores[j] = scoreOne(data.X, (st + j) * FEAT, null); if (scores[j] > mx) mx = scores[j]; }
    let Z = 0;
    for (let j = 0; j < m; j++) Z += Math.exp(scores[j] - mx);
    nll += -Math.log(Math.max(Math.exp(scores[y] - mx) / Z, 1e-12));
    const expHit = (ref, k) => {
      let G = 0, E = 0;
      for (let j = 0; j < m; j++) { if (scores[j] > ref) G++; else if (scores[j] === ref) E++; }
      return Math.min(Math.max((k - G) / E, 0), 1);
    };
    const h1 = expHit(scores[y], 1), h3 = expHit(scores[y], 3);
    top1 += h1; top3 += h3; n++;
    if (y === pauseIdx) { nIdle++; t1Idle += h1; }
    else { nReal++; t1Real += h1; pauseFalse += expHit(scores[pauseIdx], 1); }
  }
  return {
    n, top1: top1 / n, top3: top3 / n, nll: nll / n,
    top1Real: t1Real / nReal, pauseRecall: t1Idle / nIdle, pauseFalse: pauseFalse / nReal,
    nReal, nIdle,
  };
}

function snapshot() {
  return {
    type: 'mlp', feat: FEAT, H,
    wlin: Array.from(wlin, (x) => +x.toFixed(6)),
    b: +b.toFixed(6),
    W1: Array.from(W1, (x) => +x.toFixed(6)),
    b1: Array.from(b1, (x) => +x.toFixed(6)),
    v: Array.from(v, (x) => +x.toFixed(6)),
  };
}
function restore(sn) {
  for (let i = 0; i < W1.length; i++) W1[i] = sn.W1[i];
  for (let i = 0; i < H; i++) { b1[i] = sn.b1[i]; v[i] = sn.v[i]; }
  for (let i = 0; i < FEAT; i++) wlin[i] = sn.wlin[i];
  b = sn.b;
}

(function main() {
  const t0 = Date.now();
  console.log(`载入数据…`);
  const tr = load(TRAIN);
  const he = load(HELD);
  console.log(`训练 ${tr.n} 决策点(${tr.totalCands} 候选,最多 ${tr.maxCands}/点) / 留出 ${he.n} 决策点;隐层 H=${H},lr=${OPT.lr},batch=${OPT.batch},epochs=${OPT.epochs}`);

  const order = Int32Array.from({ length: tr.n }, (_, i) => i);
  let best = null, bestTop1 = -1, bestEpoch = 0, since = 0;

  for (let e = 1; e <= OPT.epochs; e++) {
    for (let i = tr.n - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const t = order[i]; order[i] = order[j]; order[j] = t; }
    const lr = OPT.lr * (1 - 0.7 * (e - 1) / Math.max(1, OPT.epochs - 1)); // 线性衰减到 30%
    const te = Date.now();
    const trLoss = trainEpoch(tr, order, lr);
    const ev = evaluate(he);
    const mark = ev.top1 > bestTop1 ? ' *' : '';
    console.log(`epoch ${String(e).padStart(2)}/${OPT.epochs}  训练NLL=${trLoss.toFixed(4)}  留出NLL=${ev.nll.toFixed(4)}  ` +
      `top1=${(ev.top1 * 100).toFixed(2)}%  top3=${(ev.top3 * 100).toFixed(2)}%  (${((Date.now() - te) / 1000).toFixed(1)}s)${mark}`);
    if (ev.top1 > bestTop1) { bestTop1 = ev.top1; best = snapshot(); bestEpoch = e; since = 0; }
    else if (++since >= 3) { console.log(`留出 top1 连续 ${since} 轮未提升,早停。`); break; }
  }

  restore(best);
  fs.writeFileSync(MODEL_OUT, JSON.stringify(best));
  const ev = evaluate(he);
  console.log(`\n最佳模型来自 epoch ${bestEpoch},已写入 ${path.basename(MODEL_OUT)}`);
  console.log(`留出集 ${ev.n} 点(真实 ${ev.nReal} / 空转 ${ev.nIdle}):`);
  console.log(`  top1 = ${(ev.top1 * 100).toFixed(2)}%      (v2 基线 54.08%)`);
  console.log(`  top3 = ${(ev.top3 * 100).toFixed(2)}%      (v2 基线 74.96%)`);
  console.log(`  真实点 top1 = ${(ev.top1Real * 100).toFixed(2)}%`);
  console.log(`  空转召回 = ${(ev.pauseRecall * 100).toFixed(2)}%   真实点误判不动 = ${(ev.pauseFalse * 100).toFixed(2)}%`);
  console.log(`总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})();
