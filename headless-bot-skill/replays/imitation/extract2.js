'use strict';

/**
 * 模仿学习训练集抽取器 v2。
 *
 * 在 v1 (extract.js, 24 维) 基础上:
 *   - 每个候选行追加 8 维 (f25-f32), 共 32 维; v1 的 24 维定义一字不动。
 *   - 每个决策点候选集末尾追加一个"不动"伪候选 (f25=1, 其余 31 维全 0);
 *     伪候选不参与 64 截断的采样, 始终保留。
 *   - 新增"空转决策点": 目标玩家首次 move 之后、最后 move 之前, 凡该半回合
 *     无 move, 生成决策点, y = 伪候选下标。快照取在该半回合任何 move 执行前
 *     (即上一 game.update() 之后)。合法步为 0 则跳过。
 *   - "上一步"(f27/f28 用) = 该玩家最近一次真实 move (跨半回合追踪, 空转不更新)。
 *
 * 输出 (逐局流式追加, JSONL):
 *   replays/imitation/dataset2.jsonl  — index.json 前 90% 局
 *   replays/imitation/heldout2.jsonl  — 后 10% 局
 * 每行: {g: 局id, t: 半回合, c: [[32 floats(3位小数)], ...], y: 所选下标}
 *
 * 特征定义详见 replays/imitation/FEATURES2.md。
 *
 * 运行: node replays/imitation/extract2.js
 */

const fs = require('fs');
const path = require('path');
const Game = require('../Game');

const ROOT = path.join(__dirname, '..');
const CORPUS_DIR = path.join(ROOT, 'corpus');
const PRO_DIR = path.join(ROOT, 'pro');
const TRAIN_OUT = path.join(__dirname, 'dataset2.jsonl');
const HELDOUT_OUT = path.join(__dirname, 'heldout2.jsonl');

const CAP = 800;      // 半回合上限
const MAX_CAND = 64;  // 真实候选上限 (伪候选另计, 行数最多 65)
const DIM = 32;

// ---------- 可复现随机数(按局 id 播种, 用于候选>64 时的下采样) ----------
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clip(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
function r3(x) { return Math.round(x * 1000) / 1000; }

function pseudoRow() {
  const row = new Array(DIM).fill(0);
  row[24] = 1; // f25 pause 标志
  return row;
}

// ---------- 单个决策点: 迷雾重建 + 候选枚举 + 特征 ----------
// move: 高手真实 move 或 null (空转决策点)。turn: 半回合。
// prevMove: {start, end, turn} 该玩家最近一次真实 move, 或 null。
// 返回 {c, y} 或 null(真实点: 高手所选不在候选集; 空转点: 合法步为 0)。
// mem: 跨决策点记忆 {enemyGeneral: -1|tileIdx}
function extractDecision(game, r, me, move, turn, mem, rng, prevMove) {
  const W = r.mapWidth, H = r.mapHeight, size = W * H;
  const map = game.map;
  const normD = W + H;

  const myGen = game.generals[me];
  if (myGen === undefined || myGen < 0) return null; // 己方将军已亡(理论不可达)

  // ---- 迷雾重建(高手视角) ----
  // 可见 = me 拥有格子的 8 邻域(含自身)
  const visible = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    if (map.tileAt(i) === me) {
      const row = (i / W) | 0, col = i % W;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = row + dr, cc = col + dc;
          if (rr >= 0 && rr < H && cc >= 0 && cc < W) visible[rr * W + cc] = 1;
        }
      }
    }
  }
  const isCity = new Uint8Array(size);
  for (let k = 0; k < game.cities.length; k++) isCity[game.cities[k]] = 1;

  // 可见格: terrain=真实owner/-1/-2(山), army=真实
  // 不可见格: army=0, 山或城 -> -4, 否则 -3
  const terr = new Int16Array(size);
  const army = new Int32Array(size);
  for (let i = 0; i < size; i++) {
    if (visible[i]) {
      terr[i] = map.tileAt(i);
      army[i] = map.armyAt(i);
    } else {
      army[i] = 0;
      terr[i] = (map.tileAt(i) === -2 /*山*/ || isCity[i]) ? -4 : -3;
    }
  }
  // 已知城 = game.cities 里当前可见的
  const knownCity = new Uint8Array(size);
  for (let k = 0; k < game.cities.length; k++) {
    const c = game.cities[k];
    if (visible[c]) knownCity[c] = 1;
  }
  // 已知敌将(记忆: 一旦可见就永久记住位置)
  for (let p = 0; p < game.generals.length; p++) {
    if (p === me) continue;
    const g = game.generals[p];
    if (g >= 0 && visible[g]) mem.enemyGeneral = g;
  }
  const eGen = mem.enemyGeneral;

  // 可见敌格 + 敌方重心
  const enemyTiles = [];
  let erSum = 0, ecSum = 0;
  for (let i = 0; i < size; i++) {
    if (terr[i] >= 0 && terr[i] !== me) {
      enemyTiles.push(i);
      erSum += (i / W) | 0;
      ecSum += i % W;
    }
  }
  const hasEnemy = enemyTiles.length > 0;
  const er = hasEnemy ? erSum / enemyTiles.length : 0;
  const ec = hasEnemy ? ecSum / enemyTiles.length : 0;

  // 兵力总量(计分板信息, 用真实值)
  let myArmy = 0, allArmy = 0;
  for (let i = 0; i < size; i++) {
    const o = map.tileAt(i);
    if (o >= 0) {
      allArmy += map.armyAt(i);
      if (o === me) myArmy += map.armyAt(i);
    }
  }

  // ---- 候选枚举 ----
  // (t,n): 高手视角 isMine(t) && army[t]>=2, n 为 t 的 4 邻且 terrain[n] 非 -2(山)非 -4(雾障)
  const cands = [];
  let chosenIdx = -1;
  for (let t = 0; t < size; t++) {
    if (terr[t] !== me || army[t] < 2) continue;
    const row = (t / W) | 0, col = t % W;
    const neigh = [];
    if (row > 0) neigh.push(t - W);
    if (row < H - 1) neigh.push(t + W);
    if (col > 0) neigh.push(t - 1);
    if (col < W - 1) neigh.push(t + 1);
    for (const n of neigh) {
      if (terr[n] === -2 || terr[n] === -4) continue;
      if (move && t === move.start && n === move.end) chosenIdx = cands.length;
      cands.push([t, n]);
    }
  }
  if (move && chosenIdx < 0) return null;  // 真实点: 高手所选不在候选集 -> 丢弃
  if (!move && cands.length === 0) return null; // 空转点: 无合法步 -> 跳过

  // 真实候选 > 64: 下采样到 64 (保持原扫描顺序); 伪候选不参与截断, 始终保留。
  // 真实点: 保留高手所选 + 随机 63 个; 空转点: 随机 64 个。
  let kept = cands, y = chosenIdx;
  if (cands.length > MAX_CAND) {
    let keepIdx;
    if (move) {
      const others = [];
      for (let i = 0; i < cands.length; i++) if (i !== chosenIdx) others.push(i);
      for (let i = 0; i < MAX_CAND - 1; i++) {
        const j = i + Math.floor(rng() * (others.length - i));
        const tmp = others[i]; others[i] = others[j]; others[j] = tmp;
      }
      keepIdx = others.slice(0, MAX_CAND - 1);
      keepIdx.push(chosenIdx);
    } else {
      const all = [];
      for (let i = 0; i < cands.length; i++) all.push(i);
      for (let i = 0; i < MAX_CAND; i++) {
        const j = i + Math.floor(rng() * (all.length - i));
        const tmp = all[i]; all[i] = all[j]; all[j] = tmp;
      }
      keepIdx = all.slice(0, MAX_CAND);
    }
    keepIdx.sort((a, b) => a - b);
    kept = keepIdx.map(i => cands[i]);
    if (move) y = keepIdx.indexOf(chosenIdx);
  }

  // ---- 特征 ----
  const gr = (myGen / W) | 0, gc = myGen % W;
  const f13 = (turn % 50) / 50;
  const f14 = (turn % 50) >= 30 ? 1 : 0;
  const f15 = Math.min(turn / 400, 1);
  const f20 = allArmy > 0 ? myArmy / allArmy : 0.5;
  // f21 方向向量: 我将军 -> 敌重心
  const vr = er - gr, vc = ec - gc;

  const md = (a, b) => Math.abs(((a / W) | 0) - ((b / W) | 0)) + Math.abs((a % W) - (b % W));
  const distToCentroid = (i) => Math.abs(((i / W) | 0) - er) + Math.abs((i % W) - ec);

  const rows = kept.map(([t, n]) => {
    const srcArmy = army[t];
    const dTerr = terr[n];
    const dArmy = army[n]; // 雾=0, 可见=真实
    const tr = (t / W) | 0, tc = t % W;
    const nr = (n / W) | 0, nc = n % W;

    const f1 = Math.log(1 + srcArmy) / 5;
    const f2 = t === myGen ? 1 : 0;
    const f3 = dTerr === me ? 1 : 0;
    const f4 = dTerr === -1 ? 1 : 0;
    const f5 = dTerr === -3 ? 1 : 0;
    const f6 = (dTerr >= 0 && dTerr !== me) ? 1 : 0;
    const f7 = Math.log(1 + dArmy) / 5;
    const f8 = knownCity[n] ? 1 : 0;
    const f9 = md(t, myGen) / normD;

    let f10 = 1;
    if (hasEnemy) {
      let best = Infinity;
      for (const e of enemyTiles) {
        const d = Math.abs(nr - ((e / W) | 0)) + Math.abs(nc - (e % W));
        if (d < best) best = d;
      }
      f10 = best / normD;
    }

    let f11 = 0;
    if (hasEnemy) {
      const diff = distToCentroid(t) - distToCentroid(n);
      f11 = diff > 1e-9 ? 1 : (diff < -1e-9 ? -1 : 0);
    }

    let f12 = 0;
    if (eGen >= 0) {
      const diff = md(t, eGen) - md(n, eGen);
      f12 = diff > 0 ? 1 : (diff < 0 ? -1 : 0);
    }

    let open = 0, nn = [];
    if (nr > 0) nn.push(n - W);
    if (nr < H - 1) nn.push(n + W);
    if (nc > 0) nn.push(n - 1);
    if (nc < W - 1) nn.push(n + 1);
    for (const q of nn) if (terr[q] === -1 || terr[q] === -3) open++;
    const f16 = open / 4;

    let f17 = 0;
    {
      const sn = [];
      if (tr > 0) sn.push(t - W);
      if (tr < H - 1) sn.push(t + W);
      if (tc > 0) sn.push(t - 1);
      if (tc < W - 1) sn.push(t + 1);
      for (const q of sn) if (terr[q] >= 0 && terr[q] !== me) { f17 = 1; break; }
    }

    let reveal = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const rr = nr + dr, cc = nc + dc;
        if (rr >= 0 && rr < H && cc >= 0 && cc < W && !visible[rr * W + cc]) reveal++;
      }
    }
    const f18 = reveal / 8;

    const f19 = f6 ? clip((srcArmy - 1 - dArmy) / 50, -1, 1) : 0;

    let f21 = 0;
    if (hasEnemy) {
      const dot = (nr - gr) * vr + (nc - gc) * vc;
      f21 = dot > 0 ? 1 : -1;
    }

    const f22 = (dArmy === 1 && dTerr === me) ? 1 : 0;
    const f23 = myArmy > 0 ? clip(srcArmy / myArmy, 0, 1) : 0;
    const f24 = md(n, myGen) / normD;

    // ---- v2 追加特征 (f25-f32) ----
    const f25 = 0; // 真实步; 伪候选行另行构造
    const f26 = knownCity[n] ? clip((srcArmy - 1 - dArmy) / 40, -1, 1) : 0;
    const f27 = (prevMove && t === prevMove.end && (turn - prevMove.turn) <= 2) ? 1 : 0;
    const f28 = (prevMove && t === prevMove.end && n === prevMove.start) ? 1 : 0;
    const f29 = f6 ? f12 : 0;
    const f30 = (knownCity[n] && dTerr >= 0 && dTerr !== me) ? 1 : 0;
    const f31 = (f6 && srcArmy - 1 > dArmy) ? 1 : 0;
    const f32 = f14 * f6;

    return [f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13, f14, f15,
      f16, f17, f18, f19, f20, f21, f22, f23, f24,
      f25, f26, f27, f28, f29, f30, f31, f32].map(r3);
  });

  // 伪候选(不动)始终追加在末尾
  rows.push(pseudoRow());
  if (!move) y = rows.length - 1; // 空转点: y = 伪候选下标

  return { c: rows, y };
}

// ---------- 单局处理 ----------
function processGame(entry, stats) {
  let file = path.join(CORPUS_DIR, entry.id + '.json');
  if (!fs.existsSync(file)) {
    file = path.join(PRO_DIR, entry.id + '.json');
    if (!fs.existsSync(file)) return null;
  }
  let r;
  try {
    r = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
  const me = r.usernames.indexOf(entry.player);
  if (me < 0) return null;

  // 目标玩家的 move 半回合集合 + 首/末 move 半回合 (空转决策点判定用)
  const myMoveTurns = new Set();
  let firstMoveTurn = Infinity, lastMoveTurn = -Infinity;
  for (const m of r.moves) {
    if (m.index === me) {
      myMoveTurns.add(m.turn);
      if (m.turn < firstMoveTurn) firstMoveTurn = m.turn;
      if (m.turn > lastMoveTurn) lastMoveTurn = m.turn;
    }
  }

  const game = Game.createFromReplay(r);
  const rng = mulberry32(hashStr(entry.id));
  const mem = { enemyGeneral: -1 };
  const lines = [];
  let mi = 0;
  let lastDecisionTurn = -1;
  let prevMove = null; // 最近一次真实 move {start, end, turn}; 空转不更新

  while (!game.isOver() && game.turn < CAP) {
    // 空转决策点: 首次 move 之后、最后 move 之前, 该半回合无 move。
    // 快照取在该半回合任何 move 执行前 (上一 game.update() 之后)。
    const T = game.turn;
    if (T > firstMoveTurn && T < lastMoveTurn && !myMoveTurns.has(T)) {
      stats.idleSeen++;
      const rec = extractDecision(game, r, me, null, T, mem, rng, prevMove);
      if (rec) {
        lines.push(JSON.stringify({ g: entry.id, t: T, c: rec.c, y: rec.y }));
        stats.idleKept++;
      } else {
        stats.idleSkipped++;
      }
    }
    while (r.moves.length > mi && r.moves[mi].turn <= game.turn) {
      const m = r.moves[mi++];
      // 决策点: 目标玩家该半回合的第一个 move, 执行前的局面
      if (m.index === me && m.turn !== lastDecisionTurn) {
        lastDecisionTurn = m.turn;
        stats.decisionsSeen++;
        const rec = extractDecision(game, r, me, m, m.turn, mem, rng, prevMove);
        if (rec) {
          lines.push(JSON.stringify({ g: entry.id, t: m.turn, c: rec.c, y: rec.y }));
          stats.decisionsKept++;
        } else {
          stats.dropped++;
        }
      }
      if (m.index === me) prevMove = { start: m.start, end: m.end, turn: m.turn };
      game.handleAttack(m.index, m.start, m.end, m.is50);
    }
    game.update();
  }
  return lines;
}

// ---------- 主流程 ----------
function main() {
  const index = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, 'index.json'), 'utf8'));
  const nTrain = Math.floor(index.length * 0.9);

  fs.writeFileSync(TRAIN_OUT, '');
  fs.writeFileSync(HELDOUT_OUT, '');

  const stats = {
    decisionsSeen: 0, decisionsKept: 0, dropped: 0,
    idleSeen: 0, idleKept: 0, idleSkipped: 0,
    gamesOk: 0, gamesSkipped: 0, trainLines: 0, heldoutLines: 0,
  };

  for (let gi = 0; gi < index.length; gi++) {
    const entry = index[gi];
    const lines = processGame(entry, stats);
    if (lines === null) {
      stats.gamesSkipped++;
      console.error('skip game ' + entry.id);
      continue;
    }
    stats.gamesOk++;
    if (lines.length) {
      const out = gi < nTrain ? TRAIN_OUT : HELDOUT_OUT;
      fs.appendFileSync(out, lines.join('\n') + '\n');
      if (gi < nTrain) stats.trainLines += lines.length;
      else stats.heldoutLines += lines.length;
    }
    if ((gi + 1) % 50 === 0) {
      console.error('... ' + (gi + 1) + '/' + index.length + ' games, kept=' +
        stats.decisionsKept + ' idle=' + stats.idleKept + ' dropped=' + stats.dropped);
    }
  }

  const total = stats.decisionsKept + stats.idleKept;
  console.log(JSON.stringify({
    games_total: index.length,
    games_ok: stats.gamesOk,
    games_skipped: stats.gamesSkipped,
    train_games: nTrain,
    heldout_games: index.length - nTrain,
    decisions_seen: stats.decisionsSeen,
    decisions_kept: stats.decisionsKept,
    dropped: stats.dropped,
    idle_seen: stats.idleSeen,
    idle_kept: stats.idleKept,
    idle_skipped_no_cands: stats.idleSkipped,
    total_decision_points: total,
    idle_ratio: total > 0 ? Math.round(stats.idleKept / total * 10000) / 10000 : 0,
    train_lines: stats.trainLines,
    heldout_lines: stats.heldoutLines,
  }, null, 2));
}

main();
