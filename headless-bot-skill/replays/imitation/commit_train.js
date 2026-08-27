#!/usr/bin/env node
'use strict';
/*
 * commit_train.js — 训练"此刻该不该出击"的局面判断器
 *
 * 对照的是 bot 现在写死的那条规则:phase >= 34(翻倍前 8 个真实回合就出击)。
 * 语料统计显示进攻率确实按 25 回合周期起伏(翻倍前 7.5 回合达到 45.4% 峰值),
 * 但**即使在峰值也只有 45%** —— 剩下的取决于局面。这个模型就是要学那部分。
 *
 * 模型: score = b + w·x + v·tanh(W1 x + b1),sigmoid 输出概率(与走子模型同构)。
 * 评估: 与"相位规则"基线对比 AUC / 准确率 / F1,证明学出来的判断确实更好。
 * 输出: commit_model.json
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const TRAIN = path.join(DIR, 'commit_train.jsonl');
const HELD = path.join(DIR, 'commit_heldout.jsonl');
const OUT = path.join(DIR, 'commit_model.json');
const FEAT = 14;

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { hidden: 16, epochs: 30, lr: 0.01, seed: 11, batch: 64, l2: 1e-5 };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--hidden') o.hidden = +a[++i];
    else if (a[i] === '--epochs') o.epochs = +a[++i];
    else if (a[i] === '--lr') o.lr = +a[++i];
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
const rng = mulberry32(OPT.seed);
const gauss = () => {
  let u = 0, v = 0;
  while (u === 0) u = rng(); while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

function load(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const xs = [], ys = [], ts = [];
  for (const l of lines) {
    if (l.length < 2) continue;
    const o = JSON.parse(l);
    xs.push(o.x); ys.push(o.y); ts.push(o.t);
  }
  const X = new Float32Array(xs.length * FEAT);
  for (let i = 0; i < xs.length; i++) for (let k = 0; k < FEAT; k++) X[i * FEAT + k] = xs[i][k];
  return { X, y: Int8Array.from(ys), t: Int32Array.from(ts), n: xs.length };
}

const W1 = new Float64Array(H * FEAT), b1 = new Float64Array(H);
const v = new Float64Array(H), w = new Float64Array(FEAT);
let b = 0;
{
  const s1 = Math.sqrt(2 / FEAT), sv = Math.sqrt(1 / H);
  for (let i = 0; i < W1.length; i++) W1[i] = gauss() * s1;
  for (let h = 0; h < H; h++) v[h] = gauss() * sv;
}
const th = new Float64Array(H);
function score(X, off) {
  let s = b;
  for (let k = 0; k < FEAT; k++) s += w[k] * X[off + k];
  for (let h = 0; h < H; h++) {
    let z = b1[h];
    const base = h * FEAT;
    for (let k = 0; k < FEAT; k++) z += W1[base + k] * X[off + k];
    th[h] = Math.tanh(z);
    s += v[h] * th[h];
  }
  return s;
}
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

const mk = (n) => ({ m: new Float64Array(n), s: new Float64Array(n) });
const AD = { W1: mk(W1.length), b1: mk(H), v: mk(H), w: mk(FEAT), b: mk(1) };
let adamT = 0;
function adam(param, grad, st, lr) {
  adamT++;
  const bc1 = 1 - Math.pow(0.9, adamT), bc2 = 1 - Math.pow(0.999, adamT);
  for (let i = 0; i < param.length; i++) {
    const g = grad[i] + OPT.l2 * param[i];
    st.m[i] = 0.9 * st.m[i] + 0.1 * g;
    st.s[i] = 0.999 * st.s[i] + 0.001 * g * g;
    param[i] -= lr * (st.m[i] / bc1) / (Math.sqrt(st.s[i] / bc2) + 1e-8);
    grad[i] = 0;
  }
}

/** AUC(按分数排序的秩和公式) */
function auc(scores, labels) {
  const idx = Array.from({ length: scores.length }, (_, i) => i).sort((a, c) => scores[a] - scores[c]);
  let rankSum = 0, nPos = 0, nNeg = 0;
  for (let r = 0; r < idx.length; r++) {
    if (labels[idx[r]]) { rankSum += r + 1; nPos++; } else nNeg++;
  }
  if (!nPos || !nNeg) return 0.5;
  return (rankSum - nPos * (nPos + 1) / 2) / (nPos * nNeg);
}

function evaluate(d) {
  const p = new Float64Array(d.n);
  for (let i = 0; i < d.n; i++) p[i] = sigmoid(score(d.X, i * FEAT));
  const a = auc(p, d.y);
  // 阈值 0.5 的准确率 / F1
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < d.n; i++) {
    const pred = p[i] >= 0.5 ? 1 : 0;
    if (pred && d.y[i]) tp++; else if (pred && !d.y[i]) fp++;
    else if (!pred && d.y[i]) fn++; else tn++;
  }
  const acc = (tp + tn) / d.n;
  const prec = tp / Math.max(1, tp + fp), rec = tp / Math.max(1, tp + fn);
  const f1 = 2 * prec * rec / Math.max(1e-9, prec + rec);
  return { auc: a, acc, prec, rec, f1 };
}

/** 基线:现在写死的规则 —— phase>=34 就出击 */
function ruleBaseline(d, phaseMin) {
  const p = new Float64Array(d.n);
  for (let i = 0; i < d.n; i++) p[i] = (d.t[i] % 50) >= phaseMin ? 1 : 0;
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < d.n; i++) {
    if (p[i] && d.y[i]) tp++; else if (p[i] && !d.y[i]) fp++;
    else if (!p[i] && d.y[i]) fn++; else tn++;
  }
  const acc = (tp + tn) / d.n;
  const prec = tp / Math.max(1, tp + fp), rec = tp / Math.max(1, tp + fn);
  return { auc: auc(p, d.y), acc, prec, rec, f1: 2 * prec * rec / Math.max(1e-9, prec + rec) };
}

(function main() {
  const t0 = Date.now();
  const tr = load(TRAIN), he = load(HELD);
  let pos = 0; for (let i = 0; i < tr.n; i++) pos += tr.y[i];
  console.log(`训练 ${tr.n} 样本(正例 ${(pos / tr.n * 100).toFixed(1)}%) / 留出 ${he.n};H=${H}`);

  const gW1 = new Float64Array(W1.length), gb1 = new Float64Array(H);
  const gv = new Float64Array(H), gw = new Float64Array(FEAT), gb = new Float64Array(1);
  const order = Int32Array.from({ length: tr.n }, (_, i) => i);
  let best = null, bestAuc = 0, since = 0;

  for (let e = 1; e <= OPT.epochs; e++) {
    for (let i = tr.n - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const t = order[i]; order[i] = order[j]; order[j] = t; }
    const lr = OPT.lr * (1 - 0.8 * (e - 1) / Math.max(1, OPT.epochs - 1));
    let inB = 0, loss = 0;
    for (let oi = 0; oi < order.length; oi++) {
      const i = order[oi], off = i * FEAT;
      const s = score(tr.X, off);
      const p = sigmoid(s), y = tr.y[i];
      loss += -(y ? Math.log(Math.max(p, 1e-12)) : Math.log(Math.max(1 - p, 1e-12)));
      const g = p - y;
      for (let k = 0; k < FEAT; k++) gw[k] += g * tr.X[off + k];
      gb[0] += g;
      for (let h = 0; h < H; h++) {
        gv[h] += g * th[h];
        const dz = g * v[h] * (1 - th[h] * th[h]);
        gb1[h] += dz;
        const base = h * FEAT;
        for (let k = 0; k < FEAT; k++) gW1[base + k] += dz * tr.X[off + k];
      }
      if (++inB >= OPT.batch) {
        const sc = 1 / inB;
        for (let k = 0; k < gW1.length; k++) gW1[k] *= sc;
        for (let k = 0; k < H; k++) { gb1[k] *= sc; gv[k] *= sc; }
        for (let k = 0; k < FEAT; k++) gw[k] *= sc;
        gb[0] *= sc;
        const t1 = adamT;
        adam(W1, gW1, AD.W1, lr); adamT = t1;
        adam(b1, gb1, AD.b1, lr); adamT = t1;
        adam(v, gv, AD.v, lr); adamT = t1;
        adam(w, gw, AD.w, lr); adamT = t1;
        const bA = [b]; adam(bA, gb, AD.b, lr); b = bA[0];
        inB = 0;
      }
    }
    const ev = evaluate(he);
    if (e % 5 === 0 || e === 1) console.log(`  epoch ${String(e).padStart(2)}: 训练loss=${(loss / tr.n).toFixed(4)}  留出AUC=${ev.auc.toFixed(4)}  准确率=${(ev.acc * 100).toFixed(1)}%`);
    if (ev.auc > bestAuc + 1e-4) {
      bestAuc = ev.auc; since = 0;
      best = { W1: Array.from(W1), b1: Array.from(b1), v: Array.from(v), w: Array.from(w), b };
    } else if (++since >= 5) { console.log('  留出 AUC 连续 5 轮未提升,早停'); break; }
  }

  if (best) {
    W1.set(best.W1); b1.set(best.b1); v.set(best.v); w.set(best.w); b = best.b;
    fs.writeFileSync(OUT, JSON.stringify({ type: 'commit', feat: FEAT, H, W1: best.W1.map((x) => +x.toFixed(6)), b1: best.b1.map((x) => +x.toFixed(6)), v: best.v.map((x) => +x.toFixed(6)), w: best.w.map((x) => +x.toFixed(6)), b: +best.b.toFixed(6) }));
  }

  const ev = evaluate(he);
  console.log(`\n========== 留出集对比 ==========`);
  console.log(`  学出来的局面判断器   AUC ${ev.auc.toFixed(4)}   准确率 ${(ev.acc * 100).toFixed(1)}%   精确 ${(ev.prec * 100).toFixed(1)}%  召回 ${(ev.rec * 100).toFixed(1)}%  F1 ${(ev.f1 * 100).toFixed(1)}%`);
  for (const pm of [34, 30, 25]) {
    const rb = ruleBaseline(he, pm);
    console.log(`  写死规则 phase>=${pm}       AUC ${rb.auc.toFixed(4)}   准确率 ${(rb.acc * 100).toFixed(1)}%   精确 ${(rb.prec * 100).toFixed(1)}%  召回 ${(rb.rec * 100).toFixed(1)}%  F1 ${(rb.f1 * 100).toFixed(1)}%`);
  }
  console.log(`\n已写入 ${path.basename(OUT)}   耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})();
