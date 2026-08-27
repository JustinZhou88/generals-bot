'use strict';
/*
 * oscil_audit.js — 数"来回震荡"的走子:A→B 紧接着 B→A
 *
 * 起因:v54 上线后 12 局真人实战 0 胜 11 负(控制对手 >=25★ 后 0-10,
 * 同分段的 v51 是 7-6),而且局长中位从 ~160 涨到 ~330 回合。
 * 最可疑的失效形态是 PAUSE_GATHER 每个 pause 回合都去聚兵,
 * 造成"聚一步 → 局面复位 → 聚回来"的原地震荡:步数在烧,局面不推进。
 *
 * 记忆里已有旁证:模仿排序器无记忆会来回震荡,所以 v24 加了"禁止立即折返";
 * 高手的回头率只有 3.5%。这里就量这个率。
 *
 * 用法: GIO_ME=zjxnb node oscil_audit.js <目录>
 */

const fs = require('fs');
const path = require('path');
const LZString = require('lz-string');

const DIR = process.argv[2];
const ME = process.env.GIO_ME || 'zjxnb';
if (!DIR) { console.log('用法: GIO_ME=<名字> node oscil_audit.js <目录>'); process.exit(1); }

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
  const mine = r.moves.filter((m) => m.index === me);
  const theirs = r.moves.filter((m) => m.index === opp);
  if (mine.length < 30) continue;

  const rate = (mv) => {
    let back = 0, rep = 0;
    for (let i = 1; i < mv.length; i++) {
      if (mv[i].start === mv[i - 1].end && mv[i].end === mv[i - 1].start) back++;
      // 更宽的"原地打转":最近 6 步里出现过同一条边
      for (let k = Math.max(0, i - 6); k < i; k++) {
        if (mv[i].start === mv[k].start && mv[i].end === mv[k].end) { rep++; break; }
      }
    }
    return { back: back / (mv.length - 1) * 100, rep: rep / (mv.length - 1) * 100 };
  };
  const a = rate(mine), b = rate(theirs.length > 30 ? theirs : mine);
  rows.push({ id: r.id, myMoves: mine.length, oppMoves: theirs.length,
    back: a.back, rep: a.rep, oppBack: theirs.length > 30 ? b.back : null,
    turns: Math.floor((r.moves.length ? r.moves[r.moves.length - 1].turn : 0) / 2),
    stars: (r.stars && r.stars[opp]) || 0 });
}

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const med = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[(s.length / 2) | 0]; };

console.log(`目录 ${DIR}:  ${rows.length} 局\n`);
console.log(`  我方立即折返率(A→B 紧接 B→A)  均值 ${mean(rows.map((r) => r.back)).toFixed(2)}%   中位 ${med(rows.map((r) => r.back)).toFixed(2)}%`);
console.log(`  我方近 6 步内重复同一条边      均值 ${mean(rows.map((r) => r.rep)).toFixed(2)}%   中位 ${med(rows.map((r) => r.rep)).toFixed(2)}%`);
const ob = rows.map((r) => r.oppBack).filter((x) => x !== null);
if (ob.length) console.log(`  对照·对手折返率                均值 ${mean(ob).toFixed(2)}%  (高手实测约 3.5%)`);
console.log(`  我方走子数 中位 ${med(rows.map((r) => r.myMoves))}   局长(回合) 中位 ${med(rows.map((r) => r.turns))}`);
console.log(`  对手星级 中位 ${med(rows.map((r) => r.stars))}`);
console.log('\n  回放ID       局长  我方步数  折返%   重复边%  对手星');
for (const r of rows.sort((a, b) => b.turns - a.turns)) {
  console.log(`  ${r.id.padEnd(12)} ${String(r.turns).padStart(4)}   ${String(r.myMoves).padStart(6)}   ` +
    `${r.back.toFixed(1).padStart(5)}   ${r.rep.toFixed(1).padStart(6)}   ${String(r.stars).padStart(4)}`);
}
