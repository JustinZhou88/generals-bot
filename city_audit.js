'use strict';
/*
 * city_audit.js — 用真人实战回放审计"打塔"这件事
 *
 * 三个问题:
 *  (1) 数量与时机:我方打了几座、什么时候打的,与胜负的关系;对手怎么打的。
 *  (2) 误打塔:打下来之后守不守得住 —— 多久被夺回、驻军剩多少。
 *  (3) 是否是"被发现"的上游:打塔之后多久我方将军被对手找到?
 *      (79 局真人数据显示"被找到"是 100% 败局的共同点,见 real-human-loss-mode-being-found)
 *
 * 用法: GIO_ME=zjxnb node city_audit.js protodump_human106
 */

const fs = require('fs');
const path = require('path');
const LZString = require('lz-string');
const Game = require('./replays/Game');

const DIR = process.argv[2];
const ME = process.env.GIO_ME || 'zjxnb';
if (!DIR) { console.log('用法: GIO_ME=<名字> node city_audit.js <目录>'); process.exit(1); }

function deserialize(buf) {
  const obj = JSON.parse(LZString.decompressFromUint8Array(new Uint8Array(buf)));
  let i = 0; const r = {};
  for (const k of ['version','id','mapWidth','mapHeight','usernames','stars','cities','cityArmies','generals','mountains']) r[k] = obj[i++];
  r.moves = obj[i++].map((s) => ({ index: s[0], start: s[1], end: s[2], is50: s[3], turn: s[4] }));
  r.afks = obj[i++].map((s) => ({ index: s[0], turn: s[1] }));
  r.teams = obj[i++]; r.map_title = obj[i++];
  return r;
}

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

const games = [];

for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.gior'))) {
  let r;
  try { r = deserialize(fs.readFileSync(path.join(DIR, f))); } catch (e) { continue; }
  if (!r.usernames || r.usernames.length !== 2) continue;
  const me = r.usernames.indexOf(ME);
  if (me < 0) continue;
  const opp = 1 - me;
  if (r.afks.length) continue;   // 只看打完的局

  let game;
  try { game = Game.createFromReplay(r); } catch (e) { continue; }
  const myGen = r.generals[me];
  const cities = (r.cities || []).slice();
  const citySet = new Set(cities);
  const badHits = [];
  const owner = {};            // city tile -> 当前归属
  for (const c of cities) owner[c] = game.map.tileAt(c);

  const caps = [];             // 我方每次夺城 {turn, tile, distGen, garrison, lostAt}
  let mi = 0, theyFound = -1;

  while (!game.isOver() && game.turn < 3000) {
    while (r.moves.length > mi && r.moves[mi].turn <= game.turn) {
      const m = r.moves[mi++];
      // 【用户提出】"有的塔明明不够打下来也会打"。
      // tryCaptureCity 的取城分支自己会校验兵力,但 marchCost 用的是 allowCity:true,
      // 路径可以**穿过**城市 —— 穿过就是攻击它。兵不够就是整摞兵撞上去全没。
      // 这里在应用每一步之前判定:目的地是非我方城市,且带过去的兵吃不下。
      if (m.index === me && citySet.has(m.end) && game.map.tileAt(m.end) !== me) {
        const carry = m.is50 ? Math.floor((game.map.armyAt(m.start)) / 2) : game.map.armyAt(m.start) - 1;
        const def = game.map.armyAt(m.end);
        if (carry > 0 && carry <= def) badHits.push({ turn: Math.floor(game.turn / 2), carry, def });
      }
      try { game.handleAttack(m.index, m.start, m.end, m.is50); } catch (e) {}
    }
    game.update();
    const rt = Math.floor(game.turn / 2);
    if (theyFound < 0 && game.generals[me] >= 0 && visibleMask(game, opp)[myGen]) theyFound = rt;

    for (const c of cities) {
      const now = game.map.tileAt(c);
      if (now === owner[c]) continue;
      if (now === me && owner[c] !== me) {
        // from: 夺城前的归属。-1/负数 = 中立塔,=opp = 对手的塔。
        // strategy_v51.js 的 cityDefensible 只对中立塔生效,对手的塔直接放行 ——
        // 所以这一栏能直接判断"被夺回的塔"是不是集中在没有守得住判据的那一类。
        caps.push({ turn: rt, tile: c, garrison: game.map.armyAt(c), lostAt: -1,
          fromEnemy: owner[c] === opp });
      } else if (owner[c] === me && now !== me) {
        for (let k = caps.length - 1; k >= 0; k--) {
          if (caps[k].tile === c && caps[k].lostAt < 0) { caps[k].lostAt = rt; break; }
        }
      }
      owner[c] = now;
    }
  }
  const lost = game.deaths.indexOf(game.sockets[me]) >= 0;
  // 对手夺城数(整局)
  let oppCities = 0;
  for (const c of cities) if (game.map.tileAt(c) === opp) oppCities++;
  let myCities = 0;
  for (const c of cities) if (game.map.tileAt(c) === me) myCities++;
  games.push({ id: r.id, opp: r.usernames[opp], lost, caps, theyFound,
    badHits,
    turns: Math.floor(game.turn / 2), myCities, oppCities, nCities: cities.length });
}

const W = games.filter((g) => !g.lost), L = games.filter((g) => g.lost);
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[(s.length / 2) | 0]; };

console.log(`打完的对局 ${games.length} 局 —— ${W.length} 胜 ${L.length} 负\n`);

console.log(`【1. 数量】`);
console.log(`  我方夺城次数(整局)   胜局 ${mean(W.map((g) => g.caps.length)).toFixed(2)}   败局 ${mean(L.map((g) => g.caps.length)).toFixed(2)}`);
console.log(`  终局持有城数         胜局 ${mean(W.map((g) => g.myCities)).toFixed(2)}   败局 ${mean(L.map((g) => g.myCities)).toFixed(2)}`);
console.log(`  对手终局持有城数     胜局 ${mean(W.map((g) => g.oppCities)).toFixed(2)}   败局 ${mean(L.map((g) => g.oppCities)).toFixed(2)}`);
console.log(`  一座都没打的局       胜局 ${(W.filter((g) => !g.caps.length).length / Math.max(1, W.length) * 100).toFixed(1)}%   败局 ${(L.filter((g) => !g.caps.length).length / Math.max(1, L.length) * 100).toFixed(1)}%`);

const allCaps = games.flatMap((g) => g.caps.map((c) => ({ ...c, lost: g.lost, turns: g.turns })));
console.log(`\n【2. 时机】(共 ${allCaps.length} 次夺城)`);
console.log(`  夺城回合 中位 ${med(allCaps.map((c) => c.turn))}   p25 ${[...allCaps.map((c) => c.turn)].sort((a, b) => a - b)[(allCaps.length * 0.25) | 0]}   p75 ${[...allCaps.map((c) => c.turn)].sort((a, b) => a - b)[(allCaps.length * 0.75) | 0]}`);
for (const [lo, hi] of [[0, 50], [50, 100], [100, 150], [150, 1e9]]) {
  const g = allCaps.filter((c) => c.turn >= lo && c.turn < hi);
  if (!g.length) continue;
  console.log(`    t${lo}~${hi === 1e9 ? '∞' : hi}: ${String(g.length).padStart(3)} 次,` +
    `其中发生在败局的 ${(g.filter((c) => c.lost).length / g.length * 100).toFixed(1)}%,` +
    `夺下时驻军中位 ${med(g.map((c) => c.garrison))}`);
}

console.log(`\n【3. 误打塔:守不守得住】`);
const held = allCaps.filter((c) => c.lostAt < 0), lostBack = allCaps.filter((c) => c.lostAt >= 0);
console.log(`  夺下后守住到终局 ${held.length}/${allCaps.length} = ${(held.length / Math.max(1, allCaps.length) * 100).toFixed(1)}%`);
console.log(`  被夺回           ${lostBack.length}/${allCaps.length} = ${(lostBack.length / Math.max(1, allCaps.length) * 100).toFixed(1)}%`);
if (lostBack.length) {
  const hold = lostBack.map((c) => c.lostAt - c.turn);
  console.log(`    被夺回的:持有时长中位 ${med(hold)} 回合,夺下时驻军中位 ${med(lostBack.map((c) => c.garrison))}`);
  console.log(`    30 回合内就被夺回: ${hold.filter((x) => x <= 30).length}/${hold.length} = ${(hold.filter((x) => x <= 30).length / hold.length * 100).toFixed(1)}%`);
}
console.log(`  守住的:夺下时驻军中位 ${med(held.map((c) => c.garrison))}`);

console.log(`\n  ★ 按"夺自中立塔 / 夺自对手"拆开:`);
for (const [label, sel] of [['中立塔', (c) => !c.fromEnemy], ['对手的塔', (c) => c.fromEnemy]]) {
  const g = allCaps.filter(sel);
  if (!g.length) { console.log(`    ${label}: 无`); continue; }
  const lb = g.filter((c) => c.lostAt >= 0);
  const hold = lb.map((c) => c.lostAt - c.turn);
  console.log(`    ${label.padEnd(7)} ${String(g.length).padStart(3)} 次   被夺回 ${lb.length}/${g.length} = ` +
    `${(lb.length / g.length * 100).toFixed(1).padStart(5)}%   ` +
    (hold.length ? `持有中位 ${String(med(hold)).padStart(3)} 回合   ` : '                    ') +
    `夺下时驻军中位 ${med(g.map((c) => c.garrison))}   发生在败局 ${(g.filter((c) => c.lost).length / g.length * 100).toFixed(1)}%`);
}

console.log(`\n【4. 打塔是不是"被发现"的上游】`);
const withFound = games.filter((g) => g.theyFound >= 0 && g.caps.length);
let near = 0, tot = 0;
for (const g of withFound) {
  for (const c of g.caps) { tot++; if (g.theyFound >= c.turn && g.theyFound - c.turn <= 30) near++; }
}
console.log(`  夺城后 30 回合内我方将军被发现: ${near}/${tot} = ${(near / Math.max(1, tot) * 100).toFixed(1)}%`);
const noCap = games.filter((g) => !g.caps.length);
console.log(`  对照 —— 全局未夺城的 ${noCap.length} 局中,被发现比例 ` +
  `${(noCap.filter((g) => g.theyFound >= 0).length / Math.max(1, noCap.length) * 100).toFixed(1)}%,胜率 ` +
  `${(noCap.filter((g) => !g.lost).length / Math.max(1, noCap.length) * 100).toFixed(1)}%`);
const yesCap = games.filter((g) => g.caps.length);
console.log(`         夺过城的 ${yesCap.length} 局中,被发现比例 ` +
  `${(yesCap.filter((g) => g.theyFound >= 0).length / Math.max(1, yesCap.length) * 100).toFixed(1)}%,胜率 ` +
  `${(yesCap.filter((g) => !g.lost).length / Math.max(1, yesCap.length) * 100).toFixed(1)}%`);

console.log(`\n【5. 兵不够却撞上去的塔(用户提出)】`);
const bh = games.flatMap((g) => g.badHits.map((b) => ({ ...b, lost: g.lost })));
console.log(`  总次数 ${bh.length} 次,${(bh.length / Math.max(1, games.length)).toFixed(2)} 次/局`);
if (bh.length) {
  console.log(`  白撞掉的兵:合计 ${bh.reduce((a, b) => a + b.carry, 0)},中位 ${med(bh.map((b) => b.carry))},均值 ${mean(bh.map((b) => b.carry)).toFixed(1)}`);
  console.log(`  每局白撞掉的兵 均值 ${(bh.reduce((a, b) => a + b.carry, 0) / Math.max(1, games.length)).toFixed(1)}`);
  console.log(`  发生在败局的比例 ${(bh.filter((b) => b.lost).length / bh.length * 100).toFixed(1)}%`);
  console.log(`  按带兵量分档:`);
  for (const [lo, hi] of [[1, 5], [5, 15], [15, 30], [30, 1e9]]) {
    const g = bh.filter((b) => b.carry >= lo && b.carry < hi);
    if (!g.length) continue;
    console.log(`    带 ${lo}~${hi === 1e9 ? '∞' : hi} 兵: ${String(g.length).padStart(4)} 次,守军中位 ${med(g.map((b) => b.def))},白扔 ${g.reduce((a, b) => a + b.carry, 0)} 兵`);
  }
  const perGame = games.map((g) => g.badHits.length);
  console.log(`  每局次数 中位 ${med(perGame)},最多的一局 ${Math.max(...perGame)} 次`);
  console.log(`  胜局均值 ${mean(W.map((g) => g.badHits.length)).toFixed(2)} 次   败局均值 ${mean(L.map((g) => g.badHits.length)).toFixed(2)} 次`);
}
