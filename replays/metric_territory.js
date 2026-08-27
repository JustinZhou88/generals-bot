// 领土形态指标: 地块曲线 / 触角 / 周长比 / 战线推进
// 同一套统计逻辑分别跑 高手语料(replays/pro) 与 bot 自对弈(arena)
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const Game = require(path.join(__dirname, 'Game'));

// 采样点(半回合): 真实回合 25/50/75/100
const SAMPLE_HT = [50, 100, 150, 200];

// 对某玩家 p 在当前局面做形态统计
function sampleStats(game, p, W) {
  const size = game.map.size();
  const gen = game.generals[p];
  if (gen == null || gen < 0) return null;
  const gr = (gen / W) | 0, gc = gen % W;
  const H = (size / W) | 0;
  let n = 0, sumd = 0, maxd = 0, perim = 0, sr = 0, sc = 0;
  for (let t = 0; t < size; t++) {
    if (game.map.tileAt(t) !== p) continue;
    n++;
    const r = (t / W) | 0, c = t % W;
    sr += r; sc += c;
    const d = Math.abs(r - gr) + Math.abs(c - gc);
    sumd += d; if (d > maxd) maxd = d;
    let edge = false;
    if (c > 0 && game.map.tileAt(t - 1) !== p) edge = true;
    else if (c < W - 1 && game.map.tileAt(t + 1) !== p) edge = true;
    else if (r > 0 && game.map.tileAt(t - W) !== p) edge = true;
    else if (r < H - 1 && game.map.tileAt(t + W) !== p) edge = true;
    if (edge) perim++;
  }
  if (n === 0) return null;
  const cr = sr / n, cc = sc / n;
  return {
    tiles: n,
    avgDist: sumd / n,
    maxDist: maxd,
    perimRatio: perim / n,
    centroidDist: Math.sqrt((cr - gr) ** 2 + (cc - gc) ** 2),
  };
}

// 通用: 跑一局(引擎 game + 每步喂 move 的回调), 在采样点对 players 里每个玩家统计
// feedMoves(game) 在每个半回合前调用
function runAndSample(game, W, players, feedMoves, cap) {
  const out = {}; // ht -> {p: stats}
  while (!game.isOver() && game.turn < cap) {
    feedMoves(game);
    if (SAMPLE_HT.includes(game.turn)) {
      out[game.turn] = {};
      for (const p of players) out[game.turn][p] = sampleStats(game, p, W);
    }
    game.update();
  }
  return out;
}

// ---------- 高手语料 ----------
function runExpert() {
  const pick = JSON.parse(fs.readFileSync(path.join(__dirname, 'pro/pick.json')));
  const samples = []; // {ht, stats}
  let games = 0;
  for (const name of Object.keys(pick)) {
    for (const g of pick[name]) {
      const file = path.join(__dirname, 'pro', g.id + '.json');
      if (!fs.existsSync(file)) continue;
      const r = JSON.parse(fs.readFileSync(file));
      const me = r.usernames.indexOf(name);
      if (me < 0) continue;
      const game = Game.createFromReplay(r);
      let mi = 0;
      const res = runAndSample(game, r.mapWidth, [me], (game) => {
        while (r.moves.length > mi && r.moves[mi].turn <= game.turn) {
          const m = r.moves[mi++];
          game.handleAttack(m.index, m.start, m.end, m.is50);
        }
      }, 1200);
      games++;
      for (const ht of Object.keys(res)) {
        if (res[ht][me]) samples.push({ ht: +ht, s: res[ht][me] });
      }
    }
  }
  return { games, samples };
}

// ---------- bot 自对弈 ----------
function runBot() {
  const { injectView, loadReplays } = require(path.join(ROOT, 'arena'));
  const { GameState } = require(path.join(ROOT, 'src/gamestate'));
  const { Strategy } = require(path.join(ROOT, 'src/strategy'));
  const maps = loadReplays().slice(0, 12);
  const samples = [];
  let games = 0;
  for (const r of maps) {
    const game = Game.createFromReplay(r);
    const gsA = new GameState();
    gsA.start({ playerIndex: 0, replay_id: 'x', usernames: ['A', 'B'], teams: undefined });
    const gsB = new GameState();
    gsB.start({ playerIndex: 1, replay_id: 'x', usernames: ['A', 'B'], teams: undefined });
    const A = new Strategy(gsA), B = new Strategy(gsB);
    const res = runAndSample(game, r.mapWidth, [0, 1], (game) => {
      injectView(gsA, game, 0);
      let a = null; try { a = A.nextMove(); } catch (e) {}
      injectView(gsB, game, 1);
      let b = null; try { b = B.nextMove(); } catch (e) {}
      if (a) game.inputBuffer[0].push([a.from, a.to, !!a.is50]);
      if (b) game.inputBuffer[1].push([b.from, b.to, !!b.is50]);
    }, 800);
    games++;
    for (const ht of Object.keys(res)) {
      for (const p of [0, 1]) {
        if (res[ht][p]) samples.push({ ht: +ht, s: res[ht][p] });
      }
    }
  }
  return { games, samples };
}

// ---------- 汇总 ----------
function agg(samples) {
  const byHt = {};
  for (const { ht, s } of samples) {
    (byHt[ht] = byHt[ht] || []).push(s);
  }
  const out = {};
  for (const ht of SAMPLE_HT) {
    const arr = byHt[ht] || [];
    if (!arr.length) { out[ht] = null; continue; }
    const mean = (f) => arr.reduce((a, s) => a + f(s), 0) / arr.length;
    out[ht] = {
      n: arr.length,
      tiles: mean(s => s.tiles),
      avgDist: mean(s => s.avgDist),
      maxDist: mean(s => s.maxDist),
      perimRatio: mean(s => s.perimRatio),
      centroidDist: mean(s => s.centroidDist),
    };
  }
  return out;
}

function fmt(label, a) {
  console.log('==== ' + label + ' ====');
  for (const ht of SAMPLE_HT) {
    const x = a[ht];
    if (!x) { console.log(`t${ht / 2}: 无样本`); continue; }
    console.log(`t${ht / 2} (n=${x.n}): tiles=${x.tiles.toFixed(1)}  avgDist=${x.avgDist.toFixed(2)}  maxDist=${x.maxDist.toFixed(1)}  perim=${(x.perimRatio * 100).toFixed(1)}%  centroidDist=${x.centroidDist.toFixed(2)}`);
  }
}

const ex = runExpert();
console.log(`expert games: ${ex.games}`);
fmt('EXPERT', agg(ex.samples));
const bot = runBot();
console.log(`bot games: ${bot.games}`);
fmt('BOT', agg(bot.samples));
