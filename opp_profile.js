'use strict';
/*
 * opp_profile.js — 真人对手画像:赢我们的人和输给我们的人,打法差在哪
 *
 * 139 局真人对局(60+ 对手)是手上最富的外部信号。这里不看我们自己,
 * **看对手**:把"赢我们的对手"和"输给我们的对手"分成两组,比较他们的打法指标。
 * 目的是找出下一代该学的东西 —— 而不是继续猜。
 *
 * 重点指标(选的都是记忆里已知有因果嫌疑的):
 *  - **最大野战兵团**(非将军非城的单格最大兵力):记忆里高手实测 82~86,
 *    而我方在实战中同期只有 ~34。这是从 v1 起就列为头号短板的"没有被保护的主力"。
 *  - 找将速度:双方各自第一次看到对方将军的回合。
 *  - 活跃度:每回合走子数(是否把每个半回合都用满)。
 *  - 打塔:夺城次数与时机。
 *  - 扩张曲线:t50/t100 的地与兵。
 *
 * 用法: GIO_ME=zjxnb node opp_profile.js <目录>
 */

const fs = require('fs');
const path = require('path');
const LZString = require('lz-string');
const Game = require('./replays/Game');

const DIR = process.argv[2];
const ME = process.env.GIO_ME || 'zjxnb';
if (!DIR) { console.log('用法: GIO_ME=<名字> node opp_profile.js <目录>'); process.exit(1); }

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

/** 某方的最大野战兵团(排除将军格与城) */
function maxField(game, p, citySet) {
  let m = 0;
  const gen = game.generals[p];
  for (let t = 0; t < game.map.width * game.map.height; t++) {
    if (game.map.tileAt(t) !== p) continue;
    if (t === gen || citySet.has(t)) continue;
    const a = game.map.armyAt(t);
    if (a > m) m = a;
  }
  return m;
}

const rows = [];
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
  const citySet = new Set(r.cities || []);
  const myGen = r.generals[me], oppGen = r.generals[opp];
  let mi = 0, iFound = -1, theyFound = -1;
  let myPeak = 0, oppPeak = 0;          // 整局最大野战兵团
  let my120 = null, opp120 = null;      // 第 120 回合(决胜时点)
  const snaps = {};
  let oppCityCaps = 0, myCityCaps = 0;
  const cityOwner = {};
  for (const c of citySet) cityOwner[c] = game.map.tileAt(c);

  while (!game.isOver() && game.turn < 3000) {
    while (r.moves.length > mi && r.moves[mi].turn <= game.turn) {
      const m = r.moves[mi++];
      try { game.handleAttack(m.index, m.start, m.end, m.is50); } catch (e) {}
    }
    game.update();
    const rt = Math.floor(game.turn / 2);
    if (iFound < 0 && game.generals[opp] >= 0 && visibleMask(game, me)[oppGen]) iFound = rt;
    if (theyFound < 0 && game.generals[me] >= 0 && visibleMask(game, opp)[myGen]) theyFound = rt;
    const mf = maxField(game, me, citySet), of = maxField(game, opp, citySet);
    if (mf > myPeak) myPeak = mf;
    if (of > oppPeak) oppPeak = of;
    if (game.turn === 240) { my120 = mf; opp120 = of; }
    if (game.turn % 2 === 0 && [50, 100, 150].includes(rt) && !snaps[rt]) {
      const s = game.scores;
      snaps[rt] = { myLand: s[me].tiles, myArmy: s[me].total, opLand: s[opp].tiles, opArmy: s[opp].total };
    }
    for (const c of citySet) {
      const now = game.map.tileAt(c);
      if (now === cityOwner[c]) continue;
      if (now === opp && cityOwner[c] !== opp) oppCityCaps++;
      if (now === me && cityOwner[c] !== me) myCityCaps++;
      cityOwner[c] = now;
    }
  }
  const iLost = game.deaths.indexOf(game.sockets[me]) >= 0;
  const turns = Math.floor(game.turn / 2);
  const oppMoves = r.moves.filter((m) => m.index === opp).length;
  const myMoves = r.moves.filter((m) => m.index === me).length;
  rows.push({ id: r.id, opp: r.usernames[opp], stars: (r.stars && r.stars[opp]) || 0,
    iLost, turns, iFound, theyFound, myPeak, oppPeak, my120, opp120,
    oppRate: oppMoves / Math.max(1, turns * 2), myRate: myMoves / Math.max(1, turns * 2),
    oppCityCaps, myCityCaps, snaps });
}

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[(s.length / 2) | 0]; };

const beatUs = rows.filter((r) => r.iLost);
const lostToUs = rows.filter((r) => !r.iLost);
console.log(`打完的对局 ${rows.length} 局 —— 对手赢 ${beatUs.length} / 对手输 ${lostToUs.length}\n`);

const line = (label, sel, fmt = (x) => x.toFixed(1)) => {
  const a = beatUs.map(sel).filter((x) => x !== null && x !== undefined);
  const b = lostToUs.map(sel).filter((x) => x !== null && x !== undefined);
  console.log(`  ${label.padEnd(30)} 赢我们的 ${fmt(mean(a)).padStart(7)}   输给我们的 ${fmt(mean(b)).padStart(7)}`);
};

console.log(`【对手的打法(按结果分组)】`);
line('星级', (r) => r.stars);
line('最大野战兵团(整局峰值)', (r) => r.oppPeak);
line('  第120回合的野战兵团', (r) => r.opp120);
line('每半回合走子率', (r) => r.oppRate, (x) => x.toFixed(3));
line('夺城次数', (r) => r.oppCityCaps, (x) => x.toFixed(2));
line('找到我方将军的回合', (r) => r.theyFound < 0 ? null : r.theyFound);
line('t100 时对手的地', (r) => r.snaps[100] ? r.snaps[100].opLand : null);
line('t100 时对手的兵', (r) => r.snaps[100] ? r.snaps[100].opArmy : null);

console.log(`\n【同一批局里我们自己的对应指标】`);
line('我方最大野战兵团(峰值)', (r) => r.myPeak);
line('  第120回合的野战兵团', (r) => r.my120);
line('我方每半回合走子率', (r) => r.myRate, (x) => x.toFixed(3));
line('我方夺城次数', (r) => r.myCityCaps, (x) => x.toFixed(2));
line('我方找到敌将的回合', (r) => r.iFound < 0 ? null : r.iFound);
line('t100 时我方的地', (r) => r.snaps[100] ? r.snaps[100].myLand : null);

console.log(`\n【★ 兵团规模差(第120回合:对手 - 我方)】`);
const gap120 = rows.filter((r) => r.my120 !== null && r.opp120 !== null);
const gb = gap120.filter((r) => r.iLost), gl = gap120.filter((r) => !r.iLost);
console.log(`  败局 ${mean(gb.map((r) => r.opp120 - r.my120)).toFixed(1)}   胜局 ${mean(gl.map((r) => r.opp120 - r.my120)).toFixed(1)}`);

// 反复赢我们的对手 —— 值得逐帧研究的名单
const byOpp = {};
for (const r of rows) { (byOpp[r.opp] = byOpp[r.opp] || []).push(r); }
const nem = Object.entries(byOpp)
  .map(([k, v]) => ({ opp: k, n: v.length, lost: v.filter((x) => x.iLost).length,
    peak: mean(v.map((x) => x.oppPeak)), stars: med(v.map((x) => x.stars)) }))
  .filter((x) => x.n >= 2 && x.lost >= 2)
  .sort((a, b) => (b.lost / b.n) - (a.lost / a.n) || b.n - a.n);
console.log(`\n【反复赢我们的对手(>=2 局且赢 >=2)】`);
console.log(`  对手                   局数  他赢  他的最大兵团(均)  星`);
for (const x of nem.slice(0, 12)) {
  console.log(`  ${x.opp.slice(0, 22).padEnd(22)} ${String(x.n).padStart(4)}  ${String(x.lost).padStart(4)}  ` +
    `${x.peak.toFixed(0).padStart(14)}  ${String(x.stars).padStart(3)}`);
}

// ---------- 同局配对比较:局长自动被控制掉 ----------
console.log(`\n【★★ 同局配对(同一局里 对手 vs 我方)】`);
const pair = (label, oppSel, mySel, fmt = (x) => x.toFixed(2)) => {
  for (const [tag, set] of [['败局', beatUs], ['胜局', lostToUs]]) {
    const a = set.filter((r) => oppSel(r) !== null && mySel(r) !== null);
    if (!a.length) continue;
    const o = mean(a.map(oppSel)), m = mean(a.map(mySel));
    console.log(`  ${(label + ' · ' + tag).padEnd(28)} 对手 ${fmt(o).padStart(7)}   我方 ${fmt(m).padStart(7)}   差 ${fmt(o - m).padStart(7)}   (n=${a.length})`);
  }
};
pair('夺城次数', (r) => r.oppCityCaps, (r) => r.myCityCaps);
pair('第120回合野战兵团', (r) => r.opp120, (r) => r.my120, (x) => x.toFixed(1));
pair('每半回合走子率', (r) => r.oppRate, (r) => r.myRate, (x) => x.toFixed(3));
pair('t100 地', (r) => r.snaps[100] ? r.snaps[100].opLand : null, (r) => r.snaps[100] ? r.snaps[100].myLand : null, (x) => x.toFixed(1));
pair('t100 兵', (r) => r.snaps[100] ? r.snaps[100].opArmy : null, (r) => r.snaps[100] ? r.snaps[100].myArmy : null, (x) => x.toFixed(1));
pair('t150 地', (r) => r.snaps[150] ? r.snaps[150].opLand : null, (r) => r.snaps[150] ? r.snaps[150].myLand : null, (x) => x.toFixed(1));

// 找将:用"占局长的比例"消掉局长混淆
console.log(`\n【找将(归一化到局长)】`);
for (const [tag, set] of [['败局', beatUs], ['胜局', lostToUs]]) {
  const a = set.filter((r) => r.turns > 0);
  const tf = a.filter((r) => r.theyFound >= 0);
  const mf = a.filter((r) => r.iFound >= 0);
  console.log(`  ${tag}: 对手找到我将 ${(tf.length / a.length * 100).toFixed(0)}% 的局` +
    (tf.length ? `,时点在局长的 ${(mean(tf.map((r) => r.theyFound / r.turns)) * 100).toFixed(0)}% 处` : '') +
    `   |   我方找到敌将 ${(mf.length / a.length * 100).toFixed(0)}% 的局` +
    (mf.length ? `,${(mean(mf.map((r) => r.iFound / r.turns)) * 100).toFixed(0)}% 处` : ''));
}
