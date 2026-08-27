// 指标族: 主力动态 (main-force dynamics)
// 同一把尺子分别量 高手语料(replays/pro) 与 bot 自对弈(v21 Strategy)
// 1) 主力活跃度: 每2半回合采样, 最大兵团所在格变化率
// 2) 主力到最近敌格距离 @t75/t125 (真实回合 = 半回合150/250)
// 3) is50 半推每局次数
// 4) 主力就位率: game.turn%50===0 (产兵刻) 时主力距最近敌格<=3 的比例
'use strict';
const fs = require('fs');
const path = require('path');
const Game = require('./Game');

const CAP = 800; // 半回合上限, 高手/bot 同尺

function manhattan(a, b, W) {
  const ar = (a / W) | 0, ac = a % W, br = (b / W) | 0, bc = b % W;
  return Math.abs(ar - br) + Math.abs(ac - bc);
}

// 找玩家 p 的最大兵团格; 返回 {tile, army} 或 null
function mainTile(game, p) {
  const n = game.map.size();
  let best = -1, bestA = -1;
  for (let t = 0; t < n; t++) {
    if (game.map.tileAt(t) === p) {
      const a = game.map.armyAt(t);
      if (a > bestA) { bestA = a; best = t; }
    }
  }
  return best >= 0 ? { tile: best, army: bestA } : null;
}

function nearestEnemyDist(game, p, fromTile, W) {
  const n = game.map.size();
  let best = Infinity;
  for (let t = 0; t < n; t++) {
    const o = game.map.tileAt(t);
    if (o >= 0 && o !== p) {
      const d = manhattan(fromTile, t, W);
      if (d < best) best = d;
    }
  }
  return best === Infinity ? null : best;
}

// 每局每玩家的采样器
function makeTracker() {
  return {
    prevMain: null, pairs: 0, changes: 0,        // 活跃度
    d75: null, d125: null,                        // 距离快照
    doubleTotal: 0, doubleReady: 0,               // 就位率
  };
}

// 在 game.update() 之前调用, 采样当前 game.turn 状态
function sample(game, p, W, tr) {
  const turn = game.turn;
  if (turn % 2 !== 0) return;
  const mt = mainTile(game, p);
  if (!mt) return;
  // 活跃度: 从半回合24开始算(开局主力=将军不动, 两边同样跳过)
  if (turn >= 24) {
    if (tr.prevMain !== null) {
      tr.pairs++;
      if (tr.prevMain !== mt.tile) tr.changes++;
    }
    tr.prevMain = mt.tile;
  }
  const d = nearestEnemyDist(game, p, mt.tile, W);
  if (d === null) return;
  if (turn === 150) tr.d75 = d;
  if (turn === 250) tr.d125 = d;
  if (turn % 50 === 0 && turn > 0) {
    tr.doubleTotal++;
    if (d <= 3) tr.doubleReady++;
  }
}

function newAgg() {
  return { act: [], d75: [], d125: [], is50: [], dblReady: 0, dblTotal: 0, games: 0 };
}
function pushGame(agg, tr, is50count) {
  agg.games++;
  if (tr.pairs > 0) agg.act.push(tr.changes / tr.pairs);
  if (tr.d75 !== null) agg.d75.push(tr.d75);
  if (tr.d125 !== null) agg.d125.push(tr.d125);
  agg.is50.push(is50count);
  agg.dblReady += tr.doubleReady;
  agg.dblTotal += tr.doubleTotal;
}
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;

function report(name, agg) {
  console.log(`\n=== ${name} (${agg.games} 玩家局) ===`);
  console.log(`主力活跃度(采样点间主力换格率): ${(mean(agg.act) * 100).toFixed(1)}%  [n=${agg.act.length}]`);
  console.log(`主力距最近敌格 @t75:  ${mean(agg.d75).toFixed(1)} 格 [n=${agg.d75.length}]`);
  console.log(`主力距最近敌格 @t125: ${mean(agg.d125).toFixed(1)} 格 [n=${agg.d125.length}]`);
  console.log(`is50 半推次数/局: ${mean(agg.is50).toFixed(1)}`);
  console.log(`产兵刻就位率(dist<=3): ${agg.dblTotal ? (100 * agg.dblReady / agg.dblTotal).toFixed(1) : 'NA'}% [${agg.dblReady}/${agg.dblTotal}]`);
}

// ---------------- 高手语料 ----------------
function runExpert() {
  const pick = JSON.parse(fs.readFileSync(path.join(__dirname, 'pro', 'pick.json'), 'utf8'));
  const agg = newAgg();
  for (const [player, games] of Object.entries(pick)) {
    for (const g of games) {
      const fp = path.join(__dirname, 'pro', g.id + '.json');
      if (!fs.existsSync(fp)) { console.log('skip missing', g.id); continue; }
      const r = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const me = r.usernames.indexOf(player);
      if (me < 0) { console.log('skip name-miss', g.id, player); continue; }
      const W = r.mapWidth;
      const game = Game.createFromReplay(r);
      const tr = makeTracker();
      let mi = 0, is50c = 0;
      try {
        while (!game.isOver() && game.turn < CAP) {
          while (r.moves.length > mi && r.moves[mi].turn <= game.turn) {
            const m = r.moves[mi++];
            if (m.index === me && m.is50 && m.turn < CAP) is50c++;
            game.handleAttack(m.index, m.start, m.end, m.is50);
          }
          sample(game, me, W, tr);
          game.update();
        }
      } catch (e) { console.log('expert engine err', g.id, e.message); }
      pushGame(agg, tr, is50c);
    }
  }
  return agg;
}

// ---------------- bot 自对弈 ----------------
function runBot() {
  const { injectView, loadReplays } = require('../arena');
  const { GameState } = require('../src/gamestate');
  const { Strategy } = require('../src/strategy');
  const agg = newAgg();
  const maps = loadReplays().slice(0, 12);
  maps.forEach((r, idx) => {
    const W = r.mapWidth;
    const game = Game.createFromReplay(r);
    const gsA = new GameState(); gsA.start({ playerIndex: 0, replay_id: 'x', usernames: ['A', 'B'], teams: undefined });
    const gsB = new GameState(); gsB.start({ playerIndex: 1, replay_id: 'x', usernames: ['A', 'B'], teams: undefined });
    const { Strategy: S } = require('../src/strategy');
    const A = new S(gsA), B = new S(gsB);
    const trA = makeTracker(), trB = makeTracker();
    let is50A = 0, is50B = 0;
    while (!game.isOver() && game.turn < CAP) {
      injectView(gsA, game, 0);
      let a = null; try { a = A.nextMove(); } catch (e) {}
      injectView(gsB, game, 1);
      let b = null; try { b = B.nextMove(); } catch (e) {}
      if (a) { game.inputBuffer[0].push([a.from, a.to, !!a.is50]); if (a.is50) is50A++; }
      if (b) { game.inputBuffer[1].push([b.from, b.to, !!b.is50]); if (b.is50) is50B++; }
      sample(game, 0, W, trA);
      sample(game, 1, W, trB);
      game.update();
    }
    console.log(`  map ${idx} done @turn ${game.turn}`);
    pushGame(agg, trA, is50A);
    pushGame(agg, trB, is50B);
  });
  return agg;
}

const eAgg = runExpert();
report('EXPERT', eAgg);
const bAgg = runBot();
report('BOT', bAgg);
console.log('\nJSON', JSON.stringify({
  expert: { act: mean(eAgg.act), d75: mean(eAgg.d75), d125: mean(eAgg.d125), is50: mean(eAgg.is50), ready: eAgg.dblTotal ? eAgg.dblReady / eAgg.dblTotal : null },
  bot: { act: mean(bAgg.act), d75: mean(bAgg.d75), d125: mean(bAgg.d125), is50: mean(bAgg.is50), ready: bAgg.dblTotal ? bAgg.dblReady / bAgg.dblTotal : null },
}));
