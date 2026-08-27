'use strict';

/**
 * 评估A:模仿策略的"高手画像距离"。
 *
 * 复刻 replays/scorecard.js --bot 模式(同参数:loadReplays().slice(0,10)
 * 双侧采样、cap 600 半回合),但双方都换成 src/imitation.js 的 ImitationStrategy,
 * 直接复用 scorecard 导出的 Recorder。输出与 scorecard 相同格式 + DISTANCE=<D>。
 *
 * 对比基准:v23 的 D = 0.3381。
 *
 * 运行: node replays/imitation/eval.js [N图]
 */

const fs = require('fs');
const path = require('path');
const Game = require('../Game');
const { Recorder, METRICS } = require('../scorecard');
const { injectView, loadReplays } = require('../../arena');
const { GameState } = require('../../src/gamestate');
const { ImitationStrategy } = require('../../src/imitation');

const PROFILE_PATH = path.join(__dirname, '..', 'expert_profile.json');
const CAP = 600;

function fmt(v) {
  if (!Number.isFinite(v)) return 'NaN';
  return Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3);
}

function main() {
  const n = parseInt(process.argv[2], 10);
  const nMaps = Number.isFinite(n) && n > 0 ? n : 10;
  const replays = loadReplays().slice(0, nMaps);
  const rows = [];

  for (const r of replays) {
    const game = Game.createFromReplay(r);
    const gsA = new GameState(), gsB = new GameState();
    gsA.start({ playerIndex: 0, replay_id: 'x', usernames: ['A', 'B'], teams: undefined });
    gsB.start({ playerIndex: 1, replay_id: 'x', usernames: ['A', 'B'], teams: undefined });
    const bots = [new ImitationStrategy(gsA), new ImitationStrategy(gsB)];
    const gss = [gsA, gsB];
    const recs = [new Recorder(r, 0), new Recorder(r, 1)];
    while (!game.isOver() && game.turn < CAP) {
      recs[0].sample(game);
      recs[1].sample(game);
      const pend = [];
      for (let p = 0; p < 2; p++) {
        injectView(gss[p], game, p);
        let mv = null;
        try { mv = bots[p].nextMove(); } catch (e) { mv = null; }
        if (mv && Number.isInteger(mv.from) && Number.isInteger(mv.to)) {
          const preTile = game.map.tileAt(mv.to);
          const preArmy = game.map.armyAt(mv.to);
          const ev = recs[p].onMove(game.turn, mv.from, mv.to, mv.is50, preTile, preArmy);
          pend.push([p, ev]);
          game.inputBuffer[p].push([mv.from, mv.to, !!mv.is50]);
        }
      }
      game.update();
      for (const [p, ev] of pend) {
        if (ev.preTile === 1 - p && game.map.tileAt(ev.end) === p) ev.captured = true;
      }
    }
    rows.push(recs[0].finalize(game), recs[1].finalize(game));
  }

  if (!fs.existsSync(PROFILE_PATH)) {
    console.error('缺少 expert_profile.json,先跑 node replays/scorecard.js --expert');
    process.exit(1);
  }
  const profile = JSON.parse(fs.readFileSync(PROFILE_PATH));

  // bot 侧聚合(m17 取中位数,与 scorecard 一致)
  const botAgg = {};
  for (const [id] of METRICS) {
    const vals = rows.map((row) => row[id]).filter((v) => Number.isFinite(v));
    if (!vals.length) { botAgg[id] = NaN; continue; }
    if (id === 'm17') {
      const s = vals.slice().sort((a, b) => a - b);
      const mid = s.length >> 1;
      botAgg[id] = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    } else {
      botAgg[id] = vals.reduce((x, y) => x + y, 0) / vals.length;
    }
  }

  console.log(`ImitationStrategy 自对弈 ${replays.length} 图 x 双侧 = ${rows.length} 侧样本,cap ${CAP} 半回合\n`);
  console.log('指标   名称                 expert      bot        dev   w');
  console.log('-----------------------------------------------------------------');
  let sumW = 0, sumWD = 0;
  const devs = [];
  for (const [id, name, w] of METRICS) {
    const em = profile.metrics[id] ? profile.metrics[id].mean : NaN;
    const bm = botAgg[id];
    if (!Number.isFinite(em)) continue;
    let dev;
    if (!Number.isFinite(bm)) dev = 2.0;
    else dev = Math.min(2.0, Math.abs(bm - em) / Math.max(Math.abs(em), 0.01));
    sumW += w; sumWD += w * dev;
    devs.push({ id, name, em, bm, dev, w });
    console.log(
      `${id.padEnd(5)} ${name.padEnd(18)} ${fmt(em).padStart(9)} ${fmt(bm).padStart(9)} ` +
      `${dev.toFixed(3).padStart(7)}  ${w}`
    );
  }
  const D = sumWD / sumW;
  console.log('-----------------------------------------------------------------');
  const worst = devs.slice().sort((a, b) => b.dev - a.dev).slice(0, 5);
  console.log('偏差最大 5 项: ' + worst.map((x) => `${x.id}(${x.dev.toFixed(2)})`).join(' '));
  console.log(`总距离 D(加权平均) = ${D.toFixed(4)}   (v23 基准 0.3381)`);
  console.log(`DISTANCE=${D.toFixed(4)}`);
}

main();
