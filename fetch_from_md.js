'use strict';
/*
 * fetch_from_md.js — 从 replays.md 台账把 .gior 全部拉下来
 *
 * 主服务器(generals.io)的回放在 -na / -eu 桶;机器服在 -bot 桶。
 * 用法: node fetch_from_md.js <replays.md 路径> <输出目录>
 */
const fs = require('fs');
const path = require('path');

const BUCKETS = [
  'https://generalsio-replays-na.s3.amazonaws.com',
  'https://generalsio-replays-eu.s3.amazonaws.com',
  'https://generalsio-replays-bot.s3.amazonaws.com',
];

const MD = process.argv[2], OUT = process.argv[3];
if (!MD || !OUT) { console.log('用法: node fetch_from_md.js <replays.md> <输出目录>'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const text = fs.readFileSync(MD, 'utf8');
const rows = [];
for (const line of text.split('\n')) {
  // | 时间 | 对手 | 结果 | [id](url) |
  const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(WIN|LOSS)\s*\|\s*\[([^\]]+)\]/);
  if (m) rows.push({ time: m[1], opp: m[2], res: m[3], id: m[4] });
}
console.log(`台账里 ${rows.length} 局`);
fs.writeFileSync(path.join(OUT, '_ledger.json'), JSON.stringify(rows, null, 1));

(async () => {
  let got = 0, had = 0, miss = [];
  for (const r of rows) {
    const out = path.join(OUT, `${r.id}.gior`);
    if (fs.existsSync(out) && fs.statSync(out).size > 200) { had++; continue; }
    let ok = false;
    for (const b of BUCKETS) {
      let res;
      try { res = await fetch(`${b}/${r.id}.gior`); } catch (e) { continue; }
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200) continue;
      fs.writeFileSync(out, buf);
      got++; ok = true; break;
    }
    if (!ok) miss.push(r.id);
  }
  console.log(`新下 ${got},已有 ${had},缺 ${miss.length}` + (miss.length ? `: ${miss.slice(0, 8).join(' ')}` : ''));
})();
