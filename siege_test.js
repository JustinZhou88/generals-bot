'use strict';
/*
 * siege_test.js — "抗集兵围攻"生存率(离线擂台测不出来的那一项)
 *
 * 背景:v28 在擂台上赢遍 27 个前代,却被用户 5 局赢 4 局。原因是所有 bot 对手
 * 都是散兵游勇打法,没人会把兵捏成一坨推过来,所以"抗真人重拳"这项能力
 * 在胜率指标上根本不扣分。这个脚本把它变成可测量的。
 *
 * 报告三件事:
 *   1. 防守方生存率(核心指标);
 *   2. 陪练实际捏出的最大兵团(整局峰值,勿与下面的 t120 瞬时值混用);
 *   3. 防守方自己的最大兵团(它到底有没有主力)。
 *
 * 用法: node siege_test.js --def ./src/strategy_v29.js --games 120
 */

const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const Game = require('./replays/Game');
const { GameState } = require('./src/gamestate');
const { injectView } = require('./arena');
const { generateMap } = require('./mapgen');

const CAP = 1200;

function siegeGame(mapObj, Def, Att, defFirst) {
  const game = Game.createFromReplay(mapObj);
  const dP = defFirst ? 0 : 1, aP = defFirst ? 1 : 0;
  const gsD = new GameState(), gsA = new GameState();
  gsD.start({ playerIndex: dP, replay_id: 's', usernames: ['D', 'A'], teams: undefined });
  gsA.start({ playerIndex: aP, replay_id: 's', usernames: ['D', 'A'], teams: undefined });
  const def = new Def(gsD), att = new Att(gsA);
  let attMax = 0, defMax = 0;
  // 关键:统计整局峰值会被后期(几百回合)的堆兵冲淡 —— 而真人实战是在 ~120 回合
  // (半回合 240)前后发动总攻。所以在那个时间点单独取样。
  // 注意:t120 的瞬时兵团真人实测只有 ~22(见 opp_profile.js),不是 82~86。
  const snap = { att: 0, def: 0, taken: false };

  while (!game.isOver() && game.turn < CAP) {
    injectView(gsD, game, dP); let md = null; try { md = def.nextMove(); } catch (e) {}
    injectView(gsA, game, aP); let ma = null; try { ma = att.nextMove(); } catch (e) {}
    if (md && Number.isInteger(md.from)) game.inputBuffer[dP].push([md.from, md.to, !!md.is50]);
    if (ma && Number.isInteger(ma.from)) game.inputBuffer[aP].push([ma.from, ma.to, !!ma.is50]);
    game.update();
    // 统计双方"野战主力"峰值(排除将军本身的驻军)
    const genD = game.generals[dP], genA = game.generals[aP];
    for (let t = 0; t < game.map.width * game.map.height; t++) {
      const own = game.map.tileAt(t);
      const a = game.map.armyAt(t);
      if (own === aP && t !== genA && a > attMax) attMax = a;
      if (own === dP && t !== genD && a > defMax) defMax = a;
    }
    if (!snap.taken && game.turn >= 240) {
      snap.taken = true;
      for (let t = 0; t < game.map.width * game.map.height; t++) {
        const own = game.map.tileAt(t), a = game.map.armyAt(t);
        if (own === aP && t !== genA && a > snap.att) snap.att = a;
        if (own === dP && t !== genD && a > snap.def) snap.def = a;
      }
    }
  }
  const defDead = game.deaths.indexOf(game.sockets[dP]) >= 0;
  const attDead = game.deaths.indexOf(game.sockets[aP]) >= 0;
  return { survived: !defDead, defWon: attDead && !defDead, attMax, defMax, snapAtt: snap.att, snapDef: snap.def, turns: game.turn };
}

if (require.main === module && process.argv[2] === '--worker') {
  const job = JSON.parse(process.argv[3]);
  const { Strategy: Def } = require(job.def);
  const { Strategy: Att } = require(job.att);
  const out = { n: 0, survived: 0, defWon: 0, attMax: [], defMax: [], snapAtt: [], snapDef: [] };
  for (let i = 0; i < job.games; i++) {
    const m = generateMap(job.seed + i * 7919);
    const r = siegeGame(m, Def, Att, i % 2 === 0);
    out.n++;
    if (r.survived) out.survived++;
    if (r.defWon) out.defWon++;
    out.attMax.push(r.attMax); out.defMax.push(r.defMax);
    out.snapAtt.push(r.snapAtt); out.snapDef.push(r.snapDef);
  }
  process.send(out);
  process.exit(0);
}

function stats(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = a.reduce((p, q) => p + q, 0) / a.length;
  return { mean: m, p50: s[(s.length * 0.5) | 0], p90: s[(s.length * 0.9) | 0], max: s[s.length - 1] };
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = { def: './src/strategy_v29.js', att: './src/sparring.js', games: 120, seed: 5150, jobs: Math.max(1, Math.min(os.cpus().length - 1, 6)) };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--def') opt.def = argv[++i];
    else if (argv[i] === '--att') opt.att = argv[++i];
    else if (argv[i] === '--games') opt.games = parseInt(argv[++i], 10);
    else if (argv[i] === '--seed') opt.seed = parseInt(argv[++i], 10);
    else if (argv[i] === '--jobs') opt.jobs = parseInt(argv[++i], 10);
  }
  const per = Math.ceil(opt.games / opt.jobs);
  const agg = { n: 0, survived: 0, defWon: 0, attMax: [], defMax: [], snapAtt: [], snapDef: [] };
  await new Promise((resolve) => {
    let done = 0;
    for (let k = 0; k < opt.jobs; k++) {
      const job = { def: path.resolve(__dirname, opt.def), att: path.resolve(__dirname, opt.att), games: per, seed: opt.seed + k * 1000003 };
      const ch = fork(__filename, ['--worker', JSON.stringify(job)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let err = '';
      ch.stderr.on('data', (d) => { err += d.toString(); });
      ch.on('message', (m) => {
        agg.n += m.n; agg.survived += m.survived; agg.defWon += m.defWon;
        agg.attMax.push(...m.attMax); agg.defMax.push(...m.defMax);
        agg.snapAtt.push(...m.snapAtt); agg.snapDef.push(...m.snapDef);
      });
      ch.on('exit', (c) => { if (c !== 0 && err) console.error(err.slice(0, 500)); if (++done === opt.jobs) resolve(); });
    }
  });

  const A = stats(agg.attMax), D = stats(agg.defMax);
  const z = 1.959964, p = agg.survived / agg.n, d = 1 + z * z / agg.n;
  const c = p + z * z / (2 * agg.n), sd = z * Math.sqrt(p * (1 - p) / agg.n + z * z / (4 * agg.n * agg.n));
  console.log(`\n抗围攻测试: 防守方 ${path.basename(opt.def)}  vs  陪练 ${path.basename(opt.att)}   ${agg.n} 局随机图`);
  console.log(`  生存率  ${(p * 100).toFixed(1)}%  95%CI[${((c - sd) / d * 100).toFixed(1)}, ${((c + sd) / d * 100).toFixed(1)}]   (反杀 ${(agg.defWon / agg.n * 100).toFixed(1)}%)`);
  console.log(`  陪练最大野战兵团   均值 ${A.mean.toFixed(1)}  中位 ${A.p50}  p90 ${A.p90}  最高 ${A.max}   (真人**整局峰值**参照,勿与 t120 混用)`);
  console.log(`  防守方最大野战兵团 均值 ${D.mean.toFixed(1)}  中位 ${D.p50}  p90 ${D.p90}  最高 ${D.max}`);
  const SA = stats(agg.snapAtt), SD = stats(agg.snapDef);
  console.log(`  —— 第120回合(半回合240,真人实战的决胜时点)——`);
  // 【2026-07-30 更正】原来这里印的参照是 "真人此时 82~86",但那是**整局峰值**,
  // 拿来和 t120 的**瞬时值**比是口径错误,而这个错误让项目长期以为"我方兵团太小"。
  // 107 局真人实战实测(opp_profile.js,同局配对):t120 真人对手 21.8~22.9,我方 24.5~28.2 ——
  // **我方反而更大,兵团规模不是差距**,陪练的 22.0 校准得很准。
  // 这解释了为什么"主力兵团规模/保护/站位"五次改动全部无效:本来就没有差距要补。
  console.log(`  陪练野战兵团   均值 ${SA.mean.toFixed(1)}  中位 ${SA.p50}  p90 ${SA.p90}   (真人实战 t120 实测 ~22)`);
  console.log(`  防守方野战兵团 均值 ${SD.mean.toFixed(1)}  中位 ${SD.p50}  p90 ${SD.p90}   (实战此时仅 34)`);
}

if (require.main === module && process.argv[2] !== '--worker') main();
