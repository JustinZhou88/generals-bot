'use strict';
const fs = require('fs');
const { playGame, loadReplays } = require('./arena');

const replays = loadReplays().slice(0, 2); // 2 maps x 2 sides = 4 games per pair

const bots = [];
for (let v = 1; v <= 27; v++) {
  const mod = require(`./src/strategy_v${v}`);
  const cls = mod.Strategy || mod;
  bots.push({ v, cls, name: `v${v}` });
}

console.log(`Loaded ${bots.length} bots. Running tournament...`);

const stats = {};
for (const b of bots) {
  stats[b.name] = { name: b.name, version: b.v, wins: 0, losses: 0, draws: 0, points: 0, games: 0, t50Sum: 0, t50Count: 0 };
}

let done = 0;
const totalPairs = (bots.length * (bots.length - 1)) / 2;

for (let i = 0; i < bots.length; i++) {
  for (let j = i + 1; j < bots.length; j++) {
    const bA = bots[i], bB = bots[j];

    for (const map of replays) {
      // Side 1: A vs B
      try {
        const r1 = playGame(map, bA.cls, bB.cls, 400);
        stats[bA.name].games++; stats[bB.name].games++;
        if (r1.landAt && r1.landAt.a) { stats[bA.name].t50Sum += r1.landAt.a; stats[bA.name].t50Count++; }
        if (r1.landAt && r1.landAt.b) { stats[bB.name].t50Sum += r1.landAt.b; stats[bB.name].t50Count++; }

        if (r1.winner === 0) { stats[bA.name].wins++; stats[bA.name].points += 3; stats[bB.name].losses++; }
        else if (r1.winner === 1) { stats[bB.name].wins++; stats[bB.name].points += 3; stats[bA.name].losses++; }
        else { stats[bA.name].draws++; stats[bA.name].points += 1; stats[bB.name].draws++; stats[bB.name].points += 1; }
      } catch (e) {}

      // Side 2: B vs A
      try {
        const r2 = playGame(map, bB.cls, bA.cls, 400);
        stats[bA.name].games++; stats[bB.name].games++;
        if (r2.landAt && r2.landAt.a) { stats[bB.name].t50Sum += r2.landAt.a; stats[bB.name].t50Count++; }
        if (r2.landAt && r2.landAt.b) { stats[bA.name].t50Sum += r2.landAt.b; stats[bA.name].t50Count++; }

        if (r2.winner === 1) { stats[bA.name].wins++; stats[bA.name].points += 3; stats[bB.name].losses++; }
        else if (r2.winner === 0) { stats[bB.name].wins++; stats[bB.name].points += 3; stats[bA.name].losses++; }
        else { stats[bA.name].draws++; stats[bA.name].points += 1; stats[bB.name].draws++; stats[bB.name].points += 1; }
      } catch (e) {}
    }

    done++;
    if (done % 50 === 0) console.log(`Progress: ${done}/${totalPairs} pairings completed...`);
  }
}

const list = Object.values(stats).map((s) => {
  const wr = s.games > 0 ? ((s.wins / s.games) * 100).toFixed(1) : '0.0';
  const t50 = s.t50Count > 0 ? (s.t50Sum / s.t50Count).toFixed(1) : '0.0';
  return { ...s, winRate: parseFloat(wr), avgT50: parseFloat(t50) };
});

list.sort((a, b) => b.points - a.points || b.winRate - a.winRate || b.version - a.version);

console.log('\n================================== 🏆 全 27 个 Bot 版本循环赛最终排行榜 🏆 ==================================');
console.log(' 排名 | 版本   | 胜 / 平 / 负     | 总场次 | 胜率 (%) | 积分   | 平均 t50 地块 ');
console.log('---------------------------------------------------------------------------------------------------------');

list.forEach((b, rank) => {
  const rStr = `#${rank + 1}`.padEnd(4);
  const nameStr = b.name.padEnd(6);
  const recordStr = `${b.wins}胜 / ${b.draws}平 / ${b.losses}负`.padEnd(16);
  const gamesStr = `${b.games}`.padEnd(6);
  const wrStr = `${b.winRate.toFixed(1)}%`.padEnd(8);
  const ptsStr = `${b.points}`.padEnd(6);
  const t50Str = `${b.avgT50}`;

  console.log(` ${rStr} | ${nameStr} | ${recordStr} | ${gamesStr} | ${wrStr} | ${ptsStr} | ${t50Str}`);
});
console.log('================================================================================-------------------------\n');

fs.writeFileSync('./tournament_results_27.json', JSON.stringify(list, null, 2));
