#!/usr/bin/env node
'use strict';
/*
 * eval_model.js — 在指定留出集上评估任意走子模型(线性或 MLP),口径与 train3 完全一致。
 *
 * 为什么需要它:全量重提之后留出集换了(47 局 → 185 局),旧模型的 59.64%
 * 和新模型的数字**不可直接比较**。必须把两者放到同一个留出集上测。
 *
 * 用法: node eval_model.js <模型文件> [留出集文件]
 */
const fs = require('fs');
const path = require('path');

const modelPath = process.argv[2] || path.join(__dirname, 'model3.json');
const heldPath = process.argv[3] || path.join(__dirname, 'heldout2.jsonl');
const M = JSON.parse(fs.readFileSync(modelPath, 'utf8'));

const FEAT = M.feat || 32;
const IS_MLP = M.type === 'mlp';
const WLIN = IS_MLP ? M.wlin : M.w;
const H = IS_MLP ? M.H : 0;
const W1 = IS_MLP ? Float64Array.from(M.W1) : null;
const B1 = IS_MLP ? Float64Array.from(M.b1) : null;
const V = IS_MLP ? Float64Array.from(M.v) : null;
const B = M.b || 0;

function score(x) {
  let s = B;
  for (let k = 0; k < FEAT; k++) s += WLIN[k] * x[k];
  if (!IS_MLP) return s;
  for (let h = 0; h < H; h++) {
    let z = B1[h];
    const base = h * FEAT;
    for (let k = 0; k < FEAT; k++) z += W1[base + k] * x[k];
    s += V[h] * Math.tanh(z);
  }
  return s;
}

let n = 0, top1 = 0, top3 = 0, nll = 0;
let nReal = 0, t1Real = 0, nIdle = 0, t1Idle = 0;

const fd = fs.openSync(heldPath, 'r');
const CH = 1 << 22;
const buf = Buffer.allocUnsafe(CH);
let rem = '', bytes;
while ((bytes = fs.readSync(fd, buf, 0, CH, null)) > 0) {
  const data = rem + buf.toString('utf8', 0, bytes);
  let st = 0, i;
  while ((i = data.indexOf('\n', st)) !== -1) {
    const line = data.slice(st, i); st = i + 1;
    if (line.length < 2) continue;
    const ex = JSON.parse(line);
    const c = ex.c, y = ex.y, m = c.length;
    const sc = new Float64Array(m);
    let mx = -Infinity;
    for (let j = 0; j < m; j++) { sc[j] = score(c[j]); if (sc[j] > mx) mx = sc[j]; }
    let Z = 0;
    for (let j = 0; j < m; j++) Z += Math.exp(sc[j] - mx);
    nll += -Math.log(Math.max(Math.exp(sc[y] - mx) / Z, 1e-12));
    const expHit = (ref, k) => {
      let G = 0, E = 0;
      for (let j = 0; j < m; j++) { if (sc[j] > ref) G++; else if (sc[j] === ref) E++; }
      return Math.min(Math.max((k - G) / E, 0), 1);
    };
    const h1 = expHit(sc[y], 1);
    top1 += h1; top3 += expHit(sc[y], 3); n++;
    if (y === m - 1) { nIdle++; t1Idle += h1; } else { nReal++; t1Real += h1; }
  }
  rem = data.slice(st);
}
fs.closeSync(fd);

console.log(`模型 ${path.basename(modelPath)} (${IS_MLP ? 'MLP H=' + H : '线性'})  留出集 ${path.basename(heldPath)}`);
console.log(`  ${n} 决策点(真实 ${nReal} / 空转 ${nIdle})`);
console.log(`  top1 = ${(top1 / n * 100).toFixed(2)}%   top3 = ${(top3 / n * 100).toFixed(2)}%   NLL = ${(nll / n).toFixed(4)}`);
console.log(`  真实点 top1 = ${(t1Real / nReal * 100).toFixed(2)}%   空转召回 = ${(t1Idle / Math.max(1, nIdle) * 100).toFixed(2)}%`);
