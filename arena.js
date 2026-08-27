'use strict';

/**
 * 本地自对弈擂台 —— 用官方游戏引擎(replays/Game.js)当裁判,
 * 让两个 bot 在真实 1v1 起始地图上互打,统计胜率。
 *
 * 关键:每回合给每个 bot 喂一份"带战争迷雾"的视图,语义和官方服务器
 * 发的 map_diff 一致(只看得见己方地块 8 邻域,其余为迷雾 -3 / 迷雾障碍 -4)。
 * 这样 bot 用的还是它上服务器时同一套 GameState + Strategy,零改动。
 *
 * 用法:
 *   node arena.js                 # 现役 Strategy vs 简单基线,跑所有真实地图
 *   node arena.js --games 3       # 只跑前 3 张图(快速冒烟)
 *   node arena.js --cap 1000      # 单局回合上限(半回合)
 */

const fs = require('fs');
const path = require('path');
const Game = require('./replays/Game');
const { GameState } = require('./src/gamestate');
const { Strategy } = require('./src/strategy');

// ---------- 简单基线 bot:只会扩张 + 吃弱敌 + 收兵,无聚兵/斩首/防守 ----------
class SimpleBot {
  constructor(gs) { this.gs = gs; }
  nextMove() {
    const gs = this.gs;
    // 1) 从兵最多的己方地块吃相邻空地
    let best = null;
    for (let t = 0; t < gs.size; t++) {
      if (!gs.isMine(t) || gs.armies[t] <= 1) continue;
      for (const n of gs.neighbors(t)) {
        if (gs.terrain[n] === -1 && !gs.isCity(n)) {
          if (!best || gs.armies[t] > best.a) best = { from: t, to: n, a: gs.armies[t] };
        }
      }
    }
    if (best) return { from: best.from, to: best.to };
    // 2) 吃能赢的相邻敌格
    for (let t = 0; t < gs.size; t++) {
      if (!gs.isMine(t) || gs.armies[t] <= 1) continue;
      for (const n of gs.neighbors(t)) {
        if (gs.isEnemy(n) && gs.armies[t] > gs.armies[n] + 1 && !gs.isCity(n)) return { from: t, to: n };
      }
    }
    // 3) 否则把最大兵团随便往邻格挪(自然汇聚)
    let bt = -1, ba = 1;
    for (let t = 0; t < gs.size; t++) if (gs.isMine(t) && gs.armies[t] > ba) { ba = gs.armies[t]; bt = t; }
    if (bt >= 0) { const ns = gs.neighbors(bt); if (ns.length) return { from: bt, to: ns[0] }; }
    return null;
  }
}

// ---------- 战争迷雾视图 ----------
function neighbors8(t, W, H) {
  const r = Math.floor(t / W), c = t % W, res = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const nr = r + dr, nc = c + dc;
    if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
    res.push(nr * W + nc);
  }
  return res;
}

/**
 * 生成玩家 p 应该看到的带迷雾视图(原始数组)。
 *
 * 这是模拟器保真度的唯一真相来源:conformance.js 逐帧比对的就是这个函数的
 * 输出 vs 官方服务器实发数据(实测 367/367 帧完全一致)。所以它只能有一份 ——
 * 之前迷雾逻辑被抄成两份,v19 那次 100% 开局波次失败就是因为两份不一致。
 */
function buildView(game, p) {
  const map = game.map, W = map.width, H = map.height, size = W * H;
  const vis = new Uint8Array(size);
  for (let t = 0; t < size; t++) {
    if (map.tileAt(t) === p) {
      vis[t] = 1;
      for (const n of neighbors8(t, W, H)) vis[n] = 1;
    }
  }
  const citySet = new Set(game.cities);
  const armies = new Array(size), terrain = new Array(size);
  for (let t = 0; t < size; t++) {
    if (vis[t]) {
      terrain[t] = map.tileAt(t);
      armies[t] = map.armyAt(t);
    } else {
      armies[t] = 0;
      // 与真服务器一致:迷雾中的障碍(山/城)全图永远显示 -4,
      // 因此 -3(平雾)绝对无障碍——波次可以放心往里规划。
      const isObstacle = map.tileAt(t) === -2 || citySet.has(t);
      terrain[t] = isObstacle ? -4 : -3;
    }
  }
  const generals = game.generals.map((g, idx) => {
    if (idx === p) return g;              // 自己的将军始终可见(死了则 -1)
    return g >= 0 && vis[g] ? g : -1;      // 敌将仅在视野内时可见
  });
  const cities = [];
  for (const c of game.cities) if (vis[c]) cities.push(c);
  const scores = game.scores.map((s) => ({ i: s.i, total: s.total, tiles: s.tiles, dead: !!s.dead }));
  return { armies, terrain, cities, generals, scores };
}

/** 把 buildView 的视图注入玩家 p 的 GameState(bot 用的还是上服务器那一套,零改动) */
function injectView(gs, game, p) {
  const v = buildView(game, p);
  const mapArr = [game.map.width, game.map.height, ...v.armies, ...v.terrain];
  gs.update({
    map_diff: [0, mapArr.length, ...mapArr],
    cities_diff: [0, v.cities.length, ...v.cities],
    generals: v.generals,
    turn: game.turn,
    scores: v.scores,
  });
}

// ---------- 单局对弈 ----------
function playGame(replay, MakeA, MakeB, cap) {
  const game = Game.createFromReplay(replay);
  const gsA = new GameState(), gsB = new GameState();
  gsA.start({ playerIndex: 0, replay_id: 'arena', usernames: ['A', 'B'], teams: undefined });
  gsB.start({ playerIndex: 1, replay_id: 'arena', usernames: ['A', 'B'], teams: undefined });
  const botA = new MakeA(gsA), botB = new MakeB(gsB);

  const landAt = {};
  while (!game.isOver() && game.turn < cap) {
    for (const [p, gs, bot] of [[0, gsA, botA], [1, gsB, botB]]) {
      injectView(gs, game, p);
      let mv = null;
      try { mv = bot.nextMove(); } catch (e) { mv = null; }
      if (mv && Number.isInteger(mv.from) && Number.isInteger(mv.to)) {
        game.inputBuffer[p].push([mv.from, mv.to, !!mv.is50]);
      }
    }
    game.update();
    if (game.turn === 100) { // real turn 50
      landAt.a = game.scores.find((s) => s.i === 0).tiles;
      landAt.b = game.scores.find((s) => s.i === 1).tiles;
    }
  }

  const aDead = game.deaths.indexOf(game.sockets[0]) >= 0;
  const bDead = game.deaths.indexOf(game.sockets[1]) >= 0;
  let winner; // 0=A, 1=B, -1=timeout
  if (bDead && !aDead) winner = 0;
  else if (aDead && !bDead) winner = 1;
  else {
    // 超时未分胜负:按地块多者判定(近似)
    const sa = game.scores.find((s) => s.i === 0), sb = game.scores.find((s) => s.i === 1);
    winner = sa.tiles === sb.tiles ? -1 : (sa.tiles > sb.tiles ? 0 : 1);
  }
  return { winner, turns: Math.floor(game.turn / 2), landAt, timeout: game.turn >= cap };
}

// ---------- 跑一整轮:A vs B,每张图正反手各一局 ----------
function runMatch(replays, MakeA, MakeB, cap) {
  let aWins = 0, bWins = 0, draws = 0, timeouts = 0;
  const aT50 = [];
  for (const r of replays) {
    // 正手:A=玩家0, B=玩家1
    let g = playGame(r, MakeA, MakeB, cap);
    if (g.winner === 0) aWins++; else if (g.winner === 1) bWins++; else draws++;
    if (g.timeout) timeouts++;
    if (g.landAt.a != null) aT50.push(g.landAt.a);
    // 反手:交换出生点(A=玩家1)
    g = playGame(r, MakeB, MakeA, cap);
    if (g.winner === 1) aWins++; else if (g.winner === 0) bWins++; else draws++;
    if (g.timeout) timeouts++;
    if (g.landAt.b != null) aT50.push(g.landAt.b);
  }
  const total = aWins + bWins + draws;
  return { aWins, bWins, draws, timeouts, total, aT50 };
}

// ---------- 载入真实地图 ----------
function loadReplays() {
  const dirs = ['replays', 'replays/pro'];
  const out = [];
  for (const d of dirs) {
    const abs = path.join(__dirname, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (!f.endsWith('.json') || f.startsWith('analysis') || f.startsWith('list_') || f === 'pick.json') continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(abs, f)));
        if (r.generals && r.generals.length === 2 && r.mapWidth) out.push(r);
      } catch (e) { /* skip */ }
    }
  }
  return out;
}

// ---------- 主程序 ----------
function main() {
  const argv = process.argv.slice(2);
  const opt = { games: Infinity, cap: 1500 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--games') opt.games = parseInt(argv[++i], 10);
    if (argv[i] === '--cap') opt.cap = parseInt(argv[++i], 10);
  }
  let replays = loadReplays();
  if (Number.isFinite(opt.games)) replays = replays.slice(0, opt.games);
  console.log(`载入 ${replays.length} 张真实 1v1 地图,单局上限 ${opt.cap} 半回合\n`);

  const t0 = Date.now ? 0 : 0; // Date.now 在本环境不可用,跳过计时
  const { Strategy: StrategyV26 } = require('./src/strategy_v26');
  const res = runMatch(replays, Strategy, StrategyV26, opt.cap);

  const avg = (a) => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '-';
  console.log('==================== 结果 ====================');
  console.log(`Strategy(v27现役) vs StrategyV26(前版对标)   共 ${res.total} 局`);
  console.log(`  v27 胜: ${res.aWins}   v26 胜: ${res.bWins}   平/超时: ${res.draws}`);
  console.log(`  胜率: ${(res.aWins / res.total * 100).toFixed(1)}%   超时局数: ${res.timeouts}`);
  console.log(`  v27 平均 t50 地块: ${avg(res.aT50)}  (强者基准 ~48)`);
  console.log('=============================================');

}

if (require.main === module) main();

module.exports = { playGame, runMatch, injectView, buildView, SimpleBot, loadReplays };
