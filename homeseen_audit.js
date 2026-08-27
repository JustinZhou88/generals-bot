'use strict';
/*
 * homeseen_audit.js — 量 homeSeen 这个"永不复位"的硬门槛封掉了多少城市经济
 *
 * 背景:城市经济是今天拿到三个独立确认的差距(同局配对 对手 3.11 vs 我方 1.32;
 * 全样本 2.27 vs 1.48;合成真人也只有 1.0)。
 *
 * 嫌疑机制:`tryCaptureCity` 里中立塔的门槛是
 *   canNeutralCity = oppJustBought || (!this.homeSeen && (...))
 * 而 homeSeen 的定义是"敌方地块曾到过我将军 2 格内",**一旦为真永不复位**。
 * 而 109 局真人数据显示对手是带兵硬推过来的(≥20 兵占 57%,推进距离≈双将距离),
 * 所以 homeSeen 很可能**很早就永久为真**,之后整局再也不打中立塔。
 *
 * 这里用真实回放直接量:homeSeen 何时为真、占整局多大比例、与我方夺城数的关系。
 *
 * 用法: GIO_ME=zjxnb node homeseen_audit.js <目录>
 */

const fs = require('fs');
const path = require('path');
const LZString = require('lz-string');
const Game = require('./replays/Game');

const DIR = process.argv[2];
const ME = process.env.GIO_ME || 'zjxnb';
if (!DIR) { console.log('用法: GIO_ME=<名字> node homeseen_audit.js <目录>'); process.exit(1); }

function deserialize(buf) {
  const obj = JSON.parse(LZString.decompressFromUint8Array(new Uint8Array(buf)));
  let i = 0; const r = {};
  for (const k of ['version','id','mapWidth','mapHeight','usernames','stars','cities','cityArmies','generals','mountains']) r[k] = obj[i++];
  r.moves = obj[i++].map((s) => ({ index: s[0], start: s[1], end: s[2], is50: s[3], turn: s[4] }));
  r.afks = obj[i++].map((s) => ({ index: s[0], turn: s[1] }));
  r.teams = obj[i++]; r.map_title = obj[i++];
  return r;
}

const rows = [];
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.gior'))) {
  let r;
  try { r = deserialize(fs.readFileSync(path.join(DIR, f))); } catch (e) { continue; }
  if (!r.usernames || r.usernames.length !== 2) continue;
  const me = r.usernames.indexOf(ME);
  if (me < 0) continue;
  const opp = 1 - me;
  if (r.afks.length) continue;

  let game;
  try { game = Game.createFromReplay(r); } catch (e) { continue; }
  const W = r.mapWidth;
  const myGen = r.generals[me];
  const gr = (myGen / W) | 0, gc = myGen % W;
  const citySet = new Set(r.cities || []);
  let mi = 0, homeSeenAt = -1, myCityCaps = 0, oppCityCaps = 0;
  // 也量 homeExposed(敌兵>=6 在 4 格内,30 半回合窗口)—— 它是另一道会掐掉打塔的门
  let exposedHalfTurns = 0, lastExposed = -1e9;
  const cityOwner = {};
  for (const c of citySet) cityOwner[c] = game.map.tileAt(c);
  // 中立塔"本来可以打"的机会:可见、中立、且离我将军比离最近敌格更近
  let oppsTotal = 0, oppsAfterHomeSeen = 0;

  while (!game.isOver() && game.turn < 3000) {
    while (r.moves.length > mi && r.moves[mi].turn <= game.turn) {
      const m = r.moves[mi++];
      try { game.handleAttack(m.index, m.start, m.end, m.is50); } catch (e) {}
    }
    game.update();
    const rt = Math.floor(game.turn / 2);

    // homeSeen:敌方地块到过将军 2 格内(与 strategy 同口径,曼哈顿距离)
    if (homeSeenAt < 0) {
      for (let t = 0; t < W * game.map.height; t++) {
        if (game.map.tileAt(t) !== opp) continue;
        if (Math.abs(((t / W) | 0) - gr) + Math.abs((t % W) - gc) <= 2) { homeSeenAt = rt; break; }
      }
    }
    // homeExposed:敌兵>=6 在 4 格内
    for (let t = 0; t < W * game.map.height; t++) {
      if (game.map.tileAt(t) !== opp || game.map.armyAt(t) < 6) continue;
      if (Math.abs(((t / W) | 0) - gr) + Math.abs((t % W) - gc) <= 4) { lastExposed = game.turn; break; }
    }
    if (game.turn - lastExposed < 30) exposedHalfTurns++;

    // 中立塔机会计数(每 10 回合抽样一次,避免重复计同一个塔)
    if (rt % 10 === 0 && game.turn % 2 === 0) {
      const enemyTiles = [];
      for (let t = 0; t < W * game.map.height; t++) if (game.map.tileAt(t) === opp) enemyTiles.push(t);
      for (const c of citySet) {
        if (game.map.tileAt(c) >= 0) continue;      // 已被人占,不是中立塔
        const dGen = Math.abs(((c / W) | 0) - gr) + Math.abs((c % W) - gc);
        let dEn = Infinity;
        for (const t of enemyTiles) {
          const dd = Math.abs(((c / W) | 0) - ((t / W) | 0)) + Math.abs((c % W) - (t % W));
          if (dd < dEn) dEn = dd;
        }
        if (dGen <= dEn) {   // 与 cityDefensible(CITY_SIDE=0) 同口径:在我这一侧
          oppsTotal++;
          if (homeSeenAt >= 0) oppsAfterHomeSeen++;
        }
      }
    }

    for (const c of citySet) {
      const now = game.map.tileAt(c);
      if (now === cityOwner[c]) continue;
      if (now === me && cityOwner[c] !== me) myCityCaps++;
      if (now === opp && cityOwner[c] !== opp) oppCityCaps++;
      cityOwner[c] = now;
    }
  }
  const iLost = game.deaths.indexOf(game.sockets[me]) >= 0;
  const turns = Math.max(1, Math.floor(game.turn / 2));
  rows.push({ id: r.id, iLost, turns, homeSeenAt, myCityCaps, oppCityCaps,
    exposedFrac: exposedHalfTurns / (turns * 2), oppsTotal, oppsAfterHomeSeen,
    stars: (r.stars && r.stars[opp]) || 0 });
}

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[(s.length / 2) | 0]; };

console.log(`打完的对局 ${rows.length} 局\n`);
const seen = rows.filter((r) => r.homeSeenAt >= 0);
console.log(`【homeSeen(敌地曾进将军 2 格内,永不复位)】`);
console.log(`  整局发生过的比例  ${seen.length}/${rows.length} = ${(seen.length / rows.length * 100).toFixed(1)}%`);
console.log(`  首次发生的回合    中位 t${med(seen.map((r) => r.homeSeenAt))}   均值 t${mean(seen.map((r) => r.homeSeenAt)).toFixed(0)}`);
console.log(`  ★ 之后被封掉的赛程占整局  ${(mean(seen.map((r) => 1 - r.homeSeenAt / r.turns)) * 100).toFixed(1)}%`);
console.log(`  homeExposed(另一道门)占整局 ${(mean(rows.map((r) => r.exposedFrac)) * 100).toFixed(1)}%`);

console.log(`\n【中立塔机会(可见中立 + 在我这一侧,每 10 回合抽样)】`);
console.log(`  总机会次数 均值 ${mean(rows.map((r) => r.oppsTotal)).toFixed(1)}   其中发生在 homeSeen 之后 ${mean(rows.map((r) => r.oppsAfterHomeSeen)).toFixed(1)}` +
  `  = ${(mean(rows.map((r) => r.oppsAfterHomeSeen)) / Math.max(0.01, mean(rows.map((r) => r.oppsTotal))) * 100).toFixed(1)}%`);

console.log(`\n【按 homeSeen 早晚分组:我方夺城数】`);
const withSeen = rows.filter((r) => r.homeSeenAt >= 0);
const early = withSeen.filter((r) => r.homeSeenAt <= med(withSeen.map((x) => x.homeSeenAt)));
const late = withSeen.filter((r) => r.homeSeenAt > med(withSeen.map((x) => x.homeSeenAt)));
const never = rows.filter((r) => r.homeSeenAt < 0);
for (const [tag, a] of [['homeSeen 较早', early], ['homeSeen 较晚', late], ['整局未发生', never]]) {
  if (!a.length) continue;
  console.log(`  ${tag.padEnd(14)} ${String(a.length).padStart(3)} 局   我方夺城 ${mean(a.map((r) => r.myCityCaps)).toFixed(2)}   ` +
    `对手夺城 ${mean(a.map((r) => r.oppCityCaps)).toFixed(2)}   我方胜率 ${(a.filter((r) => !r.iLost).length / a.length * 100).toFixed(1)}%`);
}
