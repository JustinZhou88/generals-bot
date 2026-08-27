'use strict';

// 防守测试:造"速攻手"对手(攒到阈值就直扑对方将军,知道将军位置=模拟会侦察的人类),
// 分早鲨(低阈值、早发动)和中期偷家(高阈值)两档,量化候选方的将军存活率。
// 这是普通擂台(对手不偷家)测不出来的能力,也正是实战一直输的那一环。

const Game = require('./replays/Game');
const { GameState } = require('./src/gamestate');
const { dijkstra, buildPath, marchCost } = require('./src/pathfinding');
const { injectView, loadReplays } = require('./arena');

// cheat=true: 从第0回合就知道敌将位置(最坏情况,基本无解);
// cheat=false(真实): 只有自己侦察发现了敌将(knownGenerals)才发动强攻,像真人。
function makeRusher(Base, rushMin, cheat = false) {
  return class Rusher extends Base {
    constructor(gs, enemyGen) { super(gs); this.cheatGen = enemyGen; }
    nextMove() {
      const gs = this.gs;
      if (gs.myGeneral() === undefined || gs.myGeneral() < 0) return null;
      const q = this.popValidQueued();
      if (q && this.queuePurpose === 'rush') return q;
      // 目标敌将:作弊则直接给,否则用自己发现的
      let target = -1;
      if (cheat) target = this.cheatGen;
      else for (const [p, g] of gs.knownGenerals) { if (p !== gs.playerIndex) { target = g; break; } }
      if (target >= 0) {
        const src = this.biggestArmyTile([]);
        if (src !== -1 && gs.armies[src] >= rushMin) {
          const { prev, dist } = dijkstra(gs, src, marchCost(gs, { allowCity: true, target }));
          if (dist[target] < Infinity) return this.planPath(buildPath(prev, target), 'rush');
        }
      }
      return super.nextMove();
    }
  };
}

function playVsRusher(replay, Candidate, Rusher, candP0, cap = 1500) {
  const game = Game.createFromReplay(replay);
  const cP = candP0 ? 0 : 1, rP = candP0 ? 1 : 0;
  const gsC = new GameState(), gsR = new GameState();
  gsC.start({ playerIndex: cP, replay_id: 'd', usernames: ['C', 'R'], teams: undefined });
  gsR.start({ playerIndex: rP, replay_id: 'd', usernames: ['C', 'R'], teams: undefined });
  const cand = new Candidate(gsC);
  const rush = new Rusher(gsR, replay.generals[cP]);
  while (!game.isOver() && game.turn < cap) {
    injectView(gsC, game, cP); let a = null; try { a = cand.nextMove(); } catch (e) {}
    injectView(gsR, game, rP); let b = null; try { b = rush.nextMove(); } catch (e) {}
    if (a) game.inputBuffer[cP].push([a.from, a.to, !!a.is50]);
    if (b) game.inputBuffer[rP].push([b.from, b.to, !!b.is50]);
    game.update();
  }
  const candDead = game.deaths.indexOf(game.sockets[cP]) >= 0;
  const deathTurn = candDead ? null : undefined;
  return { survived: !candDead };
}

function survival(Candidate, Rusher) {
  const replays = loadReplays();
  let s = 0, n = 0;
  for (const r of replays) for (const p0 of [true, false]) { if (playVsRusher(r, Candidate, Rusher, p0).survived) s++; n++; }
  return { s, n, rate: s / n };
}

if (require.main === module) {
  const { Strategy } = require('./src/strategy');       // 待测(当前 v3)
  const { Strategy: V1 } = require('./src/strategy_v1'); // 速攻手基础用 v1
  const early = makeRusher(V1, 18);  // 早鲨:攒到 18 就冲
  const mid = makeRusher(V1, 40);    // 中期偷家:攒到 40 才冲
  const e = survival(Strategy, early), m = survival(Strategy, mid);
  console.log('当前 v3 将军存活率:');
  console.log(`  vs 早鲨(阈值18):  ${(e.rate * 100).toFixed(1)}%  (${e.s}/${e.n})`);
  console.log(`  vs 中期偷家(阈值40): ${(m.rate * 100).toFixed(1)}%  (${m.s}/${m.n})`);
}

module.exports = { makeRusher, survival, playVsRusher };
