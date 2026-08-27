'use strict';
/*
 * roundrobin.js — 全代际大循环赛(离线)
 *
 * 官方服务器上这是 351 组配对 × BO3 ≈ 40 小时(且只跑完了 5 组)。
 * 离线模拟器已被 conformance.js 证明与官方逐帧一致,同样的对局在这里
 * 几分钟跑完,而且每局都是 mapgen 生成的全新随机图(不会过拟合固定地图)。
 *
 * 用法: node roundrobin.js --versions 1-27 --games 24 [--jobs 8]
 * 输出: roundrobin_results.json + 排行榜(按胜率)
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { playGame, wilson } = require('./ladder');
const { generateMap } = require('./mapgen');

const CAP = 3000;

if (process.argv[2] === '--worker') {
  const job = JSON.parse(process.argv[3]);
  const { Strategy: SA } = require(job.fileA);
  const { Strategy: SB } = require(job.fileB);
  let aw = 0, bw = 0, dr = 0;
  for (let i = 0; i < job.games; i++) {
    const mapObj = generateMap(job.seed + i * 7919);
    const aFirst = i % 2 === 0;
    const r = aFirst ? playGame(mapObj, SA, SB, CAP) : playGame(mapObj, SB, SA, CAP);
    const aIdx = aFirst ? 0 : 1;
    if (r.winner === aIdx) aw++;
    else if (r.winner === -1) dr++;
    else bw++;
  }
  process.send({ key: job.key, a: job.a, b: job.b, aw, bw, dr });
  process.exit(0);
}

function parseVersions(spec) {
  const out = [];
  for (const part of spec.split(',')) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) { for (let i = +m[1]; i <= +m[2]; i++) out.push(i); }
    else out.push(parseInt(part, 10));
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = { versions: '1-27', games: 24, seed: 4242, jobs: Math.max(1, Math.min(os.cpus().length - 1, 8)) };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--versions') opt.versions = argv[++i];
    else if (argv[i] === '--games') opt.games = parseInt(argv[++i], 10);
    else if (argv[i] === '--jobs') opt.jobs = parseInt(argv[++i], 10);
    else if (argv[i] === '--seed') opt.seed = parseInt(argv[++i], 10);
    else if (argv[i] === '--extra') opt.extra = argv[++i]; // 额外候选文件,标签 cand
  }

  const vers = parseVersions(opt.versions);
  const entries = vers.map((v) => ({ label: `v${v}`, file: path.resolve(__dirname, `./src/strategy_v${v}.js`) }));
  if (opt.extra) entries.push({ label: 'cand', file: path.resolve(__dirname, opt.extra) });

  const jobs = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      jobs.push({
        key: `${entries[i].label}_vs_${entries[j].label}`,
        a: entries[i].label, b: entries[j].label,
        fileA: entries[i].file, fileB: entries[j].file,
        games: opt.games, seed: opt.seed,
      });
    }
  }

  console.log(`大循环赛: ${entries.length} 个版本, ${jobs.length} 组配对, 每组 ${opt.games} 局 = ${jobs.length * opt.games} 局`);
  console.log(`并行 ${opt.jobs} 进程\n`);

  const stats = {};
  for (const e of entries) stats[e.label] = { w: 0, l: 0, d: 0, pairWins: 0, pairLosses: 0 };
  const pairings = {};

  const t0 = Date.now();
  let idx = 0, running = 0, done = 0;
  await new Promise((resolve) => {
    function launch() {
      while (running < opt.jobs && idx < jobs.length) {
        const job = jobs[idx++];
        running++;
        const child = fork(__filename, ['--worker', JSON.stringify(job)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        let err = '';
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('message', (m) => {
          pairings[m.key] = { a: m.a, b: m.b, aw: m.aw, bw: m.bw, dr: m.dr };
          stats[m.a].w += m.aw; stats[m.a].l += m.bw; stats[m.a].d += m.dr;
          stats[m.b].w += m.bw; stats[m.b].l += m.aw; stats[m.b].d += m.dr;
          if (m.aw > m.bw) { stats[m.a].pairWins++; stats[m.b].pairLosses++; }
          else if (m.bw > m.aw) { stats[m.b].pairWins++; stats[m.a].pairLosses++; }
        });
        child.on('exit', (code) => {
          done++;
          if (code !== 0 && err) console.error(`${job.key} 异常: ${err.slice(0, 300)}`);
          if (done % 25 === 0) process.stdout.write(`  进度 ${done}/${jobs.length} 组 (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
          running--;
          if (idx >= jobs.length && running === 0) resolve(); else launch();
        });
      }
    }
    launch();
  });

  const table = Object.keys(stats).map((k) => {
    const s = stats[k];
    const n = s.w + s.l + s.d;
    const ci = wilson(s.w, n);
    return { label: k, ...s, n, rate: n ? s.w / n : 0, lo: ci.lo, hi: ci.hi };
  }).sort((a, b) => b.rate - a.rate);

  fs.writeFileSync(path.join(__dirname, 'roundrobin_results.json'),
    JSON.stringify({ games: opt.games, seed: opt.seed, table, pairings }, null, 1));

  console.log(`\n============ 全代际大循环赛排行榜 (每组 ${opt.games} 局, 共 ${jobs.length * opt.games} 局) ============`);
  console.log(' 排名 | 版本  | 单局胜率 (95%CI)          | 单局 胜-负-平    | 配对 胜-负');
  console.log('------------------------------------------------------------------------');
  table.forEach((r, i) => {
    console.log(` ${('#' + (i + 1)).padEnd(4)} | ${r.label.padEnd(5)} | ${(r.rate * 100).toFixed(1).padStart(5)}% [${(r.lo * 100).toFixed(1)}, ${(r.hi * 100).toFixed(1)}]`.padEnd(52) +
      `| ${String(r.w).padStart(4)}-${String(r.l).padEnd(4)}-${String(r.d).padEnd(3)} | ${String(r.pairWins).padStart(3)}-${r.pairLosses}`);
  });
  console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s   结果已写入 roundrobin_results.json`);
}

if (require.main === module && process.argv[2] !== '--worker') main();
