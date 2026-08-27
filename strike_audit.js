'use strict';
/*
 * strike_audit.js — 量"斩首打出去之后到底发生了什么"
 *
 * 背景:exec_audit.js 显示 strike 是计划步数最长(14.57 步)、触发最少(1.2 次/局)的行为,
 * 也是全局风险最高的动作 —— 要么直接赢,要么一大坨兵折在敌区。
 * 但此前从没测过它的**结局**:斩到了?半路被打断?兵折了多少?打完局面是变好还是变坏?
 *
 * 每次 strike 发动时记账,并在之后 HORIZON 个半回合回头结算(用引擎真值,不用迷雾视角)。
 *
 * 用法: node strike_audit.js --cand ./src/strategy_v51.js --games 60
 */

const fs = require('fs');
const path = require('path');
const Game = require('./replays/Game');
const { GameState } = require('./src/gamestate');
const { injectView } = require('./arena');

const CORPUS = path.join(__dirname, 'replays', 'corpus');
const CAP = 1500;
const HORIZON = 60; // 半回合:结算窗口

const argv = process.argv.slice(2);
const opt = { cand: './src/strategy_v51.js', games: 60, handoff: 100, seed: 1 };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--cand') opt.cand = argv[++i];
  else if (argv[i] === '--games') opt.games = parseInt(argv[++i], 10);
  else if (argv[i] === '--seed') opt.seed = parseInt(argv[++i], 10);
}

const CandMod = require(opt.cand);
const Cand = CandMod.Strategy || CandMod;
const FbMod = require('./src/strategy_v29.js');
const Fallback = FbMod.Strategy || FbMod;

const strikes = [];
let pending = [];       // 等待结算的 strike
let curGame = null, curMe = -1, curOpp = -1;
let livePlan = null;

const origPlanPath = Cand.prototype.planPath;
const origPop = Cand.prototype.popValidQueued;

Cand.prototype.planPath = function (pathArr, purpose) {
  // 半路夭折的斩首损失巨大(净地 -28.9 vs 走完的 +13.2),必须查清是谁截断的:
  // 是别的行为抢先(planPath 会清空队列,而且没有"续接"机制),还是路径失效。
  if (livePlan) {
    livePlan.rec.executedSteps = livePlan.executed;
    if (livePlan.rec.executedSteps < livePlan.rec.pathLen) livePlan.rec.cutBy = purpose || '?';
    livePlan = null;
  }
  if (purpose === 'strike' && curGame) {
    const gs = this.gs;
    const target = pathArr[pathArr.length - 1];
    const s = curGame.scores;
    const rec = {
      turn: curGame.turn,
      committed: gs.armies[pathArr[0]] - 1,
      pathLen: pathArr.length - 1,
      genArmy: gs.armies[target],
      executedSteps: 0,
      myLand0: s[curMe].tiles, myArmy0: s[curMe].total,
      opLand0: s[curOpp].tiles, opArmy0: s[curOpp].total,
      killed: false, died: false, settled: false,
    };
    strikes.push(rec);
    pending.push(rec);
    const r = origPlanPath.call(this, pathArr, purpose);
    livePlan = { rec, executed: this.queue.length === 0 ? 1 : 1 };
    return r;
  }
  return origPlanPath.call(this, pathArr, purpose);
};

Cand.prototype.popValidQueued = function () {
  const before = this.queue.length;
  const mv = origPop.call(this);
  if (mv && livePlan) livePlan.executed++;
  // 返回 null 且队列被清空 = 路径失效(兵没跟上/地丢了),strategy_v51.js:533
  if (!mv && before > 0 && livePlan) {
    livePlan.rec.executedSteps = livePlan.executed;
    livePlan.rec.cutBy = '路径失效';
    livePlan = null;
  }
  return mv;
};

function listCorpus() {
  return fs.readdirSync(CORPUS)
    .filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'pick.json')
    .sort();
}

function settle(force) {
  const s = curGame.scores;
  const keep = [];
  for (const rec of pending) {
    if (!force && curGame.turn - rec.turn < HORIZON) { keep.push(rec); continue; }
    rec.dLand = s[curMe].tiles - rec.myLand0;
    rec.dArmy = s[curMe].total - rec.myArmy0;
    rec.dOpLand = s[curOpp].tiles - rec.opLand0;
    rec.dOpArmy = s[curOpp].total - rec.opArmy0;
    rec.killed = curGame.deaths.indexOf(curGame.sockets[curOpp]) >= 0;
    rec.died = curGame.deaths.indexOf(curGame.sockets[curMe]) >= 0;
    rec.settled = true;
  }
  pending = keep;
}

function play(replay, corpusIdx) {
  const game = Game.createFromReplay(replay);
  const oppP = corpusIdx, myP = 1 - corpusIdx;
  curGame = game; curMe = myP; curOpp = oppP; pending = []; livePlan = null;
  const gsMe = new GameState(), gsOpp = new GameState();
  gsMe.start({ playerIndex: myP, replay_id: 'sa', usernames: ['me', 'corpus'], teams: undefined });
  gsOpp.start({ playerIndex: oppP, replay_id: 'sa', usernames: ['me', 'corpus'], teams: undefined });
  const me = new Cand(gsMe), fb = new Fallback(gsOpp);
  const oppMoves = replay.moves.filter((m) => m.index === oppP).sort((a, b) => a.turn - b.turn);
  let mi = 0;

  while (!game.isOver() && game.turn < CAP) {
    injectView(gsMe, game, myP);
    let mv = null; try { mv = me.nextMove(); } catch (e) {}
    if (mv && Number.isInteger(mv.from)) game.inputBuffer[myP].push([mv.from, mv.to, !!mv.is50]);
    if (game.turn < opt.handoff) {
      while (mi < oppMoves.length && oppMoves[mi].turn <= game.turn) {
        const m = oppMoves[mi++];
        game.inputBuffer[oppP].push([m.start, m.end, !!m.is50]);
      }
    } else {
      injectView(gsOpp, game, oppP);
      let ov = null; try { ov = fb.nextMove(); } catch (e) {}
      if (ov && Number.isInteger(ov.from)) game.inputBuffer[oppP].push([ov.from, ov.to, !!ov.is50]);
    }
    game.update();
    settle(false);
  }
  if (livePlan) { livePlan.rec.executedSteps = livePlan.executed; livePlan = null; }
  settle(true);
}

const files = listCorpus();
let rng = opt.seed;
const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
let played = 0, wins = 0;
for (let i = 0; i < opt.games && files.length; i++) {
  const f = files[Math.floor(rand() * files.length)];
  let rep;
  try { rep = JSON.parse(fs.readFileSync(path.join(CORPUS, f), 'utf8')); } catch (e) { continue; }
  if (!rep.generals || rep.generals.length !== 2) continue;
  try { play(rep, i % 2); played++; if (curGame.deaths.indexOf(curGame.sockets[curMe]) < 0) wins++; } catch (e) {}
}

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const q = (a, f) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };

const S = strikes.filter((r) => r.settled);
console.log(`策略 ${opt.cand}   ${played} 局(胜 ${wins}),共发动 strike ${strikes.length} 次,已结算 ${S.length} 次`);
console.log(`结算窗口 = 发动后 ${HORIZON} 个半回合\n`);
if (!S.length) { console.log('无数据'); process.exit(0); }

console.log(`发动时:`);
console.log(`  投入兵力      中位 ${q(S.map((r) => r.committed), 0.5)}   均值 ${mean(S.map((r) => r.committed)).toFixed(1)}`);
console.log(`  路径长度      中位 ${q(S.map((r) => r.pathLen), 0.5)}   均值 ${mean(S.map((r) => r.pathLen)).toFixed(1)}`);
console.log(`  敌将驻军      中位 ${q(S.map((r) => r.genArmy), 0.5)}   均值 ${mean(S.map((r) => r.genArmy)).toFixed(1)}`);
console.log(`  ★计划走完比例 ${(mean(S.map((r) => Math.min(1, r.executedSteps / Math.max(1, r.pathLen)))) * 100).toFixed(1)}%`);

const killed = S.filter((r) => r.killed);
console.log(`\n结局:`);
console.log(`  ★斩首成功  ${killed.length}/${S.length} = ${(killed.length / S.length * 100).toFixed(1)}%`);
console.log(`   反被斩杀  ${S.filter((r) => r.died).length}/${S.length} = ${(S.filter((r) => r.died).length / S.length * 100).toFixed(1)}%`);

const fail = S.filter((r) => !r.killed && !r.died);
console.log(`\n未分胜负的 ${fail.length} 次,窗口内净变化(我方 / 对方):`);
console.log(`  地   ${mean(fail.map((r) => r.dLand)).toFixed(1).padStart(7)} / ${mean(fail.map((r) => r.dOpLand)).toFixed(1).padStart(7)}   → 相对 ${(mean(fail.map((r) => r.dLand)) - mean(fail.map((r) => r.dOpLand))).toFixed(1)}`);
console.log(`  兵   ${mean(fail.map((r) => r.dArmy)).toFixed(1).padStart(7)} / ${mean(fail.map((r) => r.dOpArmy)).toFixed(1).padStart(7)}   → 相对 ${(mean(fail.map((r) => r.dArmy)) - mean(fail.map((r) => r.dOpArmy))).toFixed(1)}`);

// 按"是否走完计划"分组:半路夭折的斩首是不是特别亏
const done = S.filter((r) => r.executedSteps >= r.pathLen);
const cut = S.filter((r) => r.executedSteps < r.pathLen);
const rate = (a) => a.length ? `${(a.filter((r) => r.killed).length / a.length * 100).toFixed(1)}%` : '-';
console.log(`\n按是否走完计划分组:`);
console.log(`  走完的     ${done.length} 次,斩首率 ${rate(done)},净地 ${mean(done.map((r) => r.dLand - r.dOpLand)).toFixed(1)}`);
console.log(`  半路夭折的 ${cut.length} 次,斩首率 ${rate(cut)},净地 ${mean(cut.map((r) => r.dLand - r.dOpLand)).toFixed(1)}`);

console.log(`\n★ 半路夭折的 ${cut.length} 次,是被谁截断的:`);
const by = {};
for (const r of cut) { const k = r.cutBy || '(局终/未记录)'; (by[k] = by[k] || []).push(r); }
for (const k of Object.keys(by).sort((a, b) => by[b].length - by[a].length)) {
  const g = by[k];
  console.log(`  ${k.padEnd(12)} ${String(g.length).padStart(3)} 次 = ${(g.length / cut.length * 100).toFixed(1).padStart(5)}%   ` +
    `斩首率 ${rate(g).padStart(6)}   净地 ${mean(g.map((r) => r.dLand - r.dOpLand)).toFixed(1).padStart(7)}   ` +
    `已走 ${mean(g.map((r) => r.executedSteps)).toFixed(1)}/${mean(g.map((r) => r.pathLen)).toFixed(1)} 步`);
}

// 兵力充裕度 vs 成功率
console.log(`\n按"投入 / 敌将驻军"倍数分组:`);
for (const [lo, hi] of [[0, 2], [2, 4], [4, 8], [8, 1e9]]) {
  const g = S.filter((r) => { const x = r.committed / Math.max(1, r.genArmy); return x >= lo && x < hi; });
  if (!g.length) continue;
  console.log(`  ${lo}~${hi === 1e9 ? '∞' : hi} 倍: ${String(g.length).padStart(4)} 次,斩首率 ${rate(g).padStart(6)},净地 ${mean(g.map((r) => r.dLand - r.dOpLand)).toFixed(1)}`);
}
