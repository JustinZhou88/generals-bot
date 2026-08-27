#!/usr/bin/env node
'use strict';
/*
 * 条件 logit 走子排序器训练 v2(纯 JS,零依赖)。32 维,含"不动"伪候选。
 * 数据: replays/imitation/dataset2.jsonl  每行 {g,t,c:[[32 floats],...],y}
 *       每行 c 末尾恒为伪候选(f25=1,其余 31 维全 0);y=c.length-1 即空转点。
 * 模型: score = w·x + b;每个决策点上对候选 softmax,损失 = -log P(y)。
 * SGD: lr0=0.05 线性衰减,EPOCHS 个 epoch;流式逐行读 + 1 万行 shuffle 缓冲。
 * 输出: replays/imitation/model2.json = {w:[32], b, feat:32}
 * 评估: heldout2.jsonl 上整体 top1/top3(平分随机 tie-break 的期望命中率),
 *       另拆分真实点/空转点,并报告:
 *       - pauseRecall  = 空转点上模型 top-1 选中伪候选(不动)的期望比例
 *       - pauseFalse   = 真实点上模型 top-1 误选伪候选的期望比例
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const TRAIN = path.join(DIR, 'dataset2.jsonl');
const HELD = path.join(DIR, 'heldout2.jsonl');
const MODEL_OUT = path.join(DIR, 'model2.json');

const FEAT = 32;
const EPOCHS = 4;
const LR0 = 0.05;
const LR_MIN = 0.001;
const SHUF_BUF = 10000;

const FEAT_NAMES = [
  'f1  log(1+srcArmy)/5(源兵力)',
  'f2  src 是我方将军',
  'f3  dest 是我方格',
  'f4  dest 可见空地(含中立城)',
  'f5  dest 平雾',
  'f6  dest 敌格',
  'f7  log(1+destArmy)/5(目标兵力,视角)',
  'f8  dest 是已知城',
  'f9  md(src,我将军)/normD',
  'f10 dest 距最近可见敌格/normD',
  'f11 dest 比 src 更近敌重心(±1)',
  'f12 dest 比 src 更近已知敌将(±1)',
  'f13 (turn%50)/50',
  'f14 turn%50>=30',
  'f15 min(turn/400,1)',
  'f16 dest 4邻空地/平雾占比',
  'f17 src 邻可见敌格',
  'f18 dest 8邻不可见格占比(揭雾)',
  'f19 攻击差额 clip((srcA-1-destA)/50)',
  'f20 myArmy/allArmy(兵力份额)',
  'f21 dest 在朝敌重心前半平面(±1)',
  'f22 destArmy==1 且我方(可续吸)',
  'f23 srcArmy/myArmy(源集中度)',
  'f24 md(dest,我将军)/normD',
  'f25 伪候选(不动)',
  'f26 已知城攻击差额 clip((srcA-1-destA)/40)(吃得动城)',
  'f27 链式推进(src==上一步.end 且 ≤2 半回合)',
  'f28 折返(src==上一步.end 且 dest==上一步.start)',
  'f29 敌格 × 朝已知敌将(f6×f12)',
  'f30 dest 是敌方城',
  'f31 敌格且能吃(srcA-1>destA)',
  'f32 后半周期 × 敌格(f14×f6)',
];

// ---------- 流式逐行读取 ----------
function forEachLine(file, onLine, onDone) {
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let rem = '';
  stream.on('data', (chunk) => {
    let data = rem + chunk;
    let start = 0;
    let idx;
    while ((idx = data.indexOf('\n', start)) !== -1) {
      const line = data.slice(start, idx);
      if (line.length > 1) onLine(line);
      start = idx + 1;
    }
    rem = data.slice(start);
  });
  stream.on('end', () => {
    if (rem.length > 1) onLine(rem);
    onDone();
  });
  stream.on('error', (e) => { throw e; });
}

function countLines(file) {
  return new Promise((resolve) => {
    let n = 0;
    forEachLine(file, () => n++, () => resolve(n));
  });
}

// mulberry32,固定种子保证可复现
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 模型 ----------
const w = new Float64Array(FEAT);
let b = 0;

function scoreOf(x) {
  let s = b;
  for (let k = 0; k < FEAT; k++) s += w[k] * x[k];
  return s;
}

// 单样本 SGD 更新,返回该样本损失(更新前)
function step(ex, lr) {
  const c = ex.c, y = ex.y, n = c.length;
  const scores = new Float64Array(n);
  let mx = -Infinity;
  for (let i = 0; i < n; i++) { scores[i] = scoreOf(c[i]); if (scores[i] > mx) mx = scores[i]; }
  let Z = 0;
  for (let i = 0; i < n; i++) { scores[i] = Math.exp(scores[i] - mx); Z += scores[i]; }
  const py = scores[y] / Z;
  const loss = -Math.log(Math.max(py, 1e-12));
  for (let i = 0; i < n; i++) {
    const coef = lr * (scores[i] / Z - (i === y ? 1 : 0));
    if (coef === 0) continue;
    const x = c[i];
    for (let k = 0; k < FEAT; k++) w[k] -= coef * x[k];
    b -= coef; // 各候选之和为 0,b 恒为 0;保留形式上的完整性
  }
  return loss;
}

// ---------- 一个 epoch:流式 + shuffle 缓冲 ----------
function runEpoch(epoch, totalSteps, stepOffset, rng) {
  return new Promise((resolve) => {
    const buf = [];
    let sumLoss = 0, nEx = 0, g = stepOffset;

    const consume = (line) => {
      const ex = JSON.parse(line);
      const lr = Math.max(LR_MIN, LR0 * (1 - g / totalSteps));
      g++;
      sumLoss += step(ex, lr);
      nEx++;
    };

    forEachLine(TRAIN, (line) => {
      if (buf.length < SHUF_BUF) { buf.push(line); return; }
      const j = (rng() * buf.length) | 0; // 随机弹出一行,新行补位
      const out = buf[j];
      buf[j] = line;
      consume(out);
    }, () => {
      // 清空缓冲(Fisher-Yates 后顺序消费)
      for (let i = buf.length - 1; i > 0; i--) {
        const j = (rng() * (i + 1)) | 0;
        const t = buf[i]; buf[i] = buf[j]; buf[j] = t;
      }
      for (const line of buf) consume(line);
      resolve({ avgLoss: sumLoss / nEx, nEx, nextStep: g });
    });
  });
}

// ---------- 评估:期望 top-k(平分 tie-break)+ pause 统计 ----------
function evaluate() {
  return new Promise((resolve) => {
    let n = 0, top1 = 0, top3 = 0, base1 = 0, base3 = 0, sumNLL = 0, sumCands = 0;
    // 真实点 / 空转点拆分
    let nReal = 0, top1Real = 0, top3Real = 0;
    let nIdle = 0, top1Idle = 0, top3Idle = 0;
    // pause 统计:模型 top-1 落在伪候选上的期望次数
    let pauseTopIdle = 0; // 空转点上(= 召回,与 top1Idle 相同定义,单列以示语义)
    let pauseTopReal = 0; // 真实点上(= 误报)
    forEachLine(HELD, (line) => {
      const ex = JSON.parse(line);
      const c = ex.c, y = ex.y, m = c.length;
      const pauseIdx = m - 1; // 伪候选恒为末行
      const isIdle = (y === pauseIdx);
      const scores = new Float64Array(m);
      let mx = -Infinity;
      for (let i = 0; i < m; i++) { scores[i] = scoreOf(c[i]); if (scores[i] > mx) mx = scores[i]; }
      let Z = 0;
      for (let i = 0; i < m; i++) Z += Math.exp(scores[i] - mx);
      sumNLL += -Math.log(Math.max(Math.exp(scores[y] - mx) / Z, 1e-12));
      // 期望命中:rank 均匀分布在 G+1..G+E
      const expHit = (ref, k) => {
        let G = 0, E = 0;
        for (let i = 0; i < m; i++) {
          if (scores[i] > ref) G++;
          else if (scores[i] === ref) E++; // 含自身
        }
        return Math.min(Math.max((k - G) / E, 0), 1);
      };
      const h1 = expHit(scores[y], 1), h3 = expHit(scores[y], 3);
      const pTop = expHit(scores[pauseIdx], 1); // 伪候选被排到 top-1 的期望概率
      top1 += h1; top3 += h3;
      base1 += 1 / m;
      base3 += Math.min(3, m) / m;
      sumCands += m;
      n++;
      if (isIdle) { nIdle++; top1Idle += h1; top3Idle += h3; pauseTopIdle += pTop; }
      else { nReal++; top1Real += h1; top3Real += h3; pauseTopReal += pTop; }
    }, () => resolve({
      n,
      top1: top1 / n, top3: top3 / n,
      base1: base1 / n, base3: base3 / n,
      nll: sumNLL / n, avgCands: sumCands / n,
      nReal, top1Real: top1Real / nReal, top3Real: top3Real / nReal,
      nIdle, top1Idle: top1Idle / nIdle, top3Idle: top3Idle / nIdle,
      pauseRecall: pauseTopIdle / nIdle,   // 空转点上选"不动"的召回率
      pauseFalse: pauseTopReal / nReal,    // 非空转点上误选"不动"的比例
    }));
  });
}

// ---------- 主流程 ----------
(async function main() {
  const t0 = Date.now();
  console.log('统计训练集行数…');
  const N = await countLines(TRAIN);
  console.log(`训练集 ${N} 行,${EPOCHS} epochs,lr0=${LR0} 线性衰减,shuffle 缓冲 ${SHUF_BUF}`);

  const totalSteps = N * EPOCHS;
  const rng = mulberry32(20260727);
  let stepOffset = 0;
  for (let e = 1; e <= EPOCHS; e++) {
    const te = Date.now();
    const { avgLoss, nEx, nextStep } = await runEpoch(e, totalSteps, stepOffset, rng);
    stepOffset = nextStep;
    console.log(`epoch ${e}/${EPOCHS}  train NLL=${avgLoss.toFixed(4)}  (${nEx} 例, ${((Date.now() - te) / 1000).toFixed(1)}s)`);
  }

  fs.writeFileSync(MODEL_OUT, JSON.stringify({
    w: Array.from(w, (v) => +v.toFixed(6)),
    b: +b.toFixed(6),
    feat: FEAT,
  }));
  console.log(`模型已写入 ${MODEL_OUT}  (b=${b.toFixed(6)})`);

  console.log('评估 heldout2…');
  const ev = await evaluate();
  console.log(`heldout2: ${ev.n} 决策点 (真实 ${ev.nReal} / 空转 ${ev.nIdle}), 平均候选数 ${ev.avgCands.toFixed(1)}`);
  console.log(`heldout2 NLL=${ev.nll.toFixed(4)}`);
  console.log(`整体 top1 = ${(ev.top1 * 100).toFixed(2)}%   (随机基线 ${(ev.base1 * 100).toFixed(2)}%)`);
  console.log(`整体 top3 = ${(ev.top3 * 100).toFixed(2)}%   (随机基线 ${(ev.base3 * 100).toFixed(2)}%)`);
  console.log(`真实点 top1 = ${(ev.top1Real * 100).toFixed(2)}%  top3 = ${(ev.top3Real * 100).toFixed(2)}%`);
  console.log(`空转点 top1 = ${(ev.top1Idle * 100).toFixed(2)}%  top3 = ${(ev.top3Idle * 100).toFixed(2)}%`);
  console.log(`\npause 统计(top-1 = 伪候选,平分 tie-break 期望):`);
  console.log(`  召回率(空转点上选"不动")   = ${(ev.pauseRecall * 100).toFixed(2)}%  (${ev.nIdle} 点)`);
  console.log(`  误报率(真实点上误选"不动") = ${(ev.pauseFalse * 100).toFixed(2)}%  (${ev.nReal} 点)`);

  console.log('\n权重(|w| 从大到小):');
  const order = Array.from({ length: FEAT }, (_, i) => i)
    .sort((a2, b2) => Math.abs(w[b2]) - Math.abs(w[a2]));
  for (const i of order) {
    const sign = w[i] >= 0 ? '+' : '-';
    console.log(`  ${sign}${Math.abs(w[i]).toFixed(4)}  ${FEAT_NAMES[i]}`);
  }
  console.log(`\n总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch((e) => { console.error(e); process.exit(1); });
