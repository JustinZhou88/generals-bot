'use strict';
/*
 * version_split.js — 按 bot.log 里的"激活策略"行,自动把实战对局归属到各版本
 *
 * 为什么要自动化:之前手动找切换点(v51→v54 是 TwmBcfCoe),每换一次版本就得手动找一次,
 * 容易错。而**版本归属错了,后面所有统计都是废的** —— 今天 v54 的判断全靠这个切分。
 *
 * 做法:bot.log 里 "[headless] ... 激活策略: src/strategy_vXX.js" 与
 * "replays/<id>" 交错出现,按行号顺序把每个 id 归给它上方最近的那个版本。
 * 然后把 .gior 分目录落盘,供 dump_status.js / opp_profile.js 等直接吃。
 *
 * 用法: node version_split.js
 *   输出: protodump_by_ver/v51/  v54/  v55/ ...  各含 .gior 与 _ledger.json
 */

const fs = require('fs');
const path = require('path');

const SKILL = '/Users/justin/Desktop/generals_io_headless_bot_skill';
const LOG = path.join(SKILL, 'bot.log');
const MD = path.join(SKILL, 'replay_links', 'replays.md');
const SRC = path.join(__dirname, 'protodump_human_all');
const OUT = path.join(__dirname, 'protodump_by_ver');

if (!fs.existsSync(LOG)) { console.log(`找不到 ${LOG}`); process.exit(1); }

// 1) 从 bot.log 建立 id → 版本 的映射
const lines = fs.readFileSync(LOG, 'utf8').split('\n');
const verOf = new Map();
let cur = '未知';
for (const ln of lines) {
  const mv = ln.match(/激活策略:\s*src\/strategy_(v\d+)\.js/);
  if (mv) { cur = mv[1]; continue; }
  const mr = ln.match(/replays\/([A-Za-z0-9_-]+)/);
  if (mr && !verOf.has(mr[1])) verOf.set(mr[1], cur);
}

// 2) 读台账拿结果/对手/时间
const led = [];
for (const ln of fs.readFileSync(MD, 'utf8').split('\n')) {
  const m = ln.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(WIN|LOSS)\s*\|\s*\[([^\]]+)\]/);
  if (m) led.push({ time: m[1], opp: m[2], res: m[3], id: m[4], ver: verOf.get(m[4]) || '未知' });
}

// 3) 分目录落盘
const byVer = {};
for (const r of led) (byVer[r.ver] = byVer[r.ver] || []).push(r);
fs.mkdirSync(OUT, { recursive: true });
console.log(`台账 ${led.length} 局,bot.log 认出 ${verOf.size} 个 id\n`);
console.log(`  版本    局数   台账胜负        首局时间              末局时间`);
for (const v of Object.keys(byVer).sort()) {
  const rows = byVer[v];
  const dir = path.join(OUT, v);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.gior')) fs.unlinkSync(path.join(dir, f));
  let copied = 0;
  for (const r of rows) {
    const src = path.join(SRC, `${r.id}.gior`);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dir, `${r.id}.gior`)); copied++; }
  }
  fs.writeFileSync(path.join(dir, '_ledger.json'), JSON.stringify(rows, null, 1));
  const w = rows.filter((r) => r.res === 'WIN').length;
  console.log(`  ${v.padEnd(7)} ${String(rows.length).padStart(4)}   ${String(w).padStart(3)}胜 ${String(rows.length - w).padStart(3)}负 = ` +
    `${(w / rows.length * 100).toFixed(1).padStart(5)}%   ${rows[0].time.padEnd(20)}  ${rows[rows.length - 1].time}` +
    `   (.gior ${copied})`);
}
console.log(`\n落盘到 ${OUT}/<版本>/ ,可直接:  GIO_ME=zjxnb node dump_status.js protodump_by_ver/v55`);
