'use strict';
/*
 * fetch_gior.js — 把 DUMP_PROTO 录到的对局补齐官方 .gior 回放
 *
 * 为什么需要:DUMP_PROTO 落的是 `<replay_id>_p<idx>.jsonl`(我方视角逐帧,带迷雾),
 * 而 cap_audit.js / conformance.js 要的是 .gior —— 里面有**双方**的真实走子和
 * 对手将军的真实位置,审计"我方视角够不够得到敌将"必须靠它。
 *
 * 用法: node fetch_gior.js protodump_v51_ffa
 *       下完直接 node cap_audit.js protodump_v51_ffa
 */

const fs = require('fs');
const path = require('path');

// 机器服的回放在 -bot 桶;主服务器在 -na / -eu。挨个试。
const BUCKETS = [
  'https://generalsio-replays-bot.s3.amazonaws.com',
  'https://generalsio-replays-na.s3.amazonaws.com',
  'https://generalsio-replays-eu.s3.amazonaws.com',
];

const DIR = process.argv[2];
if (!DIR) { console.log('用法: node fetch_gior.js <dump目录>'); process.exit(1); }

const ids = [...new Set(fs.readdirSync(DIR)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => f.replace(/_p\d+\.jsonl$/, '')))];

(async () => {
  let got = 0, had = 0, miss = 0;
  for (const id of ids) {
    const out = path.join(DIR, `${id}.gior`);
    if (fs.existsSync(out) && fs.statSync(out).size > 200) { had++; continue; }
    let ok = false;
    for (const b of BUCKETS) {
      let res;
      try { res = await fetch(`${b}/${id}.gior`); } catch (e) { continue; }
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      // S3 的 404 页面也是 200-ish 的小 XML,按大小兜一下底
      if (buf.length < 200) continue;
      fs.writeFileSync(out, buf);
      console.log(`✓ ${id}  ${buf.length}B  <- ${b.split('//')[1].split('.')[0]}`);
      got++; ok = true; break;
    }
    if (!ok) { console.log(`✗ ${id}  三个桶都没有(回放可能还没落盘,过几分钟再试)`); miss++; }
  }
  console.log(`\n共 ${ids.length} 局: 新下 ${got},已有 ${had},缺 ${miss}`);
})();
