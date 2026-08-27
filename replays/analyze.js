'use strict';

// Simulate each decoded replay with the OFFICIAL game logic and extract
// learning-relevant metrics for player "d3st1ny" vs opponent.
//
// Replay "turn" counts half-turns (2 per real turn). RECRUIT_RATE=2 (cities/generals
// +1 each real turn), FARM_RATE=50 (land +1 every 25 real turns).

const fs = require('fs');
const Game = require('./Game');

const IDS = ['YRwqi8G0F','ClziytYE7','IsQzGGovy','ITrKU_mHD','h9zrVUj_t',
             'fsSyHkElSo','UZqOruswS','eqjy5p3Mf','Qqyz0B2za','uTLlRXgFs'];

function score(game, i) {
  const s = game.scores.find((x) => x.i === i);
  return { total: s.total, tiles: s.tiles };
}

function analyze(id) {
  const replay = JSON.parse(fs.readFileSync(id + '.json', 'utf8'));
  const game = Game.createFromReplay(replay);
  const me = replay.usernames.indexOf('d3st1ny');
  const opp = me === 0 ? 1 : 0;

  // Per-player move stats
  const moveCount = [0, 0], uselessCount = [0, 0], is50Count = [0, 0];

  let mi = 0, ai = 0;
  const series = []; // {t, myLand, myArmy, oppLand, oppArmy, myCities, oppCities}
  const deathTurn = {}; // playerIndex -> real turn captured
  let prevDeaths = 0;

  const cityOwner = () => {
    let mc = 0, oc = 0;
    for (const c of game.cities) {
      const t = game.map.tileAt(c);
      if (t === me) mc++; else if (t === opp) oc++;
    }
    return [mc, oc];
  };

  while (!game.isOver() && game.turn < 2000) {
    // apply moves for this turn
    while (replay.moves.length > mi && replay.moves[mi].turn <= game.turn) {
      const m = replay.moves[mi++];
      moveCount[m.index]++;
      if (m.is50) is50Count[m.index]++;
      const ok = game.handleAttack(m.index, m.start, m.end, m.is50);
      if (ok === false) uselessCount[m.index]++;
    }
    while (replay.afks.length > ai && replay.afks[ai].turn <= game.turn) {
      const afk = replay.afks[ai++];
      if (game.deaths.indexOf(game.sockets[afk.index]) >= 0) game.tryNeutralizePlayer(afk.index);
      else { game.deaths.push(game.sockets[afk.index]); game.alivePlayers--; }
    }
    game.update();

    // detect a real (general-capture) death this turn
    if (game.deaths.length > prevDeaths) {
      for (let p = 0; p < 2; p++) {
        if (game.deaths.indexOf(game.sockets[p]) >= 0 && deathTurn[p] === undefined) {
          deathTurn[p] = Math.floor(game.turn / 2);
        }
      }
      prevDeaths = game.deaths.length;
    }

    if (game.turn % 2 === 0) {
      const realT = game.turn / 2;
      const m = score(game, me), o = score(game, opp);
      const [mc, oc] = cityOwner();
      series.push({ t: realT, myLand: m.tiles, myArmy: m.total, oppLand: o.tiles, oppArmy: o.total, myCities: mc, oppCities: oc });
    }
  }

  // Winner: player NOT in deaths (or last to die)
  const meDead = game.deaths.indexOf(game.sockets[me]) >= 0;
  const oppDead = game.deaths.indexOf(game.sockets[opp]) >= 0;
  let result;
  if (oppDead && !meDead) result = 'WIN';
  else if (meDead && !oppDead) result = 'LOSS';
  else result = 'UNCLEAR';

  const at = (rt) => series.find((s) => s.t === rt) || series[series.length - 1];
  const finalT = series.length ? series[series.length - 1].t : 0;

  // opponent afk info
  const oppAfk = replay.afks.find((a) => a.index === opp);
  const meAfk = replay.afks.find((a) => a.index === me);

  return {
    id, opponent: replay.usernames[opp], size: replay.mapWidth + 'x' + replay.mapHeight,
    result, finalT,
    deathTurnMe: deathTurn[me], deathTurnOpp: deathTurn[opp],
    oppAfkTurn: oppAfk ? Math.floor(oppAfk.turn / 2) : null,
    meAfkTurn: meAfk ? Math.floor(meAfk.turn / 2) : null,
    land25: [at(25).myLand, at(25).oppLand],
    land50: [at(50).myLand, at(50).oppLand],
    land100: [at(100).myLand, at(100).oppLand],
    landFinal: [at(finalT).myLand, at(finalT).oppLand],
    armyFinal: [at(finalT).myArmy, at(finalT).oppArmy],
    citiesFinal: [at(finalT).myCities, at(finalT).oppCities],
    moves: [moveCount[me], moveCount[opp]],
    useless: [uselessCount[me], uselessCount[opp]],
    is50: [is50Count[me], is50Count[opp]],
    series,
  };
}

const results = IDS.map(analyze);
fs.writeFileSync('analysis.json', JSON.stringify(results, null, 1));

// ---- Print human-readable summary ----
const pad = (s, n) => String(s).padEnd(n);
console.log('me = d3st1ny  (格式: 我方 vs 对手)\n');
for (const r of results) {
  const wl = r.result === 'WIN' ? '✅胜' : r.result === 'LOSS' ? '❌负' : '❔';
  const afk = r.oppAfkTurn ? `  [对手第${r.oppAfkTurn}回合AFK/退]` : '';
  const decided = r.deathTurnOpp ? `将军第${r.deathTurnOpp}回合被破` :
                  r.deathTurnMe ? `我第${r.deathTurnMe}回合被破` : '';
  console.log(`${wl}  ${pad(r.opponent, 18)} ${pad(r.size, 7)} 共${r.finalT}回合  ${decided}${afk}`);
  console.log(`     地块曲线  t25: ${r.land25[0]} vs ${r.land25[1]}   t50: ${r.land50[0]} vs ${r.land50[1]}   t100: ${r.land100[0]} vs ${r.land100[1]}   终局: ${r.landFinal[0]} vs ${r.landFinal[1]}`);
  console.log(`     终局兵力  ${r.armyFinal[0]} vs ${r.armyFinal[1]}   城: ${r.citiesFinal[0]} vs ${r.citiesFinal[1]}   移动数: ${r.moves[0]} vs ${r.moves[1]}   废动: ${r.useless[0]} vs ${r.useless[1]}   半推(is50): ${r.is50[0]} vs ${r.is50[1]}`);
  console.log('');
}

// Aggregate
const wins = results.filter((r) => r.result === 'WIN').length;
const losses = results.filter((r) => r.result === 'LOSS').length;
const realWins = results.filter((r) => r.result === 'WIN' && !r.oppAfkTurn).length;
console.log(`总计: ${wins}胜 ${losses}负 (其中 ${wins - realWins} 胜是对手中途AFK/退)`);
const avg = (f) => (results.reduce((a, r) => a + f(r), 0) / results.length).toFixed(1);
console.log(`平均开局地块  t25: 我${avg((r)=>r.land25[0])} vs 对手${avg((r)=>r.land25[1])}   t50: 我${avg((r)=>r.land50[0])} vs 对手${avg((r)=>r.land50[1])}`);
console.log(`平均 is50 半推使用: 我${avg((r)=>r.is50[0])} vs 对手${avg((r)=>r.is50[1])}   平均废动: 我${avg((r)=>r.useless[0])} vs 对手${avg((r)=>r.useless[1])}`);
