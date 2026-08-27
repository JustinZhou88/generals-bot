'use strict';
/*
 * ver_report.js — 一条命令出"某版本在真人实战里的成绩",按对手强度分段
 *
 * 为什么必须按星级分段:v54 的原始胜率一度从 8.3% "回升"到 33.3%,看着像好转,
 * 但拆开发现回升全部来自 20★ 以下的对手,对 ≥20★ 是 0-14。
 * **原始胜率会骗人,爬梯会让对手池系统性变化。**
 *
 * 另外只统计"打完分出胜负"的局:对手中退/挂机的局不含策略信息
 * (实测机器服那批 8 局里 6 局是对方退的)。
 *
 * 用法: GIO_ME=zjxnb node ver_report.js protodump_by_ver/v55 [对照目录]
 */

const { execFileSync } = require('child_process');
const path = require('path');

const ME = process.env.GIO_ME || 'zjxnb';
const dirs = process.argv.slice(2);
if (!dirs.length) { console.log('用法: GIO_ME=<名字> node ver_report.js <目录> [对照目录]'); process.exit(1); }

function load(dir) {
  let out;
  try {
    out = execFileSync('node', [path.join(__dirname, 'dump_status.js'), dir],
      { env: { ...process.env, GIO_ME: ME }, encoding: 'utf8' });
  } catch (e) { return []; }
  const rows = [];
  for (const ln of out.split('\n')) {
    const m = ln.match(/^\s+(\S+)\s+([胜负])\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*?)\s*\((\d+)★\)\s*$/);
    if (m) rows.push({ id: m[1], res: m[2], turns: +m[3], oppMoves: +m[4], how: m[5], opp: m[6], stars: +m[7] });
  }
  return rows;
}

const BUCKETS = [[0, 1e9, '全部'], [20, 1e9, '≥20★'], [25, 1e9, '≥25★'], [30, 1e9, '≥30★']];
const med = (a) => { if (!a.length) return '-'; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

const sets = dirs.map((d) => ({ dir: d, rows: load(d) }));
for (const s of sets) {
  const dec = s.rows.filter((r) => r.how.includes('打完'));
  console.log(`\n=== ${s.dir} ===`);
  console.log(`  总局数 ${s.rows.length},其中打完分出胜负 ${dec.length}(对手中退 ${s.rows.length - dec.length})`);
  console.log(`  对手星级中位 ${med(s.rows.map((r) => r.stars))}   局长中位 ${med(dec.map((r) => r.turns))} 回合`);
  console.log(`  ┌ 对手门槛   局数    胜-负     胜率`);
  for (const [lo, hi, lab] of BUCKETS) {
    const a = dec.filter((r) => r.stars >= lo && r.stars < hi);
    if (!a.length) { console.log(`  │ ${lab.padEnd(9)}     0     -         -`); continue; }
    const w = a.filter((r) => r.res === '胜').length;
    console.log(`  │ ${lab.padEnd(9)} ${String(a.length).padStart(4)}   ${String(w).padStart(3)}-${String(a.length - w).padEnd(3)}   ${(w / a.length * 100).toFixed(1).padStart(5)}%`);
  }
  // 反复交手的对手
  const by = {};
  for (const r of dec) (by[r.opp] = by[r.opp] || []).push(r);
  const rep = Object.entries(by).filter(([, v]) => v.length >= 2)
    .map(([k, v]) => `${k}(${v.filter((x) => x.res === '胜').length}-${v.filter((x) => x.res === '负').length})`);
  if (rep.length) console.log(`  └ 交手 ≥2 次: ${rep.join('  ')}`);
}

if (sets.length >= 2) {
  console.log(`\n=== 对照 ===`);
  console.log(`  对手门槛   ` + sets.map((s) => path.basename(s.dir).padEnd(14)).join(''));
  for (const [lo, hi, lab] of BUCKETS) {
    const cells = sets.map((s) => {
      const a = s.rows.filter((r) => r.how.includes('打完') && r.stars >= lo && r.stars < hi);
      if (!a.length) return '-'.padEnd(14);
      const w = a.filter((r) => r.res === '胜').length;
      return `${w}-${a.length - w} (${(w / a.length * 100).toFixed(0)}%)`.padEnd(14);
    });
    console.log(`  ${lab.padEnd(10)} ` + cells.join(''));
  }
}
