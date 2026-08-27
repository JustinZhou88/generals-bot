'use strict';
// 指标族: 城市与产能 (expert vs bot, 同一把尺子)
// 1) 首城时机  2) 持城曲线 t100/t150/t200  3) 产能差 (income=1+持城+地块/25)
// 4) 夺城动作的 game.turn%50 分布
const fs = require('fs');
const path = require('path');
const Game = require('./Game');

const BASE = __dirname;
const SAMPLE_HTS = [200, 300, 400]; // 真实回合 100/150/200

function countTiles(game, numPlayers) {
  const tiles = new Array(numPlayers).fill(0);
  const size = game.map.size();
  for (let i = 0; i < size; i++) {
    const t = game.map.tileAt(i);
    if (t >= 0 && t < numPlayers) tiles[t]++;
  }
  return tiles;
}

function makeTracker(cityList, numPlayers) {
  const owners = cityList.map(() => -1);
  return {
    captures: [], // {p, ht}  城被玩家 p 夺下的半回合
    samples: {},  // ht -> {cities:[per player], tiles:[per player]}
    sample(game, ht) {
      for (let ci = 0; ci < cityList.length; ci++) {
        const t = game.map.tileAt(cityList[ci]);
        if (t !== owners[ci]) {
          if (t >= 0) this.captures.push({ p: t, ht });
          owners[ci] = t;
        }
      }
      if (SAMPLE_HTS.includes(ht) && !this.samples[ht]) {
        const cities = [];
        for (let p = 0; p < numPlayers; p++) {
          cities.push(cityList.filter(c => game.map.tileAt(c) === p).length);
        }
        this.samples[ht] = { cities, tiles: countTiles(game, numPlayers) };
      }
    },
  };
}

function runExpert() {
  const pick = require('./pro/pick.json');
  const out = [];
  for (const [name, games] of Object.entries(pick)) {
    for (const g of games) {
      const r = JSON.parse(fs.readFileSync(path.join(BASE, 'pro', g.id + '.json')));
      const me = r.usernames.indexOf(name);
      if (me < 0) continue;
      const game = Game.createFromReplay(r);
      const tracker = makeTracker(r.cities.slice(), r.generals.length);
      let mi = 0;
      while (!game.isOver() && game.turn < 1200) {
        while (r.moves.length > mi && r.moves[mi].turn <= game.turn) {
          const m = r.moves[mi++];
          game.handleAttack(m.index, m.start, m.end, m.is50);
        }
        tracker.sample(game, game.turn);
        game.update();
      }
      out.push({ id: g.id, name, me, opp: 1 - me, tracker, endHt: game.turn });
    }
  }
  return out;
}

function runBot() {
  const { injectView, loadReplays } = require('../arena');
  const { GameState } = require('../src/gamestate');
  const { Strategy } = require('../src/strategy');
  const replays = loadReplays().slice(0, 12);
  const out = [];
  for (const r of replays) {
    const game = Game.createFromReplay(r);
    const gsA = new GameState();
    gsA.start({ playerIndex: 0, replay_id: 'x', usernames: ['A', 'B'], teams: undefined });
    const gsB = new GameState();
    gsB.start({ playerIndex: 1, replay_id: 'x', usernames: ['A', 'B'], teams: undefined });
    const A = new Strategy(gsA), B = new Strategy(gsB);
    const tracker = makeTracker(r.cities.slice(), 2);
    tracker.sample(game, 0);
    while (!game.isOver() && game.turn < 800) {
      injectView(gsA, game, 0);
      let a = null; try { a = A.nextMove(); } catch (e) {}
      injectView(gsB, game, 1);
      let b = null; try { b = B.nextMove(); } catch (e) {}
      if (a) game.inputBuffer[0].push([a.from, a.to, !!a.is50]);
      if (b) game.inputBuffer[1].push([b.from, b.to, !!b.is50]);
      game.update();
      tracker.sample(game, game.turn - 1); // 移动发生在 update 前的那个半回合
    }
    out.push({ id: r.id || '?', tracker, endHt: game.turn });
  }
  return out;
}

// ---- 聚合: 对每个 (game, player) 生成一份统计 ----
function playerStats(tracker, p, opp, endHt) {
  const caps = tracker.captures.filter(c => c.p === p);
  const first = caps.length ? caps[0].ht / 2 : null; // 真实回合
  const held = {}, incomeDiff = {}, income = {};
  for (const ht of SAMPLE_HTS) {
    const s = tracker.samples[ht];
    if (!s) continue;
    held[ht] = s.cities[p];
    const incMe = 1 + s.cities[p] + s.tiles[p] / 25;
    const incOpp = 1 + s.cities[opp] + s.tiles[opp] / 25;
    income[ht] = incMe;
    incomeDiff[ht] = incMe - incOpp;
  }
  return { first, nCaps: caps.length, mods: caps.map(c => c.ht % 50), held, income, incomeDiff, endHt };
}

function med(arr) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const mean = arr => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);
const r1 = x => (x == null ? null : Math.round(x * 10) / 10);
const r2 = x => (x == null ? null : Math.round(x * 100) / 100);

function summarize(label, statsList) {
  const firsts = statsList.filter(s => s.first != null).map(s => s.first);
  const never = statsList.filter(s => s.first == null).length;
  console.log('==== ' + label + ' ====');
  console.log('局(玩家)数:', statsList.length, ' 结束半回合 mean:', r1(mean(statsList.map(s => s.endHt))));
  console.log('首城真实回合: min=' + (firsts.length ? Math.min(...firsts) : '-') +
    ' median=' + r1(med(firsts)) + ' max=' + (firsts.length ? Math.max(...firsts) : '-') +
    '  从未夺城局数=' + never + '/' + statsList.length);
  for (const ht of SAMPLE_HTS) {
    const hs = statsList.filter(s => s.held[ht] != null).map(s => s.held[ht]);
    console.log('持城@t' + ht / 2 + ': mean=' + r2(mean(hs)) + ' median=' + med(hs) +
      ' (有效样本 ' + hs.length + ')');
  }
  for (const ht of [200, 400]) {
    const inc = statsList.filter(s => s.income[ht] != null).map(s => s.income[ht]);
    const dif = statsList.filter(s => s.incomeDiff[ht] != null).map(s => s.incomeDiff[ht]);
    console.log('产能@t' + ht / 2 + ': 自己 mean=' + r2(mean(inc)) +
      '  差值(自-对) mean=' + r2(mean(dif)) + ' median=' + r2(med(dif)) +
      '  |差| mean=' + r2(mean(dif.map(Math.abs))));
  }
  const mods = statsList.flatMap(s => s.mods);
  const buckets = [0, 0, 0, 0, 0];
  for (const m of mods) buckets[Math.min(4, (m / 10) | 0)]++;
  const tot = mods.length || 1;
  console.log('夺城次数总计=' + mods.length + '  turn%50 分布 [0-9,10-19,20-29,30-39,40-49] = ' +
    buckets.map(b => (100 * b / tot).toFixed(0) + '%').join(', ') +
    '  mean(mod50)=' + r1(mean(mods)));
  console.log('');
}

const mode = process.argv[2] || 'both';
if (mode === 'expert' || mode === 'both') {
  const ex = runExpert();
  const stats = ex.map(g => playerStats(g.tracker, g.me, g.opp, g.endHt));
  summarize('EXPERT (18局, 目标玩家视角)', stats);
}
if (mode === 'bot' || mode === 'both') {
  const bt = runBot();
  const stats = [];
  for (const g of bt) {
    stats.push(playerStats(g.tracker, 0, 1, g.endHt));
    stats.push(playerStats(g.tracker, 1, 0, g.endHt));
  }
  summarize('BOT v21 自对弈 (12图 x 双方=24样本)', stats);
}
