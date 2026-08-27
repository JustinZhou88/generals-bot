'use strict';
/*
 * cap_audit.js — 用真实排位对局审计"侦察投影封顶"是否把对手将军排除在外
 *
 * 背景:v42 引入 projCap = 已见敌格最深投影 × SCOUT_CAP(1.05),离线验证 +5.7pp。
 * 但与用户的 5 场败局显示,ht100 时对手将军**全部**落在封顶之外 —— 机制性够不到。
 * 5 局样本太小,这里用账号历史里的真实排位对局(真人 + bot 对手)重算,看差异是否成立。
 *
 * 做法:官方引擎重放回放,每个采样点按我方视角(迷雾重建)算出封顶,
 * 再看对手将军的真实投影是否超过封顶。
 *
 * 用法: node cap_audit.js [protodump]
 */

const fs = require('fs');
const path = require('path');
const LZString = require('lz-string');
const Game = require('./replays/Game');

const DIR = process.argv[2] || 'protodump';
const ME = process.env.GIO_ME || '[Bot] syndrome_bot';
const SAMPLES = [100, 150, 200, 250, 300];
const SCOUT_CAP = 1.05;

function deserialize(buf) {
  const obj = JSON.parse(LZString.decompressFromUint8Array(new Uint8Array(buf)));
  let i = 0;
  const r = {};
  r.version = obj[i++]; r.id = obj[i++]; r.mapWidth = obj[i++]; r.mapHeight = obj[i++];
  r.usernames = obj[i++]; r.stars = obj[i++]; r.cities = obj[i++]; r.cityArmies = obj[i++];
  r.generals = obj[i++]; r.mountains = obj[i++];
  r.moves = obj[i++].map((s) => ({ index: s[0], start: s[1], end: s[2], is50: s[3], turn: s[4] }));
  r.afks = obj[i++].map((s) => ({ index: s[0], turn: s[1] }));
  r.teams = obj[i++]; r.map_title = obj[i++];
  return r;
}

/** 我方视角可见的格子(自己地块的 8 邻域) */
function visibleMask(game, me) {
  const map = game.map, W = map.width, H = map.height, size = W * H;
  const vis = new Uint8Array(size);
  for (let t = 0; t < size; t++) {
    if (map.tileAt(t) !== me) continue;
    const r = (t / W) | 0, c = t % W;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < H && cc >= 0 && cc < W) vis[rr * W + cc] = 1;
    }
  }
  return vis;
}

const rows = [];
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.gior'))) {
  let r;
  try { r = deserialize(fs.readFileSync(path.join(DIR, f))); } catch (e) { continue; }
  if (!r.usernames || r.usernames.length !== 2) continue;
  const me = r.usernames.indexOf(ME);
  if (me < 0) continue;
  const opp = 1 - me;
  const oppName = r.usernames[opp];
  const isBotOpp = oppName.startsWith('[Bot]');

  let game;
  try { game = Game.createFromReplay(r); } catch (e) { continue; }
  const W = r.mapWidth;
  const oppGen = r.generals[opp];
  let mi = 0, ai = 0;
  const per = [];
  let everSeenTurn = -1;   // 逐半回合累计:第一次看见对手将军的时刻

  while (!game.isOver() && game.turn < 400) {
    while (r.moves.length > mi && r.moves[mi].turn <= game.turn) {
      const m = r.moves[mi++];
      try { game.handleAttack(m.index, m.start, m.end, m.is50); } catch (e) {}
    }
    while (r.afks.length > ai && r.afks[ai].turn <= game.turn) {
      const a = r.afks[ai++];
      if (game.deaths.indexOf(game.sockets[a.index]) >= 0) game.tryNeutralizePlayer(a.index);
      else { game.deaths.push(game.sockets[a.index]); game.alivePlayers--; }
    }
    game.update();
    // 每个半回合都要判"看见没有" —— 原来只在 5 个采样点判,会漏掉采样点之间的发现
    if (everSeenTurn < 0 && game.generals[opp] >= 0) {
      const v0 = visibleMask(game, me);
      if (v0[game.generals[opp]]) everSeenTurn = game.turn;
    }
    if (!SAMPLES.includes(game.turn)) continue;

    const vis = visibleMask(game, me);
    const myGen = game.generals[me];
    if (myGen < 0) continue;
    const gr = (myGen / W) | 0, gc = myGen % W;
    // 可见敌格与重心(与 tryScout 同口径)
    let er = 0, ec = 0, n = 0;
    for (let t = 0; t < W * game.map.height; t++) {
      if (vis[t] && game.map.tileAt(t) === opp) { er += (t / W) | 0; ec += t % W; n++; }
    }
    if (!n) continue;
    er /= n; ec /= n;
    const dr = er - gr, dc = ec - gc;
    let maxProj = 0;
    for (let t = 0; t < W * game.map.height; t++) {
      if (!vis[t] || game.map.tileAt(t) !== opp) continue;
      const p = (((t / W) | 0) - gr) * dr + ((t % W) - gc) * dc;
      if (p > maxProj) maxProj = p;
    }
    const genProj = (((oppGen / W) | 0) - gr) * dr + ((oppGen % W) - gc) * dc;
    const seen = vis[oppGen] === 1;
    const dirLen = Math.hypot(dr, dc) || 1;
    per.push({ turn: game.turn, genProj, maxProj, dirLen, seen });
  }
  if (per.length) rows.push({ id: r.id, oppName, isBotOpp, per, everSeenTurn });
}

// 候选封顶策略:给定采样点,返回封顶值。可以随时加新策略来对照。
const POLICIES = {
  '现状 1.05 固定': (p) => p.maxProj * 1.05,
  '时间放宽 t>=100': (p) => p.maxProj * 1.05 * (1 + Math.max(0, p.turn - 100) / 100),
  '时间放宽 t>=60': (p) => p.maxProj * 1.05 * (1 + Math.max(0, p.turn - 60) / 60),
  '距离下限 20 格': (p) => Math.max(p.maxProj * 1.05, 20 * p.dirLen),
  '时间放宽 t>=150 /40': (p) => p.maxProj * 1.05 * (1 + Math.max(0, p.turn - 150) / 40),
  '时间放宽 t>=150 /25': (p) => p.maxProj * 1.05 * (1 + Math.max(0, p.turn - 150) / 25),
  '时间放宽 t>=200 /25': (p) => p.maxProj * 1.05 * (1 + Math.max(0, p.turn - 200) / 25),
  '晚下限: t>150 才给 20 格': (p) => p.turn > 150 ? Math.max(p.maxProj * 1.05, 20 * p.dirLen) : p.maxProj * 1.05,
};

function policyTable(label, subset) {
  const pts = subset.flatMap((r) => r.per);
  if (!pts.length) return;
  console.log(`\n${label} (${subset.length} 局, ${pts.length} 时点) —— 各策略的"将军被排除"比例:`);
  for (const [name, fn] of Object.entries(POLICIES)) {
    const ex = pts.filter((p) => p.genProj > fn(p)).length;
    const early = pts.filter((p) => p.turn <= 150);
    const exEarly = early.filter((p) => p.genProj > fn(p)).length;
    console.log(`  ${name.padEnd(26)} 总 ${(ex / pts.length * 100).toFixed(1).padStart(5)}%   ht<=150 ${(early.length ? exEarly / early.length * 100 : 0).toFixed(1).padStart(5)}%`);
  }
}

function summarise(label, subset) {
  const pts = subset.flatMap((r) => r.per);
  if (!pts.length) { console.log(`${label}: 无数据`); return; }
  const ex = pts.filter((p) => p.genProj > p.maxProj * SCOUT_CAP).length;
  const everSeen = subset.filter((r) => r.everSeenTurn >= 0).length;
  const seenTurns = subset.filter((r) => r.everSeenTurn >= 0).map((r) => r.everSeenTurn).sort((a, b) => a - b);
  console.log(`\n${label}  ${subset.length} 局, ${pts.length} 个采样时点`);
  console.log(`  将军被封顶排除的时点: ${ex}/${pts.length} = ${(ex / pts.length * 100).toFixed(1)}%`);
  console.log(`  ht400 前看见过对手将军的局: ${everSeen}/${subset.length} = ${(everSeen / subset.length * 100).toFixed(1)}%` +
    (seenTurns.length ? `   发现回合中位 ht${seenTurns[(seenTurns.length / 2) | 0]}` : ''));
  for (const ht of SAMPLES) {
    const s = pts.filter((p) => p.turn === ht);
    if (!s.length) continue;
    const e = s.filter((p) => p.genProj > p.maxProj * SCOUT_CAP).length;
    // v51 用 SCOUT_DEPTH=20 直接瞄"沿射线深度",所以这里同时报真将军的实际沿射线深度,
    // 才能判断这个先验瞄得准不准(仅"不被排除"是任何放开封顶的策略都能做到的)。
    const along = s.map((p) => p.genProj / p.dirLen).sort((a, b) => a - b);
    const q = (f) => along[Math.min(along.length - 1, Math.floor(f * along.length))].toFixed(1);
    console.log(`    ht${String(ht).padEnd(4)} 排除 ${e}/${s.length} = ${String((e / s.length * 100).toFixed(0)).padStart(3)}%` +
      `   真将军沿射线深度 p25/中位/p75 = ${q(0.25)}/${q(0.5)}/${q(0.75)}`);
  }
}

console.log(`审计 ${rows.length} 局真实对局的侦察封顶(SCOUT_CAP=${SCOUT_CAP})`);
summarise('【真人对手】', rows.filter((r) => !r.isBotOpp));
summarise('【机器人对手】', rows.filter((r) => r.isBotOpp));
console.log('\n========== 候选策略对照(真实对局重放) ==========');
policyTable('【真人对手】', rows.filter((r) => !r.isBotOpp));
policyTable('【机器人对手】', rows.filter((r) => r.isBotOpp));
