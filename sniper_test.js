'use strict';

// 斩首测试:构造一个"狙击手"对手,一旦攒够兵就直扑对方将军(它知道将军位置,
// 模拟会侦察、会偷家的人类)。用它来衡量"守家"是否真的有效——这是普通擂台
// (对手不偷家)看不见的能力,也正是实战输给人类的那个破绽。

const fs = require('fs');
const path = require('path');
const Game = require('./replays/Game');
const { GameState } = require('./src/gamestate');
const { dijkstra, buildPath, marchCost } = require('./src/pathfinding');
const { injectView, loadReplays } = require('./arena');

// 狙击手:以某个基础策略扩张成长,攒到 25+ 兵就沿最短路直扑指定敌将
function makeSniper(BaseStrategy) {
  return class Sniper extends BaseStrategy {
    constructor(gs, enemyGen) { super(gs); this.enemyGen = enemyGen; }
    nextMove() {
      const gs = this.gs;
      if (gs.myGeneral() === undefined || gs.myGeneral() < 0) return null;
      const q = this.popValidQueued();
      if (q && this.queuePurpose === 'rush') return q;
      const src = this.biggestArmyTile([]);
      if (src !== -1 && gs.armies[src] >= 25) {
        const { prev, dist } = dijkstra(gs, src, marchCost(gs, { allowCity: true, target: this.enemyGen }));
        if (dist[this.enemyGen] < Infinity) return this.planPath(buildPath(prev, this.enemyGen), 'rush');
      }
      return super.nextMove();
    }
  };
}

function playVsSniper(replay, Candidate, Sniper, candidateIsP0, cap = 1500) {
  const game = Game.createFromReplay(replay);
  const cP = candidateIsP0 ? 0 : 1, sP = candidateIsP0 ? 1 : 0;
  const gsC = new GameState(), gsS = new GameState();
  gsC.start({ playerIndex: cP, replay_id: 's', usernames: ['C', 'S'], teams: undefined });
  gsS.start({ playerIndex: sP, replay_id: 's', usernames: ['C', 'S'], teams: undefined });
  const cand = new Candidate(gsC);
  const snip = new Sniper(gsS, replay.generals[cP]); // 狙击手瞄准候选者的将军
  while (!game.isOver() && game.turn < cap) {
    injectView(gsC, game, cP); let a = null; try { a = cand.nextMove(); } catch (e) {}
    injectView(gsS, game, sP); let b = null; try { b = snip.nextMove(); } catch (e) {}
    if (a) game.inputBuffer[cP].push([a.from, a.to, !!a.is50]);
    if (b) game.inputBuffer[sP].push([b.from, b.to, !!b.is50]);
    game.update();
  }
  const candDead = game.deaths.indexOf(game.sockets[cP]) >= 0;
  return !candDead; // 候选者将军是否活下来(存活=抗住了狙击)
}

function survivalRate(replays, Candidate, Sniper) {
  let survived = 0, total = 0;
  for (const r of replays) {
    for (const p0 of [true, false]) { if (playVsSniper(r, Candidate, Sniper, p0)) survived++; total++; }
  }
  return { survived, total, rate: survived / total };
}

if (require.main === module) {
  const { Strategy } = require('./src/strategy');
  const { Strategy: V1 } = require('./src/strategy_v1');
  const Sniper = makeSniper(V1); // 用 v1(激进)当狙击手基础
  const replays = loadReplays();
  const nowR = survivalRate(replays, Strategy, Sniper);
  const v1R = survivalRate(replays, V1, Sniper);
  console.log('面对"斩首狙击手"的将军存活率:');
  console.log(`  守家版:  ${(nowR.rate * 100).toFixed(1)}%  (${nowR.survived}/${nowR.total})`);
  console.log(`  v1(无守家): ${(v1R.rate * 100).toFixed(1)}%  (${v1R.survived}/${v1R.total})`);
}

module.exports = { makeSniper, survivalRate };
