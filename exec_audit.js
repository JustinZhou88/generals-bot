'use strict';
/*
 * exec_audit.js — 量"执行质量",不量胜率
 *
 * 背景:时机(v36 AUC 0.85)、规模(v32)、站位(v35)、聚兵方式(v31/33/34)全部改过,
 * 全部无增益。共同点是它们只改"何时/何地/多少",没改"打起来之后怎么打"。
 * 所以先把执行本身量出来,再决定改哪里。
 *
 * 两个指标:
 *  (A) 规划效率 —— raidWalk/expansionWalk 规划完,手里还剩多少兵没花掉。
 *      剩得多 = 贪心单步前瞻走进死胡同,兵白带了。
 *  (B) 执行完整度 —— planPath 排了 N 步队,实际走了几步就被下一次 planPath 顶掉。
 *      顶掉率高 = 行为互相打断,长程计划根本没机会兑现。
 *
 * 用法: node exec_audit.js --cand ./src/strategy_v51.js --games 60
 */

const fs = require('fs');
const path = require('path');
const Game = require('./replays/Game');
const { GameState } = require('./src/gamestate');
const { injectView } = require('./arena');

const CORPUS = path.join(__dirname, 'replays', 'corpus');
const CAP = 1500;

const argv = process.argv.slice(2);
const opt = { cand: './src/strategy_v51.js', games: 60, handoff: 100, seed: 1 };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--cand') opt.cand = argv[++i];
  else if (argv[i] === '--games') opt.games = parseInt(argv[++i], 10);
  else if (argv[i] === '--handoff') opt.handoff = parseInt(argv[++i], 10);
  else if (argv[i] === '--seed') opt.seed = parseInt(argv[++i], 10);
}

const CandMod = require(opt.cand);
const Cand = CandMod.Strategy || CandMod;
const FbMod = require('./src/strategy_v29.js');
const Fallback = FbMod.Strategy || FbMod;

// ---------- 挂钩子 ----------
const stats = {
  walks: [],           // {kind, init, spent, left, steps, enemyTiles}
  plans: [],           // {purpose, planned, executed}
};
let livePlan = null;   // 当前在跑的计划

const origRaidWalk = Cand.prototype.raidWalk;
const origPlanPath = Cand.prototype.planPath;

Cand.prototype.raidWalk = function (src) {
  const p = origRaidWalk.call(this, src);
  const gs = this.gs;
  const init = gs.armies[src] - 1;
  let spent = 0, enemyTiles = 0;
  for (let i = 1; i < p.length; i++) {
    const t = p[i];
    if (gs.isEnemy(t)) { spent += gs.armies[t] + 1; enemyTiles++; }
    else spent += 1;
  }
  // 停在哪、为什么停:看末端格子四周未访问的邻居都是些什么。
  // 假设 raidWalk 因为"不允许经过自己的地"而早停 —— 这里直接验。
  const end = p[p.length - 1];
  const seen = new Set(p);
  let nOwn = 0, nEnemyTooDear = 0, nBlocked = 0, nFree = 0;
  const strengthLeft = init - spent;
  for (const n of gs.neighbors(end)) {
    if (seen.has(n)) continue;
    if (!gs.isPassable(n)) { nBlocked++; continue; }
    if (gs.isMine(n)) { nOwn++; continue; }
    if (gs.isCity(n)) { nBlocked++; continue; }
    if (gs.isEnemy(n)) { if (strengthLeft - (gs.armies[n] + 1) < 1) nEnemyTooDear++; else nFree++; continue; }
    // raidWalk 只认**已知**空地(terrain === -1);迷雾(-3/-4)它根本不走,
    // 先前把迷雾也算成"可走",导致出现"还有路却停了"这种不可能的分类。
    if (gs.terrain[n] === -1 && strengthLeft >= 2) nFree++;
    else nBlocked++;
  }
  stats.walks.push({ kind: 'raid', init, spent, left: strengthLeft, steps: p.length - 1, enemyTiles,
    nOwn, nEnemyTooDear, nBlocked, nFree });
  return p;
};

Cand.prototype.planPath = function (pathArr, purpose) {
  // 上一个计划还没走完就被顶掉了 —— 记账
  if (livePlan && livePlan.planned > 0) {
    stats.plans.push(livePlan);
  }
  // 必须在调 origPlanPath **之前**建好新计划:planPath 内部最后会自己调一次
  // popValidQueued(strategy_v51.js:522),那一步属于新计划。先前写在后面,
  // 导致新计划的首步记到上一个计划头上、planned 又少算 1 —— 完成率跑出 151% 这种不可能的值。
  livePlan = { purpose: purpose || '?', planned: Math.max(0, pathArr.length - 1), executed: 0 };
  return origPlanPath.call(this, pathArr, purpose);
};

// 每次真正出招时,如果是从队列里弹出来的,就给当前计划记一步
const origPop = Cand.prototype.popValidQueued;
Cand.prototype.popValidQueued = function () {
  const mv = origPop.call(this);
  if (mv && livePlan) livePlan.executed++;
  return mv;
};

// ---------- 跑对局 ----------
function listCorpus() {
  return fs.readdirSync(CORPUS)
    .filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'pick.json')
    .sort();
}

function play(replay, corpusIdx) {
  const game = Game.createFromReplay(replay);
  const oppP = corpusIdx, myP = 1 - corpusIdx;
  const gsMe = new GameState(), gsOpp = new GameState();
  gsMe.start({ playerIndex: myP, replay_id: 'ea', usernames: ['me', 'corpus'], teams: undefined });
  gsOpp.start({ playerIndex: oppP, replay_id: 'ea', usernames: ['me', 'corpus'], teams: undefined });
  const me = new Cand(gsMe), fb = new Fallback(gsOpp);
  const oppMoves = replay.moves.filter((m) => m.index === oppP).sort((a, b) => a.turn - b.turn);
  let mi = 0;
  livePlan = null;

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
  }
  if (livePlan && livePlan.planned > 0) stats.plans.push(livePlan);
}

const files = listCorpus();
let rng = opt.seed;
const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
let played = 0;
for (let i = 0; i < opt.games && files.length; i++) {
  const f = files[Math.floor(rand() * files.length)];
  let rep;
  try { rep = JSON.parse(fs.readFileSync(path.join(CORPUS, f), 'utf8')); } catch (e) { continue; }
  if (!rep.generals || rep.generals.length !== 2) continue;
  try { play(rep, i % 2); played++; } catch (e) {}
}

// ---------- 报告 ----------
const q = (arr, f) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

console.log(`策略 ${opt.cand}   ${played} 局\n`);

// tryRaid 会把"走不动/吃不到敌地"的规划直接丢弃(strategy_v51.js:387),
// 那些调用没变成实际行动,混在一起会把中位数压成 0。只统计真正成为 raid 的。
const wAll = stats.walks;
const w = wAll.filter((x) => x.steps >= 1 && x.enemyTiles >= 1);
console.log(`【A】raidWalk 规划效率  (调用 ${wAll.length} 次,其中 ${w.length} 次成为实际 raid,` +
  `${(100 - w.length / Math.max(1, wAll.length) * 100).toFixed(1)}% 空转被丢弃)`);
if (w.length) {
  const leftRatio = w.map((x) => x.init > 0 ? x.left / x.init : 0);
  console.log(`  出发兵力      中位 ${q(w.map((x) => x.init), 0.5)}   均值 ${mean(w.map((x) => x.init)).toFixed(1)}`);
  console.log(`  规划步数      中位 ${q(w.map((x) => x.steps), 0.5)}   均值 ${mean(w.map((x) => x.steps)).toFixed(1)}`);
  console.log(`  吃到的敌格    中位 ${q(w.map((x) => x.enemyTiles), 0.5)}   均值 ${mean(w.map((x) => x.enemyTiles)).toFixed(2)}`);
  console.log(`  ★ 剩余未花兵力 中位 ${q(w.map((x) => x.left), 0.5)}   均值 ${mean(w.map((x) => x.left)).toFixed(1)}`);
  console.log(`  ★ 剩余占比     中位 ${(q(leftRatio, 0.5) * 100).toFixed(1)}%   均值 ${(mean(leftRatio) * 100).toFixed(1)}%`);
  const stuck = w.filter((x) => x.init > 5 && x.left / x.init > 0.5).length;
  console.log(`  带兵>5 却花不掉一半以上: ${stuck}/${w.filter((x) => x.init > 5).length} = ` +
    `${(stuck / Math.max(1, w.filter((x) => x.init > 5).length) * 100).toFixed(1)}%`);

  // 停下来时,末端还有兵(>1)却走不动的那些 —— 拆开看挡路的是什么
  const stopped = w.filter((x) => x.left > 1);
  if (stopped.length) {
    const onlyOwn = stopped.filter((x) => x.nOwn > 0 && x.nFree === 0 && x.nEnemyTooDear === 0).length;
    const anyOwn = stopped.filter((x) => x.nOwn > 0).length;
    const tooDear = stopped.filter((x) => x.nEnemyTooDear > 0 && x.nFree === 0 && x.nOwn === 0).length;
    const dead = stopped.filter((x) => x.nOwn === 0 && x.nFree === 0 && x.nEnemyTooDear === 0).length;
    console.log(`\n  停下来时还剩兵(>1)的 ${stopped.length} 次,末端未访问邻居的构成:`);
    console.log(`    ★ 只被自己的地挡住(允许穿越就能继续) ${onlyOwn} = ${(onlyOwn / stopped.length * 100).toFixed(1)}%`);
    console.log(`      旁边有自己的地(含混合情况)         ${anyOwn} = ${(anyOwn / stopped.length * 100).toFixed(1)}%`);
    console.log(`      只被"吃不起的敌兵"挡住             ${tooDear} = ${(tooDear / stopped.length * 100).toFixed(1)}%`);
    console.log(`      真死路(山/城/已访问)               ${dead} = ${(dead / stopped.length * 100).toFixed(1)}%`);
  }
}

const p = stats.plans;
console.log(`\n【B】planPath 执行完整度  (${p.length} 个计划)`);
if (p.length) {
  const byPurpose = {};
  for (const x of p) {
    const k = x.purpose;
    (byPurpose[k] = byPurpose[k] || []).push(x);
  }
  console.log(`  用途        计划数   计划步数(均)  实走步数(均)  ★完成率   一步没走就被顶掉`);
  const order = Object.keys(byPurpose).sort((a, b) => byPurpose[b].length - byPurpose[a].length);
  for (const k of order) {
    const a = byPurpose[k];
    const pl = mean(a.map((x) => x.planned)), ex = mean(a.map((x) => x.executed));
    const zero = a.filter((x) => x.executed === 0).length;
    console.log(`  ${k.padEnd(10)} ${String(a.length).padStart(6)}   ${pl.toFixed(2).padStart(10)}   ${ex.toFixed(2).padStart(10)}   ` +
      `${(ex / Math.max(0.001, pl) * 100).toFixed(1).padStart(6)}%   ${(zero / a.length * 100).toFixed(1).padStart(6)}%`);
  }
  const pl = mean(p.map((x) => x.planned)), ex = mean(p.map((x) => x.executed));
  console.log(`  ${'合计'.padEnd(9)} ${String(p.length).padStart(6)}   ${pl.toFixed(2).padStart(10)}   ${ex.toFixed(2).padStart(10)}   ${(ex / Math.max(0.001, pl) * 100).toFixed(1).padStart(6)}%`);
}
