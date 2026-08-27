'use strict';
/*
 * leak_audit.js — 检验"调兵汇聚到家会泄露将军位置"
 *
 * 【用户提出】"调兵过于集中——全部集中到自己的家再出发,或者频繁从家出发,
 * 容易让人类对手十分轻松地猜到你家的位置。"
 *
 * 这个假设很重要:79 局真人数据显示"我方将军被发现"是 **100% 败局**的共同点
 * (见 real-human-loss-mode-being-found),但一直没有解释**为什么**会被发现。
 * 如果泄露源是我们自己的行军形态,那就是一个可改的决策问题。
 *
 * 做法:对每一局,统计**被发现之前**(未被发现的局取全程)我方走子的形态:
 *   - 朝将军方向走的比例(= 聚兵回家)
 *   - 从将军近旁(<=3 格)出发的比例(= 从家出兵)
 *   - 我方兵力重心到将军的距离(重心离家越近,越像"家在这儿"的指向)
 * 再按"是否被发现 / 被发现的早晚"分组对照。
 *
 * 用法: GIO_ME=zjxnb node leak_audit.js protodump_human106
 */

const fs = require('fs');
const path = require('path');
const LZString = require('lz-string');
const Game = require('./replays/Game');

const DIR = process.argv[2];
const ME = process.env.GIO_ME || 'zjxnb';
if (!DIR) { console.log('用法: GIO_ME=<名字> node leak_audit.js <目录>'); process.exit(1); }

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
  if (r.afks.length) continue;

  let game;
  try { game = Game.createFromReplay(r); } catch (e) { continue; }
  const W = r.mapWidth;
  const myGen = r.generals[me];
  const gr = (myGen / W) | 0, gc = myGen % W;
  const d2gen = (t) => Math.abs(((t / W) | 0) - gr) + Math.abs((t % W) - gc);

  let mi = 0, theyFound = -1;
  let toward = 0, away = 0, fromHome = 0, nMoves = 0;
  let cenSum = 0, cenN = 0;

  while (!game.isOver() && game.turn < 3000) {
    while (r.moves.length > mi && r.moves[mi].turn <= game.turn) {
      const m = r.moves[mi++];
      if (m.index === me && theyFound < 0) {
        nMoves++;
        const df = d2gen(m.start), dt = d2gen(m.end);
        if (dt < df) toward++; else if (dt > df) away++;
        if (df <= 3) fromHome++;
      }
      try { game.handleAttack(m.index, m.start, m.end, m.is50); } catch (e) {}
    }
    game.update();
    const rt = Math.floor(game.turn / 2);
    if (theyFound < 0 && game.generals[me] >= 0 && visibleMask(game, opp)[myGen]) theyFound = rt;
    // 兵力重心到将军的距离(只在还没被发现时统计)
    if (theyFound < 0 && game.turn % 20 === 0) {
      let sr = 0, sc = 0, sw = 0;
      for (let t = 0; t < W * game.map.height; t++) {
        if (game.map.tileAt(t) !== me) continue;
        const a = game.map.armyAt(t);
        if (a <= 1) continue;
        sr += ((t / W) | 0) * a; sc += (t % W) * a; sw += a;
      }
      if (sw > 0) { cenSum += Math.abs(sr / sw - gr) + Math.abs(sc / sw - gc); cenN++; }
    }
  }
  const lost = game.deaths.indexOf(game.sockets[me]) >= 0;
  if (nMoves < 20) continue;
  games.push({ id: r.id, lost, theyFound,
    towardPct: toward / nMoves * 100,
    homePct: fromHome / nMoves * 100,
    centroid: cenN ? cenSum / cenN : null,
    nMoves });
}

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[(s.length / 2) | 0]; };

const found = games.filter((g) => g.theyFound >= 0);
const never = games.filter((g) => g.theyFound < 0);
const early = found.filter((g) => g.theyFound <= med(found.map((x) => x.theyFound)));
const late = found.filter((g) => g.theyFound > med(found.map((x) => x.theyFound)));

console.log(`样本 ${games.length} 局(打完、我方走子 >=20 步)\n`);
console.log(`被发现 ${found.length} 局(中位 t${med(found.map((g) => g.theyFound))})   从未被发现 ${never.length} 局\n`);

const row = (label, a) => {
  if (!a.length) { console.log(`  ${label.padEnd(16)} 无样本`); return; }
  const c = a.map((g) => g.centroid).filter((x) => x !== null);
  console.log(`  ${label.padEnd(16)} ${String(a.length).padStart(3)} 局   ` +
    `朝将军走 ${mean(a.map((g) => g.towardPct)).toFixed(1).padStart(5)}%   ` +
    `从家出发 ${mean(a.map((g) => g.homePct)).toFixed(1).padStart(5)}%   ` +
    `兵力重心离家 ${mean(c).toFixed(1).padStart(5)}`);
};

console.log(`【被发现前的行军形态】`);
row('从未被发现', never);
row('被发现(全部)', found);
row('  其中较早', early);
row('  其中较晚', late);

console.log(`\n【按胜负】`);
row('胜局', games.filter((g) => !g.lost));
row('败局', games.filter((g) => g.lost));

// 相关性:朝家走的比例 vs 被发现的回合
const withF = found.filter((g) => g.centroid !== null);
if (withF.length > 5) {
  const xs = withF.map((g) => g.towardPct), ys = withF.map((g) => g.theyFound);
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
  const rcorr = num / Math.sqrt(dx * dy);
  console.log(`\n【相关性】"朝将军走的比例" vs "被发现的回合"  r = ${rcorr.toFixed(3)}  (n=${withF.length})`);
  console.log(`  若假设成立应为**负相关**(越爱聚兵回家 → 越早被发现)`);
  const xs2 = withF.map((g) => g.homePct);
  const mx2 = mean(xs2);
  let num2 = 0, dx2 = 0;
  for (let i = 0; i < xs2.length; i++) { num2 += (xs2[i] - mx2) * (ys[i] - my); dx2 += (xs2[i] - mx2) ** 2; }
  console.log(`【相关性】"从家出发的比例" vs "被发现的回合"    r = ${(num2 / Math.sqrt(dx2 * dy)).toFixed(3)}`);
}
