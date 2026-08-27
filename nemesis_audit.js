'use strict';
/*
 * nemesis_audit.js — 逐局拆解"稳定压制我们的对手"
 *
 * 目标只有一个:**他们是怎么找到我们将军的?**
 * 79→107 局真人数据显示"我方将军被找到"是 100% 败局的共同点(见
 * real-human-loss-mode-being-found),但从没查过对方用的是什么手段。
 *
 * 三种可能,用数据区分:
 *  (a) 专职细侦察 —— 派 1~2 兵的薄探子深入,发现时那格兵很少;
 *  (b) 正面推进撞上 —— 发现时那格兵很多,且他的地在同步增长;
 *  (c) 顺着我们的行军痕迹反推 —— 发现前他的推进方向与我方主力来向一致。
 *
 * 同时报城市运营的时间线,因为同局配对显示败局里对手夺城 3.11 vs 我方 1.32。
 *
 * 用法: GIO_ME=zjxnb node nemesis_audit.js <目录> ALL          # 全部对局
 *       GIO_ME=zjxnb node nemesis_audit.js <目录> "sabush" ...  # 指定对手
 */

const fs = require('fs');
const path = require('path');
const LZString = require('lz-string');
const Game = require('./replays/Game');

const DIR = process.argv[2];
const TARGETS = process.argv.slice(3);
const ME = process.env.GIO_ME || 'zjxnb';
if (!DIR || !TARGETS.length) { console.log('用法: GIO_ME=<名字> node nemesis_audit.js <目录> <对手名...>'); process.exit(1); }

function deserialize(buf) {
  const obj = JSON.parse(LZString.decompressFromUint8Array(new Uint8Array(buf)));
  let i = 0; const r = {};
  for (const k of ['version','id','mapWidth','mapHeight','usernames','stars','cities','cityArmies','generals','mountains']) r[k] = obj[i++];
  r.moves = obj[i++].map((s) => ({ index: s[0], start: s[1], end: s[2], is50: s[3], turn: s[4] }));
  r.afks = obj[i++].map((s) => ({ index: s[0], turn: s[1] }));
  r.teams = obj[i++]; r.map_title = obj[i++];
  return r;
}

const out = [];

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.gior'))) {
  let r;
  try { r = deserialize(fs.readFileSync(path.join(DIR, f))); } catch (e) { continue; }
  if (!r.usernames || r.usernames.length !== 2) continue;
  const me = r.usernames.indexOf(ME);
  if (me < 0) continue;
  const opp = 1 - me;
  if (TARGETS[0] !== "ALL" && !TARGETS.includes(r.usernames[opp])) continue;
  if (r.afks.length) continue;

  let game;
  try { game = Game.createFromReplay(r); } catch (e) { continue; }
  const W = r.mapWidth, H = r.mapHeight;
  const myGen = r.generals[me], oppGen = r.generals[opp];
  const citySet = new Set(r.cities || []);
  const d = (a, b) => Math.abs(((a / W) | 0) - ((b / W) | 0)) + Math.abs((a % W) - (b % W));

  let mi = 0, found = -1, foundArmy = null, foundTile = -1, foundDistFromTheirGen = null, myGenArmy = null;
  let landAtFound = null, myLandAtFound = null;
  // 发现前 20 回合他的地增量(区分"推进撞上"和"薄探子")
  let landHistory = [];
  const oppCityCaps = [], myCityCaps = [];
  const cityOwner = {};
  for (const c of citySet) cityOwner[c] = game.map.tileAt(c);

  while (!game.isOver() && game.turn < 3000) {
    while (r.moves.length > mi && r.moves[mi].turn <= game.turn) {
      const m = r.moves[mi++];
      try { game.handleAttack(m.index, m.start, m.end, m.is50); } catch (e) {}
    }
    game.update();
    const rt = Math.floor(game.turn / 2);
    if (game.turn % 2 === 0) landHistory.push(game.scores[opp].tiles);

    if (found < 0 && game.generals[me] >= 0) {
      // 他的哪些格子能看到我将军(8 邻域)
      let best = -1, bestA = Infinity;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = ((myGen / W) | 0) + dr, cc = (myGen % W) + dc;
        if (rr < 0 || rr >= H || cc < 0 || cc >= W) continue;
        const t = rr * W + cc;
        if (game.map.tileAt(t) !== opp) continue;
        const a = game.map.armyAt(t);
        if (a < bestA) { bestA = a; best = t; }   // 取兵最少的那格 = 探子的可能性
      }
      if (best >= 0) {
        found = rt; foundTile = best; foundArmy = bestA;
        myGenArmy = game.map.armyAt(myGen);
        foundDistFromTheirGen = d(best, oppGen);
        landAtFound = game.scores[opp].tiles;
        myLandAtFound = game.scores[me].tiles;
      }
    }
    for (const c of citySet) {
      const now = game.map.tileAt(c);
      if (now === cityOwner[c]) continue;
      if (now === opp && cityOwner[c] !== opp) oppCityCaps.push({ t: rt, garrison: game.map.armyAt(c) });
      if (now === me && cityOwner[c] !== me) myCityCaps.push({ t: rt, garrison: game.map.armyAt(c) });
      cityOwner[c] = now;
    }
  }
  const iLost = game.deaths.indexOf(game.sockets[me]) >= 0;
  const turns = Math.floor(game.turn / 2);
  // 发现前 20 回合他的地增量
  let landDelta = null;
  if (found > 20 && landHistory.length > found) landDelta = landHistory[found] - landHistory[found - 20];
  out.push({ id: r.id, opp: r.usernames[opp], stars: (r.stars && r.stars[opp]) || 0,
    iLost, turns, found, foundArmy, foundDistFromTheirGen, landAtFound, myLandAtFound, landDelta, myGenArmy,
    genDist: d(myGen, oppGen), oppCityCaps, myCityCaps });
}

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[(s.length / 2) | 0]; };

out.sort((a, b) => a.opp.localeCompare(b.opp) || a.found - b.found);
console.log(`${TARGETS[0] === 'ALL' ? '全部对手' : TARGETS.join(' / ')}  共 ${out.length} 局打完的` +
  (TARGETS[0] === 'ALL' ? `(下表只列 ${out.filter((x) => x.iLost).length} 场败局)` : '') + `\n`);
console.log(`  回放ID       对手         结果 局长  双将距  发现我将 发现格兵 距他家  他地/我地  前20回合他地+  他夺城  我夺城`);
for (const g of (TARGETS[0] === 'ALL' ? out.filter((x) => x.iLost) : out)) {
  console.log(`  ${g.id.padEnd(12)} ${g.opp.slice(0, 11).padEnd(11)} ${g.iLost ? '负' : '胜'}  ${String(g.turns).padStart(4)}  ` +
    `${String(g.genDist).padStart(5)}   ${String(g.found < 0 ? '未' : 't' + g.found).padStart(6)}  ` +
    `${String(g.foundArmy === null ? '-' : g.foundArmy).padStart(6)}  ${String(g.foundDistFromTheirGen === null ? '-' : g.foundDistFromTheirGen).padStart(5)}  ` +
    `${String(g.landAtFound === null ? '-' : g.landAtFound + '/' + g.myLandAtFound).padStart(9)}  ` +
    `${String(g.landDelta === null ? '-' : (g.landDelta >= 0 ? '+' : '') + g.landDelta).padStart(12)}  ` +
    `${String(g.oppCityCaps.length).padStart(5)}  ${String(g.myCityCaps.length).padStart(5)}`);
}

const fnd = out.filter((g) => g.found >= 0);
console.log(`\n【发现手段的判据】(${fnd.length} 局有发现事件)`);
console.log(`  发现我将那一格的兵力  中位 ${med(fnd.map((g) => g.foundArmy))}   均值 ${mean(fnd.map((g) => g.foundArmy)).toFixed(1)}`);
console.log(`    其中 <=2 兵(薄探子) ${fnd.filter((g) => g.foundArmy <= 2).length}/${fnd.length} = ${(fnd.filter((g) => g.foundArmy <= 2).length / fnd.length * 100).toFixed(0)}%`);
console.log(`    其中 >=20 兵(正面推进) ${fnd.filter((g) => g.foundArmy >= 20).length}/${fnd.length} = ${(fnd.filter((g) => g.foundArmy >= 20).length / fnd.length * 100).toFixed(0)}%`);
console.log(`  该格到他自己将军的距离 中位 ${med(fnd.map((g) => g.foundDistFromTheirGen))}  (双将距离中位 ${med(out.map((g) => g.genDist))})`);
const wd = fnd.filter((g) => g.landDelta !== null);
if (wd.length) console.log(`  发现前 20 回合他的地增量 中位 ${med(wd.map((g) => g.landDelta))}   均值 ${mean(wd.map((g) => g.landDelta)).toFixed(1)}`);

// 被发现时我方将军的驻军 —— 早期速攻能不能接住,全看这个数
const eb = fnd.filter((g) => g.found <= 60), lb = fnd.filter((g) => g.found > 60);
console.log(`\n【被发现时我方将军的驻军】`);
for (const [tag, a] of [['早期(<=t60)', eb], ['之后(>t60)', lb]]) {
  if (!a.length) continue;
  console.log(`  ${tag.padEnd(12)} ${a.length} 局   将军驻军 中位 ${med(a.map((g) => g.myGenArmy))}   ` +
    `对方来袭兵力 中位 ${med(a.map((g) => g.foundArmy))}   我方存活 ${a.filter((g) => !g.iLost).length}/${a.length}`);
}
console.log(`\n【城市】他夺城 均值 ${mean(out.map((g) => g.oppCityCaps.length)).toFixed(2)}   我夺城 均值 ${mean(out.map((g) => g.myCityCaps.length)).toFixed(2)}`);
const oc = out.flatMap((g) => g.oppCityCaps), mc = out.flatMap((g) => g.myCityCaps);
if (oc.length) console.log(`  他的夺城回合 中位 t${med(oc.map((c) => c.t))}   我方 中位 t${mc.length ? med(mc.map((c) => c.t)) : '-'}`);
