'use strict';

/**
 * 评估B:ImitationStrategy vs 现役 src/strategy.js(v23 系)对战胜率。
 * 10 图 x 正反手 = 20 局,cap 1200 半回合,直接用 arena 的 runMatch。
 *
 * 运行: node replays/imitation/eval_arena.js [N图]
 */

const { runMatch, loadReplays } = require('../../arena');
const { ImitationStrategy } = require('../../src/imitation');
const { Strategy } = require('../../src/strategy');

const n = parseInt(process.argv[2], 10);
const nMaps = Number.isFinite(n) && n > 0 ? n : 10;
const replays = loadReplays().slice(0, nMaps);

console.log(`ImitationStrategy vs Strategy(现役)  ${replays.length} 图 x 正反手,cap 1200 半回合`);
const res = runMatch(replays, ImitationStrategy, Strategy, 1200);
console.log(`共 ${res.total} 局: 模仿胜 ${res.aWins}  现役胜 ${res.bWins}  平/超时 ${res.draws}(超时局 ${res.timeouts})`);
console.log(`模仿胜率 = ${(res.aWins / res.total * 100).toFixed(1)}%`);
console.log(`WINRATE=${(res.aWins / res.total * 100).toFixed(1)}%`);
