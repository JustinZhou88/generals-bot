'use strict';

// 开局基准:让 bot 单独在真实地图上扩张(对手不动),量 t25 / t50 地块。
// 这是开局效率最干净的 fitness 函数。强者基准: t25~24, t50~48。

const fs = require('fs');
const path = require('path');
const Game = require('./replays/Game');
const { GameState } = require('./src/gamestate');
const { Strategy } = require('./src/strategy');
const { injectView, loadReplays } = require('./arena');

function openingLand(replay, cap = 100) {
  const game = Game.createFromReplay(replay);
  const gs = new GameState();
  gs.start({ playerIndex: 0, replay_id: 'op', usernames: ['A', 'B'], teams: undefined });
  const bot = new Strategy(gs);
  const sample = {};
  while (game.turn < cap) {
    injectView(gs, game, 0);
    let mv = null;
    try { mv = bot.nextMove(); } catch (e) { mv = null; }
    if (mv && Number.isInteger(mv.from) && Number.isInteger(mv.to)) {
      game.inputBuffer[0].push([mv.from, mv.to, !!mv.is50]);
    }
    game.update();
    if (game.turn === 50) sample.t25 = game.scores.find((s) => s.i === 0).tiles;
    if (game.turn === 100) sample.t50 = game.scores.find((s) => s.i === 0).tiles;
  }
  return sample;
}

const replays = loadReplays();
let s25 = 0, s50 = 0, n = 0;
for (const r of replays) {
  const s = openingLand(r);
  if (s.t25 != null && s.t50 != null) { s25 += s.t25; s50 += s.t50; n++; }
}
console.log(`${n} 张图,bot 单独扩张:`);
console.log(`  平均 t25 地块: ${(s25 / n).toFixed(1)}  (强者 ~24)`);
console.log(`  平均 t50 地块: ${(s50 / n).toFixed(1)}  (强者 ~48)`);
