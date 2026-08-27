'use strict';
/*
 * lossmode_real.js — 用真实真人对局做败因分析
 *
 * 此前的败因结论(找将率 94% vs 41%)是**离线自对弈**测出来的。
 * 记忆里反复出现的教训是:离线擂台会系统性偏好"只对 bot 成立"的机制。
 * 这里改用主服务器上对真人的真实回放重算,看哪些变量真正区分胜负。
 *
 * 只统计**打完**的局(对手无 afk 记录)—— 对手中途退出的局不含胜负信息。
 *
 * 用法: GIO_ME=zjxnb node lossmode_real.js protodump_human106
 */

const fs = require('fs');
const path = require('path');
const LZString = require('lz-string');
const Game = require('./replays/Game');

const DIR = process.argv[2];
const ME = process.env.GIO_ME || 'zjxnb';
if (!DIR) { console.log('用法: GIO_ME=<名字> node lossmode_real.js <目录>'); process.exit(1); }

function deserialize(buf) {
  const obj = JSON.parse(LZString.decompressFromUint8Array(new Uint8Array(buf)));
  let i = 0; const r = {};
  for (const k of ['version','id','mapWidth','mapHeight','usernames','stars','cities','cityArmies','generals','mountains']) r[k] = obj[i++];
  r.moves = obj[i++].map((s) => ({ index: s[0], start: s[1], end: s[2], is50: s[3], turn: s[4] }));
  r.afks = obj[i++].map((s) => ({ index: s[0], turn: s[1] }));
  r.teams = obj[i++]; r.map_title = obj[i++];
  return r;
}

/** p 视角可见的格子(自己地块的 8 邻域) */
function visibleMask(game, p) {
  const map = game.map, W = map.width, H = map.height, size = W * H;
  const vis = new Uint8Array(size);
  for (let t = 0; t < size; t++) {
    if (map.tileAt(t) !== p) continue;
    const r = (t / W) | 0, c = t % W;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < H && cc >= 0 && cc < W) vis[rr * W + cc] = 1;
    }
  }
  return vis;
}

const SNAP = [50, 100, 150, 200, 250, 300];  // 真实回合
const games = [];

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.gior'))) {
  let r;
  try { r = deserialize(fs.readFileSync(path.join(DIR, f))); } catch (e) { continue; }
  if (!r.usernames || r.usernames.length !== 2) continue;
  const me = r.usernames.indexOf(ME);
  if (me < 0) continue;
  const opp = 1 - me;
  if (r.afks.some((a) => a.index === opp)) continue;   // 对手中途退出,不计
  if (r.afks.some((a) => a.index === me)) continue;    // 我方掉线,不计

  let game;
  try { game = Game.createFromReplay(r); } catch (e) { continue; }
  const oppGen = r.generals[opp], myGen = r.generals[me];
  let mi = 0;
  let iFound = -1, theyFound = -1;
  const snaps = {};

  while (!game.isOver() && game.turn < 3000) {
    while (r.moves.length > mi && r.moves[mi].turn <= game.turn) {
      const m = r.moves[mi++];
      try { game.handleAttack(m.index, m.start, m.end, m.is50); } catch (e) {}
    }
    game.update();
    if (iFound < 0 && game.generals[opp] >= 0 && visibleMask(game, me)[oppGen]) iFound = Math.floor(game.turn / 2);
    if (theyFound < 0 && game.generals[me] >= 0 && visibleMask(game, opp)[myGen]) theyFound = Math.floor(game.turn / 2);
    const rt = Math.floor(game.turn / 2);
    if (game.turn % 2 === 0 && SNAP.includes(rt) && !snaps[rt]) {
      const s = game.scores;
      snaps[rt] = { land: s[me].tiles - s[opp].tiles, army: s[me].total - s[opp].total };
    }
  }
  const lost = game.deaths.indexOf(game.sockets[me]) >= 0;
  games.push({ id: r.id, opp: r.usernames[opp], lost, iFound, theyFound,
    turns: Math.floor(game.turn / 2), snaps });
}

const W = games.filter((g) => !g.lost), L = games.filter((g) => g.lost);
const pct = (a, f) => a.length ? (a.filter(f).length / a.length * 100).toFixed(1) + '%' : '-';
const mean = (a) => a.length ? (a.reduce((x, y) => x + y, 0) / a.length) : 0;
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[(s.length / 2) | 0]; };

console.log(`打完的对局 ${games.length} 局 —— ${W.length} 胜 ${L.length} 负 (${(W.length / games.length * 100).toFixed(1)}%)\n`);

console.log(`【判别变量:找将】`);
console.log(`  我方找到过敌将    胜局 ${pct(W, (g) => g.iFound >= 0).padStart(6)}   败局 ${pct(L, (g) => g.iFound >= 0).padStart(6)}`);
console.log(`    找到的中位回合  胜局 ${String(med(W.filter((g) => g.iFound >= 0).map((g) => g.iFound))).padStart(6)}   败局 ${String(med(L.filter((g) => g.iFound >= 0).map((g) => g.iFound))).padStart(6)}`);
console.log(`  对手找到过我将    胜局 ${pct(W, (g) => g.theyFound >= 0).padStart(6)}   败局 ${pct(L, (g) => g.theyFound >= 0).padStart(6)}`);
console.log(`    被找到中位回合  胜局 ${String(med(W.filter((g) => g.theyFound >= 0).map((g) => g.theyFound))).padStart(6)}   败局 ${String(med(L.filter((g) => g.theyFound >= 0).map((g) => g.theyFound))).padStart(6)}`);
console.log(`  ★谁先找到谁      我先 ${pct(games, (g) => g.iFound >= 0 && (g.theyFound < 0 || g.iFound < g.theyFound))}   其中胜率 ` +
  (() => { const a = games.filter((g) => g.iFound >= 0 && (g.theyFound < 0 || g.iFound < g.theyFound)); return a.length ? `${(a.filter((g) => !g.lost).length / a.length * 100).toFixed(1)}%` : '-'; })());
console.log(`                   他先 ${pct(games, (g) => g.theyFound >= 0 && (g.iFound < 0 || g.theyFound < g.iFound))}   其中胜率 ` +
  (() => { const a = games.filter((g) => g.theyFound >= 0 && (g.iFound < 0 || g.theyFound < g.iFound)); return a.length ? `${(a.filter((g) => !g.lost).length / a.length * 100).toFixed(1)}%` : '-'; })());

console.log(`\n【判别变量:局面领先(我 - 对手)】`);
console.log(`  回合    胜局 地/兵          败局 地/兵          样本(胜/败)`);
for (const t of SNAP) {
  const w = W.filter((g) => g.snaps[t]), l = L.filter((g) => g.snaps[t]);
  if (!w.length && !l.length) continue;
  console.log(`  t${String(t).padEnd(5)} ${mean(w.map((g) => g.snaps[t].land)).toFixed(1).padStart(6)} / ${mean(w.map((g) => g.snaps[t].army)).toFixed(1).padStart(7)}   ` +
    `${mean(l.map((g) => g.snaps[t].land)).toFixed(1).padStart(6)} / ${mean(l.map((g) => g.snaps[t].army)).toFixed(1).padStart(7)}   ` +
    `${w.length}/${l.length}`);
}

console.log(`\n【局长】  胜局中位 ${med(W.map((g) => g.turns))} 回合   败局中位 ${med(L.map((g) => g.turns))} 回合`);

// 败局里"领先却输"的比例 —— 今天实战观察到的形态
const aheadLost = L.filter((g) => g.snaps[150] && g.snaps[150].land > 0);
const l150 = L.filter((g) => g.snaps[150]);
console.log(`\n【领先却输】 t150 时地数领先的败局: ${aheadLost.length}/${l150.length} = ` +
  `${l150.length ? (aheadLost.length / l150.length * 100).toFixed(1) : 0}%`);

// 决定该修"别被发现"还是"被发现后守得住":
// 从被发现到死亡的间隔。间隔长 = 有时间反应,是防守问题;间隔短 = 发现即致命。
const gap = L.filter((g) => g.theyFound >= 0).map((g) => g.turns - g.theyFound).sort((a, b) => a - b);
if (gap.length) {
  console.log(`\n【被发现 → 死亡的间隔】(败局 ${gap.length} 局)`);
  console.log(`  中位 ${gap[(gap.length / 2) | 0]} 回合   p25 ${gap[(gap.length * 0.25) | 0]}   p75 ${gap[(gap.length * 0.75) | 0]}   均值 ${mean(gap).toFixed(1)}`);
  console.log(`  被发现后 20 回合内就死: ${gap.filter((x) => x <= 20).length}/${gap.length} = ${(gap.filter((x) => x <= 20).length / gap.length * 100).toFixed(1)}%`);
  console.log(`  撑过 50 回合以上:       ${gap.filter((x) => x > 50).length}/${gap.length} = ${(gap.filter((x) => x > 50).length / gap.length * 100).toFixed(1)}%`);
}
// 对照:胜局里我们被发现之后活了多久(说明"被发现"未必致命)
const gapW = W.filter((g) => g.theyFound >= 0).map((g) => g.turns - g.theyFound).sort((a, b) => a - b);
if (gapW.length) console.log(`  对照 —— 胜局中被发现后仍存活 ${gapW.length} 局,中位 ${gapW[(gapW.length / 2) | 0]} 回合`);
