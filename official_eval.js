'use strict';
/*
 * official_eval.js — 官方服务器 (bot.generals.io) 对局评测台
 *
 * 用法:
 *   node official_eval.js --a ./strategy_v28.js --b ./strategy_v27.js --games 8 --tag v28_vs_v27
 *   node official_eval.js --plan plan.json          # 批量: [{a,b,games,tag}, ...]
 *
 * 与 run_official_tournament_27.js 的区别:
 *   1. 接受任意策略文件路径(不限于 v1..v27),便于评测新候选;
 *   2. 每局交换加入顺序(先加入者拿 playerIndex 0),消除先后手偏差;
 *   3. 结果增量写盘、可中断续跑;
 *   4. 记录每局回合数/占地/兵力,便于事后诊断,而不只有胜负。
 *
 * 账号: 只使用已注册的两个 bot 账号,故同一时刻只能跑一局(串行)。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ACCOUNTS = [
  { id: 'syndrome_bot', name: '[Bot] syndrome_bot' },
  { id: 'syndrome_bot_b', name: '[Bot] Bot_B' },
];

const GAME_TIMEOUT_MS = 15 * 60 * 1000; // 单局上限 15 分钟(实测正常局 3~7 分钟)
const BETWEEN_GAMES_MS = 4000;

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { games: 6, out: 'official_eval_results.json' };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--a') out.a = a[++i];
    else if (a[i] === '--b') out.b = a[++i];
    else if (a[i] === '--games') out.games = parseInt(a[++i], 10);
    else if (a[i] === '--tag') out.tag = a[++i];
    else if (a[i] === '--plan') out.plan = a[++i];
    else if (a[i] === '--out') out.out = a[++i];
  }
  return out;
}

const args = parseArgs();
const RESULTS_FILE = path.join(__dirname, args.out);

let results = {};
if (fs.existsSync(RESULTS_FILE)) {
  try { results = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')); }
  catch (e) { console.error('结果文件解析失败,重新开始'); results = {}; }
}
function save() { fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2)); }

const activeChildren = new Set();
function cleanup() {
  for (const c of activeChildren) { try { c.kill('SIGKILL'); } catch (e) {} }
  activeChildren.clear();
}
process.on('SIGTERM', () => { cleanup(); process.exit(1); });
process.on('SIGINT', () => { cleanup(); process.exit(1); });
process.on('exit', cleanup);

/** 从 bot 日志里抽取最后一次进度行,拿到回合数/兵力/地块 */
function parseStats(log) {
  const lines = log.match(/\[game\] turn=(\d+) 兵力=(\d+) 地块=(\d+)/g) || [];
  if (!lines.length) return null;
  const m = lines[lines.length - 1].match(/turn=(\d+) 兵力=(\d+) 地块=(\d+)/);
  return { turn: +m[1], army: +m[2], tiles: +m[3] };
}

/**
 * 跑一局。swap=true 时 B 先加入房间(拿 index 0),用于抵消先后手偏差。
 * 返回 {winner:'a'|'b'|null, replayUrl, statsA, statsB}
 */
function runGame(stratA, stratB, gameIdx, swap) {
  return new Promise((resolve) => {
    const room = `ev${Date.now().toString(36).slice(-5)}${gameIdx}`;
    // 先加入的一方拿到 playerIndex 0
    const first = swap ? 'b' : 'a';
    const spec = {
      a: { strat: stratA, acct: ACCOUNTS[0] },
      b: { strat: stratB, acct: ACCOUNTS[1] },
    };

    const logs = { a: '', b: '' };
    const codes = { a: null, b: null };
    const children = {};
    let replayUrl = '';
    let done = false;

    function launch(side) {
      const env = Object.assign({}, process.env, {
        GENERALS_USER_ID: spec[side].acct.id,
        GENERALS_USERNAME: spec[side].acct.name,
        STRATEGY_FILE: spec[side].strat,
        SINGLE_GAME: 'true',
      });
      const ch = spawn('node', ['index.js', '--mode', 'private', '--game', room], { env, cwd: __dirname });
      activeChildren.add(ch);
      children[side] = ch;
      const onData = (d) => {
        const s = d.toString();
        logs[side] += s;
        if (!replayUrl) {
          const m = s.match(/https:\/\/bot\.generals\.io\/replays\/[A-Za-z0-9_-]+/);
          if (m) replayUrl = m[0];
        }
      };
      ch.stdout.on('data', onData);
      ch.stderr.on('data', onData);
      ch.on('exit', (code) => { codes[side] = code; activeChildren.delete(ch); finish(); });
    }

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      for (const s of ['a', 'b']) if (children[s]) children[s].kill('SIGKILL');
      resolve({ winner: null, reason: 'timeout', replayUrl });
    }, GAME_TIMEOUT_MS);

    function finish() {
      if (done) return;
      if (codes.a === null || codes.b === null) return;
      done = true;
      clearTimeout(timer);
      let winner = null;
      // 退出码 0 = 胜, 42 = 负
      if (codes.a === 0 && codes.b === 42) winner = 'a';
      else if (codes.b === 0 && codes.a === 42) winner = 'b';
      else if (logs.a.includes('🏆 胜利!') && !logs.b.includes('🏆 胜利!')) winner = 'a';
      else if (logs.b.includes('🏆 胜利!') && !logs.a.includes('🏆 胜利!')) winner = 'b';
      resolve({
        winner,
        reason: winner ? 'ok' : `undecided(exitA=${codes.a},exitB=${codes.b})`,
        replayUrl,
        statsA: parseStats(logs.a),
        statsB: parseStats(logs.b),
      });
    }

    // 先手方先启动,间隔 1.5s 保证加入顺序确定
    launch(first);
    setTimeout(() => launch(first === 'a' ? 'b' : 'a'), 1500);
  });
}

async function runMatchup({ a, b, games, tag }) {
  const key = tag || `${a}__vs__${b}`;
  if (!results[key]) results[key] = { a, b, games: [], winsA: 0, winsB: 0 };
  const rec = results[key];
  console.log(`\n=== 擂台: ${key}  (A=${a}  B=${b})  目标 ${games} 局,已完成 ${rec.games.length} 局 ===`);

  while (rec.games.length < games) {
    const idx = rec.games.length;
    const swap = idx % 2 === 1; // 奇数局交换先后手
    process.stdout.write(`  第 ${idx + 1}/${games} 局 (${swap ? 'B先手' : 'A先手'}) 进行中… `);
    const t0 = Date.now();
    const r = await runGame(a, b, idx, swap);
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (r.winner === 'a') rec.winsA++;
    else if (r.winner === 'b') rec.winsB++;
    rec.games.push({ idx, swap, winner: r.winner, reason: r.reason, replayUrl: r.replayUrl, statsA: r.statsA, statsB: r.statsB, secs: +secs });
    save();
    const label = r.winner === 'a' ? 'A胜' : r.winner === 'b' ? 'B胜' : `无效(${r.reason})`;
    console.log(`${label}  [${secs}s]  比分 A ${rec.winsA} : ${rec.winsB} B   ${r.replayUrl || ''}`);
    if (r.winner === null && r.reason === 'timeout') {
      // 超时局不计入目标局数,重来
      rec.games.pop();
      save();
    }
    await new Promise((res) => setTimeout(res, BETWEEN_GAMES_MS));
  }

  const n = rec.winsA + rec.winsB;
  const rate = n ? ((rec.winsA / n) * 100).toFixed(1) : '0.0';
  console.log(`=== ${key} 结束: A ${rec.winsA} - ${rec.winsB} B  (A 胜率 ${rate}%) ===`);
  return rec;
}

(async function main() {
  let plan;
  if (args.plan) {
    plan = JSON.parse(fs.readFileSync(path.join(__dirname, args.plan), 'utf8'));
  } else if (args.a && args.b) {
    plan = [{ a: args.a, b: args.b, games: args.games, tag: args.tag }];
  } else {
    console.error('用法: node official_eval.js --a ./strategy_vX.js --b ./strategy_vY.js --games N [--tag 名字]');
    console.error('  或: node official_eval.js --plan plan.json');
    process.exit(1);
  }

  for (const m of plan) await runMatchup(m);

  console.log('\n============ 官方对局评测汇总 ============');
  for (const key in results) {
    const r = results[key];
    const n = r.winsA + r.winsB;
    const rate = n ? ((r.winsA / n) * 100).toFixed(1) : '—';
    console.log(`  ${key.padEnd(28)} A ${String(r.winsA).padStart(2)} - ${String(r.winsB).padEnd(2)} B   A胜率 ${rate}%  (${n} 局)`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
