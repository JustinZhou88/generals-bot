'use strict';
/**
 * bot 行为体检(bot-only,v21 自对弈)
 *  1) 空转片段:连续>=3半回合无动作的片段数/局(排除开局前24半回合)+ 最长片段
 *  2) 队列中断率:monkey-patch popValidQueued,前长度>0 && 调用后 queue 空 && 返回 null => 一次中断
 *  3) 各目的占比:monkey-patch planPath 统计 purpose 分布
 *  4) 波次完成度:开局4波中"队列自然耗尽"的比例(vs 被中断/被替换)
 */
const Game = require('../replays/Game');
const { injectView, loadReplays } = require('../arena');
const { GameState } = require('../src/gamestate');
const { Strategy } = require('../src/strategy');

// ---------- monkey-patch ----------
function stats(s) {
  if (!s._bc) {
    s._bc = {
      interruptions: 0,
      purposes: {},
      wavesLaunched: 0,
      wavesCompleted: 0,
      wavesBroken: 0,   // 路径失效被 popValidQueued 清空
      wavesReplaced: 0, // 被新计划(如 defend)顶掉
    };
  }
  return s._bc;
}

const origPlan = Strategy.prototype.planPath;
Strategy.prototype.planPath = function (path, purpose) {
  const st = stats(this);
  st.purposes[purpose] = (st.purposes[purpose] || 0) + 1;
  // 波还在飞行中(队列没走完)却被新计划顶掉 => 波中断
  if (this._bcWaveActive && this.queue.length > 0) {
    this._bcWaveActive = false;
    st.wavesReplaced++;
  }
  return origPlan.call(this, path, purpose);
};

const origPop = Strategy.prototype.popValidQueued;
Strategy.prototype.popValidQueued = function () {
  const st = stats(this);
  const before = this.queue.length;
  const res = origPop.call(this);
  if (before > 0 && res === null && this.queue.length === 0) {
    st.interruptions++;
    if (this._bcWaveActive) { this._bcWaveActive = false; st.wavesBroken++; }
  }
  // 自然耗尽:最后一步被合法弹出,队列走空
  if (res && this.queue.length === 0 && this._bcWaveActive) {
    this._bcWaveActive = false;
    st.wavesCompleted++;
  }
  return res;
};

const origWave = Strategy.prototype.openingWave;
Strategy.prototype.openingWave = function () {
  const st = stats(this);
  const before = this.waveCount || 0;
  const res = origWave.call(this);
  if ((this.waveCount || 0) > before && res) {
    st.wavesLaunched++;
    if (this.queue.length === 0) {
      // 单步波,planPath 内部一弹即空 => 直接完成
      st.wavesCompleted++;
    } else {
      this._bcWaveActive = true;
    }
  }
  return res;
};

// ---------- 自对弈 ----------
const replays = loadReplays().slice(0, 12);
const CAP = 700;
const IDLE_SKIP = 24; // 排除开局前24半回合
const IDLE_MIN = 3;

const perGame = []; // 每个 bot-局 一条记录

for (let gi = 0; gi < replays.length; gi++) {
  const r = replays[gi];
  const game = Game.createFromReplay(r);
  const gsA = new GameState();
  gsA.start({ playerIndex: 0, replay_id: 'x', usernames: ['A', 'B'], teams: undefined });
  const gsB = new GameState();
  gsB.start({ playerIndex: 1, replay_id: 'x', usernames: ['A', 'B'], teams: undefined });
  const A = new Strategy(gsA);
  const B = new Strategy(gsB);
  const bots = [A, B];
  const idle = [
    { streak: 0, segs: 0, longest: 0, segsLate: 0 },
    { streak: 0, segs: 0, longest: 0, segsLate: 0 },
  ];

  const closeStreak = (s, turn) => {
    if (s.streak >= IDLE_MIN) {
      s.segs++;
      if (turn >= 50) s.segsLate++;
    }
    if (s.streak > s.longest) s.longest = s.streak;
    s.streak = 0;
  };

  while (!game.isOver() && game.turn < CAP) {
    injectView(gsA, game, 0);
    let a = null; try { a = A.nextMove(); } catch (e) {}
    injectView(gsB, game, 1);
    let b = null; try { b = B.nextMove(); } catch (e) {}
    const mvs = [a, b];
    if (game.turn >= IDLE_SKIP) {
      for (let p = 0; p < 2; p++) {
        if (mvs[p] === null) idle[p].streak++;
        else closeStreak(idle[p], game.turn);
      }
    }
    if (a) game.inputBuffer[0].push([a.from, a.to, !!a.is50]);
    if (b) game.inputBuffer[1].push([b.from, b.to, !!b.is50]);
    game.update();
  }
  for (let p = 0; p < 2; p++) {
    closeStreak(idle[p], game.turn);
    const st = stats(bots[p]);
    perGame.push({
      map: gi,
      player: p,
      halfTurns: game.turn,
      idleSegs: idle[p].segs,
      idleSegsLate: idle[p].segsLate,
      idleLongest: idle[p].longest,
      interruptions: st.interruptions,
      purposes: st.purposes,
      wavesLaunched: st.wavesLaunched,
      wavesCompleted: st.wavesCompleted,
      wavesBroken: st.wavesBroken,
      wavesReplaced: st.wavesReplaced,
    });
  }
  console.log(`map ${gi}: 结束于 ${game.turn} 半回合`);
}

// ---------- 汇总 ----------
const n = perGame.length;
const sum = (f) => perGame.reduce((acc, g) => acc + f(g), 0);
const avg = (f) => sum(f) / n;

console.log(`\n===== 汇总(${replays.length} 张图 x 2 侧 = ${n} 个 bot-局)=====`);
console.log(`1) 空转片段(>=${IDLE_MIN}连续无动作,排除前${IDLE_SKIP}半回合):`);
console.log(`   平均 ${avg((g) => g.idleSegs).toFixed(2)} 段/局(其中 turn>=50 的 ${avg((g) => g.idleSegsLate).toFixed(2)} 段/局)`);
const longestAll = Math.max(...perGame.map((g) => g.idleLongest));
console.log(`   平均最长片段 ${avg((g) => g.idleLongest).toFixed(1)} 半回合,全场最长 ${longestAll} 半回合`);
console.log(`   最长片段分布: ${perGame.map((g) => g.idleLongest).sort((a, b) => a - b).join(',')}`);

console.log(`2) 队列中断: 平均 ${avg((g) => g.interruptions).toFixed(2)} 次/局`);
console.log(`   分布: ${perGame.map((g) => g.interruptions).sort((a, b) => a - b).join(',')}`);

const purposeTotal = {};
for (const g of perGame) for (const [k, v] of Object.entries(g.purposes)) purposeTotal[k] = (purposeTotal[k] || 0) + v;
const totPlans = Object.values(purposeTotal).reduce((a, b) => a + b, 0);
console.log(`3) 计划目的分布(共 ${totPlans} 次 planPath,平均 ${(totPlans / n).toFixed(1)} 次/局):`);
for (const k of Object.keys(purposeTotal).sort((a, b) => purposeTotal[b] - purposeTotal[a])) {
  console.log(`   ${k}: ${purposeTotal[k]} (${((purposeTotal[k] / totPlans) * 100).toFixed(1)}%)`);
}

const wl = sum((g) => g.wavesLaunched);
const wc = sum((g) => g.wavesCompleted);
const wb = sum((g) => g.wavesBroken);
const wr = sum((g) => g.wavesReplaced);
console.log(`4) 开局波次: 共发起 ${wl} 波(${(wl / n).toFixed(2)}/局),完整走完 ${wc} (${((wc / wl) * 100).toFixed(1)}%),路径失效中断 ${wb},被新计划顶掉 ${wr}`);
console.log(`   每局发起波数分布: ${perGame.map((g) => g.wavesLaunched).sort((a, b) => a - b).join(',')}`);
