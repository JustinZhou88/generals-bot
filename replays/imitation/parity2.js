'use strict';

/**
 * v2 线上/离线特征 parity 验证。
 *
 * 对 heldout 语料(index.json 后 10%)逐局重放官方引擎, 在与 extract2.js
 * 完全相同的决策点(真实 + 空转)上:
 *   1. injectView 喂 GameState(与 arena/线上同一条注入路径);
 *   2. 用 src/imitation.js 的 candidateFeatures() 计算线上 32 维特征;
 *   3. 复刻 extract2 的 64 截断(同 rng 流)后, 与 heldout2.jsonl 中该决策点
 *      的行逐维精确对比(含 t / y / 伪候选行)。
 * "上一步"记忆按重放中该玩家最近一次真实 move 注入 strat.prevMove;
 * 已知敌将记忆走 gs.knownGenerals(每个决策点 injectView 一次, 与训练 mem 同步)。
 *
 * 运行: node replays/imitation/parity2.js [N局]   (默认全部 47 局 heldout)
 * 输出: PARITY=<match>/<total>
 */

const fs = require('fs');
const path = require('path');
const Game = require('../Game');
const { injectView } = require('../../arena');
const { GameState } = require('../../src/gamestate');
const { ImitationStrategy } = require('../../src/imitation');

const ROOT = path.join(__dirname, '..');
const CORPUS_DIR = path.join(ROOT, 'corpus');
const PRO_DIR = path.join(ROOT, 'pro');
const CAP = 800;
const MAX_CAND = 64;
const DIM = 32;

// ---- 与 extract2.js 相同的 rng(复刻截断采样流) ----
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

const stats = { total: 0, match: 0 };
const mismatches = [];

function note(g, t, why) {
  if (mismatches.length < 20) mismatches.push(`${g} t=${t}: ${why}`);
}

function checkGame(entry, queue) {
  let file = path.join(CORPUS_DIR, entry.id + '.json');
  if (!fs.existsSync(file)) file = path.join(PRO_DIR, entry.id + '.json');
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const me = r.usernames.indexOf(entry.player);
  if (me < 0) return;

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
  const gs = new GameState();
  gs.start({ playerIndex: me, replay_id: 'parity', usernames: r.usernames, teams: undefined });
  const strat = new ImitationStrategy(gs);
  let mi = 0, lastDecisionTurn = -1;
  let prevMove = null; // 该玩家最近一次真实 move; 空转不更新

  // move: 真实 move 或 null(空转); turn: 半回合
  const comparePoint = (move, turn) => {
    // game.scores 只在 game.update() 里重算; 真实决策点的快照取在同半回合
    // 其它玩家更早 move 之后, 此时计分板相对地图是陈旧的。线上(真服务器)
    // 计分板与视图同刻发出、天然一致, extract2 也用实时地图求和 —— 故此处
    // 重算一次, 喂给 injectView 的输入才与训练侧同源(重算本身无副作用,
    // 引擎每次 update 都会做)。
    game.recalculateScores();
    injectView(gs, game, me); // 更新视图 + gs.knownGenerals 记忆
    strat.prevMove = prevMove;
    const rows = strat.candidateFeatures();
    if (rows === null) return; // 对应 extract 的 myGen<0 早退(不产生行)

    let chosen = -1;
    if (move) {
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].from === move.start && rows[i].to === move.end) { chosen = i; break; }
      }
      if (chosen < 0) return; // 真实点: 所选不在候选集 -> extract 同样丢弃
    } else if (rows.length === 0) {
      return; // 空转点: 无合法步 -> extract 同样跳过
    }

    // ---- 复刻 extract2 的 64 截断(消耗同一 rng 流) ----
    let kept = rows, y = chosen;
    if (rows.length > MAX_CAND) {
      let keepIdx;
      if (move) {
        const others = [];
        for (let i = 0; i < rows.length; i++) if (i !== chosen) others.push(i);
        for (let i = 0; i < MAX_CAND - 1; i++) {
          const j = i + Math.floor(rng() * (others.length - i));
          const tmp = others[i]; others[i] = others[j]; others[j] = tmp;
        }
        keepIdx = others.slice(0, MAX_CAND - 1);
        keepIdx.push(chosen);
      } else {
        const all = [];
        for (let i = 0; i < rows.length; i++) all.push(i);
        for (let i = 0; i < MAX_CAND; i++) {
          const j = i + Math.floor(rng() * (all.length - i));
          const tmp = all[i]; all[i] = all[j]; all[j] = tmp;
        }
        keepIdx = all.slice(0, MAX_CAND);
      }
      keepIdx.sort((a, b) => a - b);
      kept = keepIdx.map((i) => rows[i]);
      if (move) y = keepIdx.indexOf(chosen);
    }

    // ---- 与 heldout2.jsonl 对比 ----
    const line = queue.shift();
    stats.total++;
    if (!line) { note(entry.id, turn, 'jsonl 行不足'); return; }
    if (line.t !== turn) { note(entry.id, turn, `t 不符 (jsonl=${line.t})`); return; }
    if (line.c.length !== kept.length + 1) {
      note(entry.id, turn, `行数不符 online=${kept.length}+1 jsonl=${line.c.length}`);
      return;
    }
    const yExp = move ? y : kept.length; // 空转: y = 伪候选下标 = c.length-1
    if (line.y !== yExp) { note(entry.id, turn, `y 不符 online=${yExp} jsonl=${line.y}`); return; }
    for (let i = 0; i < kept.length; i++) {
      const exp = line.c[i], got = kept[i].x;
      if (exp.length !== DIM || got.length !== DIM) {
        note(entry.id, turn, `维度不符 row=${i}`);
        return;
      }
      for (let k = 0; k < DIM; k++) {
        if (exp[k] !== got[k]) {
          note(entry.id, turn, `row=${i} (${kept[i].from}->${kept[i].to}) f${k + 1}: online=${got[k]} jsonl=${exp[k]}`);
          return;
        }
      }
    }
    const pr = line.c[line.c.length - 1];
    for (let k = 0; k < DIM; k++) {
      if (pr[k] !== (k === 24 ? 1 : 0)) { note(entry.id, turn, `伪候选行异常 f${k + 1}=${pr[k]}`); return; }
    }
    stats.match++;
  };

  while (!game.isOver() && game.turn < CAP) {
    const T = game.turn;
    if (T > firstMoveTurn && T < lastMoveTurn && !myMoveTurns.has(T)) comparePoint(null, T);
    while (r.moves.length > mi && r.moves[mi].turn <= game.turn) {
      const m = r.moves[mi++];
      if (m.index === me && m.turn !== lastDecisionTurn) {
        lastDecisionTurn = m.turn;
        comparePoint(m, m.turn);
      }
      if (m.index === me) prevMove = { start: m.start, end: m.end, turn: m.turn };
      game.handleAttack(m.index, m.start, m.end, m.is50);
    }
    game.update();
  }

  if (queue.length) {
    stats.total += queue.length;
    note(entry.id, -1, `jsonl 剩余 ${queue.length} 行未消费`);
    queue.length = 0;
  }
}

function main() {
  const index = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, 'index.json'), 'utf8'));
  const nTrain = Math.floor(index.length * 0.9);
  const held = index.slice(nTrain);
  const nArg = parseInt(process.argv[2], 10);
  const sel = Number.isFinite(nArg) && nArg > 0 ? held.slice(0, nArg) : held;

  // heldout2.jsonl 按局 id 分组为顺序队列(兼容重复局 id: 顺序消费)
  const queues = new Map();
  const raw = fs.readFileSync(path.join(__dirname, 'heldout2.jsonl'), 'utf8').trim().split('\n');
  for (const ln of raw) {
    const o = JSON.parse(ln);
    if (!queues.has(o.g)) queues.set(o.g, []);
    queues.get(o.g).push(o);
  }

  for (let i = 0; i < sel.length; i++) {
    const entry = sel[i];
    checkGame(entry, queues.get(entry.id) || []);
    if ((i + 1) % 10 === 0) {
      console.error(`... ${i + 1}/${sel.length} games, parity ${stats.match}/${stats.total}`);
    }
  }

  for (const m of mismatches) console.error('MISMATCH ' + m);
  console.log(`games=${sel.length} 决策点一致率 ${stats.match}/${stats.total}` +
    (stats.total ? ` (${(stats.match / stats.total * 100).toFixed(2)}%)` : ''));
  console.log(`PARITY=${stats.match}/${stats.total}`);
  process.exit(stats.total > 0 && stats.match === stats.total ? 0 : 1);
}

main();
