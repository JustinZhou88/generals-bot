'use strict';
/*
 * conformance.js — 离线模拟器 vs 官方服务器 的逐半回合保真度校验
 *
 * 目的:回答"能不能完全离线模拟官方环境"。做法不是假设,而是证明:
 *   1. 用 DUMP_PROTO=<dir> 打一局官方对局,把服务器逐帧发给我方的视图落盘;
 *   2. 下载同一局的 .gior 回放(含双方全部真实走子);
 *   3. 用官方引擎(replays/Game.js)离线把这局重放一遍,每半回合用 arena.js
 *      的 injectView 逻辑生成"我方应该看到的视图";
 *   4. 逐格 diff 两者:armies / terrain / cities / generals / scores。
 *
 * 完全一致 ⇒ 离线擂台就是官方环境的忠实复制,可以放心用它做上万局的迭代;
 * 有差异 ⇒ 差异点就是必须修的模拟器 bug(v19 那次 100% 波次失败就是栽在这)。
 *
 * 用法:
 *   node conformance.js protodump/<replayId>_p0.jsonl
 *   node conformance.js --all protodump           # 目录下所有 dump
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const Game = require('./replays/Game');
const LZString = require('lz-string'); // 注: replays/LZString.js 是个 404 坏文件,别用

// ---------- .gior 下载与解码 ----------

const BUCKETS = [
  'https://generalsio-replays-na.s3.amazonaws.com',
  'https://generalsio-replays-eu.s3.amazonaws.com',
  'https://generalsio-replays-bot.s3.amazonaws.com',
];

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function deserializeMove(s) { return { index: s[0], start: s[1], end: s[2], is50: s[3], turn: s[4] }; }
function deserializeAFK(s) { return { index: s[0], turn: s[1] }; }

function deserialize(buf) {
  const obj = JSON.parse(LZString.decompressFromUint8Array(new Uint8Array(buf)));
  let i = 0;
  const r = {};
  r.version = obj[i++]; r.id = obj[i++]; r.mapWidth = obj[i++]; r.mapHeight = obj[i++];
  r.usernames = obj[i++]; r.stars = obj[i++]; r.cities = obj[i++]; r.cityArmies = obj[i++];
  r.generals = obj[i++]; r.mountains = obj[i++];
  r.moves = obj[i++].map(deserializeMove);
  r.afks = obj[i++].map(deserializeAFK);
  r.teams = obj[i++]; r.map_title = obj[i++];
  return r;
}

async function fetchReplay(id) {
  const cache = path.join(__dirname, 'protodump', `${id}.gior`);
  if (fs.existsSync(cache)) return deserialize(fs.readFileSync(cache));
  let lastErr;
  for (const b of BUCKETS) {
    try {
      const buf = await httpGet(`${b}/${id}.gior`);
      fs.writeFileSync(cache, buf);
      return deserialize(buf);
    } catch (e) { lastErr = e; }
  }
  throw new Error(`无法下载回放 ${id}: ${lastErr && lastErr.message}`);
}

// ---------- 离线视图生成(与 arena.js injectView 同源逻辑) ----------

// 视图生成直接复用 arena.js 的 buildView —— 保证"被校验的实现"和
// "跑对局的实现"是同一份代码,不会各自漂移。
const { buildView } = require('./arena');

// ---------- 比对 ----------

function diffFrame(live, sim, W) {
  const problems = [];
  const n = live.terrain.length;
  if (sim.terrain.length !== n) return [{ kind: 'size', detail: `live ${n} vs sim ${sim.terrain.length}` }];

  let terrDiff = 0, armyDiff = 0;
  const samples = [];
  for (let t = 0; t < n; t++) {
    if (live.terrain[t] !== sim.terrain[t]) {
      terrDiff++;
      if (samples.length < 6) samples.push({ t, r: (t / W) | 0, c: t % W, live: live.terrain[t], sim: sim.terrain[t], kind: 'terrain' });
    }
    if (live.armies[t] !== sim.armies[t]) {
      armyDiff++;
      if (samples.length < 12) samples.push({ t, r: (t / W) | 0, c: t % W, live: live.armies[t], sim: sim.armies[t], kind: 'army' });
    }
  }
  if (terrDiff) problems.push({ kind: 'terrain', count: terrDiff });
  if (armyDiff) problems.push({ kind: 'armies', count: armyDiff });

  const lg = JSON.stringify(live.generals), sg = JSON.stringify(sim.generals);
  if (lg !== sg) problems.push({ kind: 'generals', detail: `live ${lg} vs sim ${sg}` });

  // cities: 服务器的 cities 列表是累积的(见过就记住),离线只给当前可见 —— 单独标注
  const liveSet = new Set(live.cities), simSet = new Set(sim.cities);
  const onlyLive = [...liveSet].filter((c) => !simSet.has(c));
  const onlySim = [...simSet].filter((c) => !liveSet.has(c));
  if (onlyLive.length || onlySim.length) {
    problems.push({ kind: 'cities', detail: `仅服务器有 [${onlyLive}] / 仅离线有 [${onlySim}]` });
  }

  for (const s of live.scores) {
    const o = sim.scores.find((x) => x.i === s.i);
    if (!o) { problems.push({ kind: 'scores', detail: `缺少玩家 ${s.i}` }); continue; }
    if (o.total !== s.total || o.tiles !== s.tiles || !!o.dead !== !!s.dead) {
      problems.push({ kind: 'scores', detail: `p${s.i} live(total=${s.total},tiles=${s.tiles},dead=${s.dead}) vs sim(total=${o.total},tiles=${o.tiles},dead=${o.dead})` });
    }
  }
  return problems.length ? problems.concat(samples.length ? [{ kind: 'samples', samples }] : []) : [];
}

// ---------- 主流程 ----------

async function checkDump(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 1);
  const meta = JSON.parse(lines[0]);
  const frames = lines.slice(1).map((l) => JSON.parse(l));
  console.log(`\n### ${path.basename(file)}  replay=${meta.replayId} 我方index=${meta.playerIndex} 帧数=${frames.length}`);

  const replay = await fetchReplay(meta.replayId);
  const game = Game.createFromReplay(replay);
  const W = replay.mapWidth;

  const byTurn = new Map();
  for (const f of frames) byTurn.set(f.turn, f);

  let mi = 0, ai = 0;
  let checked = 0, bad = 0;
  const kindTotals = {};
  let firstBad = null;

  const maxTurn = Math.max(...frames.map((f) => f.turn));
  while (!game.isOver() && game.turn <= maxTurn + 2) {
    while (replay.moves.length > mi && replay.moves[mi].turn <= game.turn) {
      const m = replay.moves[mi++];
      game.handleAttack(m.index, m.start, m.end, m.is50);
    }
    while (replay.afks.length > ai && replay.afks[ai].turn <= game.turn) {
      const a = replay.afks[ai++];
      if (game.deaths.indexOf(game.sockets[a.index]) >= 0) game.tryNeutralizePlayer(a.index);
      else { game.deaths.push(game.sockets[a.index]); game.alivePlayers--; }
    }
    game.update();

    const live = byTurn.get(game.turn);
    if (!live) continue;
    const sim = buildView(game, meta.playerIndex);
    const problems = diffFrame(live, sim, W);
    checked++;
    if (problems.length) {
      bad++;
      for (const p of problems) if (p.kind !== 'samples') kindTotals[p.kind] = (kindTotals[p.kind] || 0) + 1;
      if (!firstBad) firstBad = { turn: game.turn, problems };
    }
  }

  console.log(`  比对 ${checked} 帧  一致 ${checked - bad}  不一致 ${bad}  (${checked ? ((1 - bad / checked) * 100).toFixed(2) : '0'}% 一致)`);
  if (bad) {
    console.log(`  不一致类别统计:`, kindTotals);
    console.log(`  首个不一致 @turn=${firstBad.turn}:`);
    for (const p of firstBad.problems) {
      if (p.kind === 'samples') { for (const s of p.samples) console.log(`      样本 tile=${s.t}(r${s.r},c${s.c}) ${s.kind}: 服务器=${s.live} 离线=${s.sim}`); }
      else console.log(`      ${p.kind}${p.count !== undefined ? ' ×' + p.count : ''}${p.detail ? ': ' + p.detail : ''}`);
    }
  }
  return { checked, bad, kindTotals };
}

(async function main() {
  const argv = process.argv.slice(2);
  let files = [];
  if (argv[0] === '--all') {
    const dir = argv[1] || 'protodump';
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
  } else if (argv[0]) files = [argv[0]];
  else { console.error('用法: node conformance.js <protodump/xxx_p0.jsonl>  或  node conformance.js --all protodump'); process.exit(1); }

  let totChecked = 0, totBad = 0;
  const allKinds = {};
  for (const f of files) {
    try {
      const r = await checkDump(f);
      totChecked += r.checked; totBad += r.bad;
      for (const k in r.kindTotals) allKinds[k] = (allKinds[k] || 0) + r.kindTotals[k];
    } catch (e) { console.log(`  ${path.basename(f)} 校验失败: ${e.message}`); }
  }
  console.log(`\n======== 总计: ${totChecked} 帧, 一致 ${totChecked - totBad}, 不一致 ${totBad} ========`);
  if (totBad) console.log('不一致类别:', allKinds);
  else console.log('✅ 离线模拟器与官方服务器逐帧完全一致');
})();
