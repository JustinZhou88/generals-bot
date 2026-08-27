'use strict';

// Analyze high-turn 1v1 replays for 3 target players, from the target's POV.
const fs = require('fs');
const Game = require('./Game');

const pick = JSON.parse(fs.readFileSync('pro/pick.json'));

function simulate(id, targetName) {
  const r = JSON.parse(fs.readFileSync('pro/' + id + '.json', 'utf8'));
  const game = Game.createFromReplay(r);
  const me = r.usernames.indexOf(targetName);
  const opp = me === 0 ? 1 : 0;

  const moveCount = [0, 0], useless = [0, 0], is50 = [0, 0];
  // is50 by phase (real-turn buckets): <25, 25-50, 50-100, 100+
  const is50Phase = [0, 0, 0, 0];
  let mi = 0, ai = 0, prevDeaths = 0;
  const death = {};
  const series = [];

  const cityCount = () => {
    let mc = 0, oc = 0;
    for (const c of game.cities) { const t = game.map.tileAt(c); if (t === me) mc++; else if (t === opp) oc++; }
    return [mc, oc];
  };

  while (!game.isOver() && game.turn < 4000) {
    while (r.moves.length > mi && r.moves[mi].turn <= game.turn) {
      const m = r.moves[mi++];
      moveCount[m.index]++;
      if (m.is50) { is50[m.index]++; if (m.index === me) { const rt = m.turn / 2; is50Phase[rt < 25 ? 0 : rt < 50 ? 1 : rt < 100 ? 2 : 3]++; } }
      if (game.handleAttack(m.index, m.start, m.end, m.is50) === false) useless[m.index]++;
    }
    while (r.afks.length > ai && r.afks[ai].turn <= game.turn) {
      const a = r.afks[ai++];
      if (game.deaths.indexOf(game.sockets[a.index]) >= 0) game.tryNeutralizePlayer(a.index);
      else { game.deaths.push(game.sockets[a.index]); game.alivePlayers--; }
    }
    game.update();
    if (game.deaths.length > prevDeaths) {
      for (let p = 0; p < 2; p++) if (game.deaths.indexOf(game.sockets[p]) >= 0 && death[p] === undefined) death[p] = Math.floor(game.turn / 2);
      prevDeaths = game.deaths.length;
    }
    if (game.turn % 2 === 0) {
      const s = (i) => game.scores.find((x) => x.i === i);
      const [mc, oc] = cityCount();
      series.push({ t: game.turn / 2, mL: s(me).tiles, mA: s(me).total, oL: s(opp).tiles, oA: s(opp).total, mC: mc, oC: oc });
    }
  }
  const meDead = game.deaths.indexOf(game.sockets[me]) >= 0;
  const at = (t) => series.find((x) => x.t === t) || series[series.length - 1];
  const fin = series[series.length - 1] || { t: 0 };

  // max army stack lead / peak cities — proxies for gathering+city strategy
  let peakMyCities = 0; for (const p of series) peakMyCities = Math.max(peakMyCities, p.mC);
  // how many times land-lead sign flipped (back-and-forth game)
  let flips = 0, prevSign = 0;
  for (const p of series) { const sg = Math.sign(p.mL - p.oL); if (sg && sg !== prevSign && prevSign) flips++; if (sg) prevSign = sg; }

  return {
    id, opp: r.usernames[opp], size: r.mapWidth + 'x' + r.mapHeight, turns: fin.t,
    won: !meDead, deathOpp: death[opp], deathMe: death[me],
    l25: [at(25).mL, at(25).oL], l50: [at(50).mL, at(50).oL], l100: [at(100).mL, at(100).oL], l200: [at(200).mL, at(200).oL],
    cFin: [fin.mC, fin.oC], peakMyCities, flips,
    moves: [moveCount[me], moveCount[opp]], useless: [useless[me], useless[opp]], is50: [is50[me], is50[opp]], is50Phase,
    apm: (moveCount[me] / Math.max(1, fin.t)).toFixed(2),
    series,
  };
}

const out = {};
for (const name in pick) {
  out[name] = [];
  console.log(`\n===== ${name} =====`);
  for (const g of pick[name]) {
    const a = simulate(g.id, name);
    out[name].push(a);
    const wl = a.won ? '✅胜' : '❌负';
    const dec = a.deathOpp ? `破敌将@t${a.deathOpp}` : a.deathMe ? `我将被破@t${a.deathMe}` : '';
    console.log(`${wl} ${a.turns}回合 vs ${a.opp.slice(0,16).padEnd(16)} ${dec}`);
    console.log(`   地块 t25:${a.l25[0]}v${a.l25[1]} t50:${a.l50[0]}v${a.l50[1]} t100:${a.l100[0]}v${a.l100[1]} t200:${a.l200[0]}v${a.l200[1]}  城终:${a.cFin[0]}v${a.cFin[1]}(峰${a.peakMyCities})  领先易手${a.flips}次`);
    console.log(`   is50:${a.is50[0]}v${a.is50[1]} [开局${a.is50Phase[0]}/25-50:${a.is50Phase[1]}/50-100:${a.is50Phase[2]}/后${a.is50Phase[3]}]  废动:${a.useless[0]}v${a.useless[1]}  APM~${a.apm}`);
  }
}
fs.writeFileSync('pro/analysis_pro.json', JSON.stringify(out));

// Aggregate across all target-player games
const all = [].concat(...Object.values(out));
const avg = (f) => (all.reduce((s, r) => s + f(r), 0) / all.length).toFixed(1);
console.log(`\n===== 汇总(${all.length}局高回合1v1) =====`);
console.log(`胜率: ${all.filter(r=>r.won).length}/${all.length}`);
console.log(`平均地块 t25:${avg(r=>r.l25[0])}v${avg(r=>r.l25[1])} t50:${avg(r=>r.l50[0])}v${avg(r=>r.l50[1])} t100:${avg(r=>r.l100[0])}v${avg(r=>r.l100[1])} t200:${avg(r=>r.l200[0])}v${avg(r=>r.l200[1])}`);
console.log(`平均终局城: ${avg(r=>r.cFin[0])}v${avg(r=>r.cFin[1])}  峰值城:${avg(r=>r.peakMyCities)}  领先易手:${avg(r=>r.flips)}次/局`);
console.log(`平均 is50: ${avg(r=>r.is50[0])}v${avg(r=>r.is50[1])}  平均废动:${avg(r=>r.useless[0])}v${avg(r=>r.useless[1])}  平均APM:${avg(r=>+r.apm)}`);
