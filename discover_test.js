'use strict';

// 直接量"找将能力":自对弈中,候选方是否/何时发现敌方将军(进入 knownGenerals)。
// 这是当前 bot 完全缺失的一环——找不到将军,斩首永远不触发。

const Game = require('./replays/Game');
const { GameState } = require('./src/gamestate');
const { injectView, loadReplays } = require('./arena');

function discoveryGame(replay, Candidate, Opponent, candP0, cap = 800) {
  const game = Game.createFromReplay(replay);
  const cP = candP0 ? 0 : 1, oP = candP0 ? 1 : 0;
  const gsC = new GameState(), gsO = new GameState();
  gsC.start({ playerIndex: cP, replay_id: 'd', usernames: ['C', 'O'], teams: undefined });
  gsO.start({ playerIndex: oP, replay_id: 'd', usernames: ['C', 'O'], teams: undefined });
  const cand = new Candidate(gsC), opp = new Opponent(gsO);
  let found = null, candDeadTurn = null;
  while (!game.isOver() && game.turn < cap) {
    injectView(gsC, game, cP); let a = null; try { a = cand.nextMove(); } catch (e) {}
    injectView(gsO, game, oP); let b = null; try { b = opp.nextMove(); } catch (e) {}
    if (a) game.inputBuffer[cP].push([a.from, a.to, !!a.is50]);
    if (b) game.inputBuffer[oP].push([b.from, b.to, !!b.is50]);
    game.update();
    if (found === null && gsC.knownGenerals.has(oP)) found = Math.floor(game.turn / 2);
    if (candDeadTurn === null && game.deaths.indexOf(game.sockets[cP]) >= 0) candDeadTurn = Math.floor(game.turn / 2);
  }
  return { found, candDeadTurn };
}

function report(name, Candidate, Opponent) {
  const replays = loadReplays();
  let foundCount = 0, total = 0;
  const turns = [];
  for (const r of replays) {
    for (const p0 of [true, false]) {
      const g = discoveryGame(r, Candidate, Opponent, p0);
      total++;
      if (g.found !== null) { foundCount++; turns.push(g.found); }
    }
  }
  turns.sort((a, b) => a - b);
  const median = turns.length ? turns[Math.floor(turns.length / 2)] : '-';
  console.log(`${name}: 找到敌将 ${foundCount}/${total} 局 (${(foundCount / total * 100).toFixed(0)}%)  中位发现回合 ${median}`);
  return { rate: foundCount / total, median };
}

if (require.main === module) {
  const { Strategy: V1 } = require('./src/strategy_v1');
  const { Strategy } = require('./src/strategy');
  report('v1(基线,无侦察) vs v1', V1, V1);
  report('侦察版 vs v1        ', Strategy, V1);
}

module.exports = { discoveryGame, report };
