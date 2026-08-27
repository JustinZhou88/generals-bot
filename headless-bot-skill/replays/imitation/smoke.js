'use strict';

/**
 * 单局冒烟测试:ImitationStrategy 自对弈 + 对打现役 Strategy 各一局。
 * 要求:nextMove 全程不抛异常(不做 try/catch 吞错)、模仿方 move 数 > 100。
 *
 * 运行: node replays/imitation/smoke.js
 */

const Game = require('../Game');
const { injectView, loadReplays } = require('../../arena');
const { GameState } = require('../../src/gamestate');
const { ImitationStrategy } = require('../../src/imitation');
const { Strategy } = require('../../src/strategy');

const CAP = 600;

function smokeGame(replay, MakeA, MakeB, label) {
  const game = Game.createFromReplay(replay);
  const gsA = new GameState(), gsB = new GameState();
  gsA.start({ playerIndex: 0, replay_id: 'smoke', usernames: ['A', 'B'], teams: undefined });
  gsB.start({ playerIndex: 1, replay_id: 'smoke', usernames: ['A', 'B'], teams: undefined });
  const bots = [new MakeA(gsA), new MakeB(gsB)];
  const gss = [gsA, gsB];
  const moveCnt = [0, 0];

  while (!game.isOver() && game.turn < CAP) {
    for (let p = 0; p < 2; p++) {
      injectView(gss[p], game, p);
      const mv = bots[p].nextMove(); // 故意不 try/catch:抛异常即失败
      if (mv && Number.isInteger(mv.from) && Number.isInteger(mv.to)) {
        moveCnt[p]++;
        game.inputBuffer[p].push([mv.from, mv.to, !!mv.is50]);
      }
    }
    game.update();
  }
  console.log(`[${label}] turns=${game.turn} 半回合  moveA=${moveCnt[0]}  moveB=${moveCnt[1]}`);
  return moveCnt;
}

const replays = loadReplays();
if (!replays.length) { console.error('no replays'); process.exit(1); }

// 局1: 模仿 vs 模仿
const c1 = smokeGame(replays[0], ImitationStrategy, ImitationStrategy, '模仿 self-play');
// 局2: 模仿 vs 现役 Strategy
const c2 = smokeGame(replays[1] || replays[0], ImitationStrategy, Strategy, '模仿 vs Strategy');

let ok = true;
if (c1[0] <= 100 || c1[1] <= 100) { console.error('FAIL: self-play move 数 <= 100'); ok = false; }
if (c2[0] <= 100) { console.error('FAIL: vs Strategy 模仿方 move 数 <= 100'); ok = false; }
console.log(ok ? 'SMOKE OK' : 'SMOKE FAIL');
process.exit(ok ? 0 : 1);
