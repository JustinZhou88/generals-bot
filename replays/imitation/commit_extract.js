#!/usr/bin/env node
'use strict';
/*
 * commit_extract.js — "此刻该攒还是该花"的训练数据提取
 *
 * 动机(五次结构性改动全部失败后的结论):bot 缺的不是"主力管理规则",而是**局面评估**。
 * 现在决定何时出击的是一条写死的规则(phase >= 34,即翻倍前 8 个真实回合),
 * 所以任何主力约束都必然在错误的时机生效 —— 加约束(v32)和放宽约束(v34)殊途同归。
 * 这里改为从 1751 局高手语料里学:给定局面,高手接下来会不会发动进攻。
 *
 * 标签(用可观测的结果定义,不靠主观判断):
 *   y = 1  若该玩家在接下来 LOOKAHEAD 个半回合内,从对手手里夺走 >= MIN_CAPS 块地
 *   y = 0  否则
 * 这刻画的正是"进攻窗口",而不是"移动了没有"。
 *
 * 特征全部取自该玩家的**迷雾视角**(与 extract2.js 同一套重建),
 * 保证线上推理时拿得到同样的信息。
 *
 * 输出: commit_train.jsonl / commit_heldout.jsonl,每行 {t, x:[FEAT], y}
 * 用法: node commit_extract.js [--games N]
 */

const fs = require('fs');
const path = require('path');
const Game = require('../Game');

const ROOT = path.join(__dirname, '..');
const CORPUS_DIR = path.join(ROOT, 'corpus');
const TRAIN_OUT = path.join(__dirname, 'commit_train.jsonl');
const HELD_OUT = path.join(__dirname, 'commit_heldout.jsonl');

const CAP = 800;        // 半回合上限
const LOOKAHEAD = 20;   // 前瞻 20 半回合 = 10 真实回合(与用户描述的践踏窗口同尺度)
const MIN_CAPS = 3;     // 夺取 >=3 块敌地才算一次进攻
const SAMPLE_EVERY = 5; // 每 5 个半回合取一个样本(相邻帧高度冗余)
const FEAT = 14;

const FEAT_NAMES = [
  'f1  周期相位 (t%50)/50',
  'f2  对局进度 min(t/800,1)',
  'f3  我方地块占比 my/(my+opp)',
  'f4  我方兵力占比 my/(my+opp)',
  'f5  主力集中度 mainStack/myArmy',
  'f6  主力规模 log(1+mainStack)/5',
  'f7  主力到最近敌格距离 /normD',
  'f8  敌将是否已知 0/1',
  'f9  家门受威胁(敌>=6兵在将军5格内) 0/1',
  'f10 可见敌格占比',
  'f11 我方城数 /5',
  'f12 已知敌方城数 /5',
  'f13 我将军到敌重心距离 /normD',
  'f14 平均每格兵力 myArmy/myLand /10',
];

function clip(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
function r3(x) { return Math.round(x * 1000) / 1000; }
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

/** 从玩家 me 的迷雾视角算一组局面特征 */
function stateFeatures(game, r, me, mem) {
  const W = r.mapWidth, H = r.mapHeight, size = W * H;
  const map = game.map, normD = W + H;
  const myGen = game.generals[me];
  if (myGen === undefined || myGen < 0) return null;

  const visible = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    if (map.tileAt(i) === me) {
      const row = (i / W) | 0, col = i % W;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = row + dr, cc = col + dc;
        if (rr >= 0 && rr < H && cc >= 0 && cc < W) visible[rr * W + cc] = 1;
      }
    }
  }
  // 敌将记忆:见过一次就永久记住(和线上 GameState.knownGenerals 一致)
  for (let p = 0; p < game.generals.length; p++) {
    if (p === me) continue;
    const g = game.generals[p];
    if (g >= 0 && visible[g]) mem.enemyGeneral = g;
  }
  // 已知城记忆
  for (let k = 0; k < game.cities.length; k++) {
    const c = game.cities[k];
    if (visible[c]) mem.knownCities.add(c);
  }

  let myLand = 0, oppLand = 0, myArmy = 0, oppArmy = 0;
  let mainStack = 0, mainTile = -1;
  const enemyTiles = [];
  let er = 0, ec = 0;
  for (let i = 0; i < size; i++) {
    const o = map.tileAt(i);
    if (o === me) {
      myLand++; myArmy += map.armyAt(i);
      if (i !== myGen && map.armyAt(i) > mainStack) { mainStack = map.armyAt(i); mainTile = i; }
    } else if (o >= 0) {
      oppLand++; oppArmy += map.armyAt(i);
      if (visible[i]) { enemyTiles.push(i); er += (i / W) | 0; ec += i % W; }
    }
  }
  const nVis = enemyTiles.length;
  if (nVis) { er /= nVis; ec /= nVis; }

  // 主力到最近可见敌格的曼哈顿距离
  let dMain = normD;
  if (mainTile >= 0 && nVis) {
    const mr = (mainTile / W) | 0, mc = mainTile % W;
    for (const t of enemyTiles) {
      const d = Math.abs(((t / W) | 0) - mr) + Math.abs((t % W) - mc);
      if (d < dMain) dMain = d;
    }
  }
  // 家门威胁:可见敌格中 >=6 兵且距将军 <=5
  let threat = 0;
  const gr = (myGen / W) | 0, gc = myGen % W;
  for (const t of enemyTiles) {
    if (map.armyAt(t) >= 6 && Math.abs(((t / W) | 0) - gr) + Math.abs((t % W) - gc) <= 5) { threat = 1; break; }
  }
  let myCities = 0, oppCities = 0;
  for (const c of mem.knownCities) {
    const o = map.tileAt(c);
    if (o === me) myCities++; else if (o >= 0) oppCities++;
  }
  const dGenEnemy = nVis ? (Math.abs(gr - er) + Math.abs(gc - ec)) : normD;

  return [
    r3((game.turn % 50) / 50),
    r3(clip(game.turn / 800, 0, 1)),
    r3(myLand / Math.max(1, myLand + oppLand)),
    r3(myArmy / Math.max(1, myArmy + oppArmy)),
    r3(mainStack / Math.max(1, myArmy)),
    r3(Math.log(1 + mainStack) / 5),
    r3(dMain / normD),
    mem.enemyGeneral >= 0 ? 1 : 0,
    threat,
    r3(nVis / size),
    r3(clip(myCities / 5, 0, 1)),
    r3(clip(oppCities / 5, 0, 1)),
    r3(dGenEnemy / normD),
    r3(clip(myArmy / Math.max(1, myLand) / 10, 0, 1)),
  ];
}

function processGame(r, outRows) {
  let game;
  try { game = Game.createFromReplay(r); } catch (e) { return 0; }
  const size = r.mapWidth * r.mapHeight;

  // 先整局模拟一遍,记录每个采样点的归属快照 + 特征
  const snaps = [];   // {turn, owner:Int8Array}
  const feats = [];   // {turn, me, x}
  const mems = [{ enemyGeneral: -1, knownCities: new Set() }, { enemyGeneral: -1, knownCities: new Set() }];
  let mi = 0, ai = 0;

  while (!game.isOver() && game.turn < CAP) {
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

    // 特征记忆必须每半回合更新(敌将/已知城是累积的),但只在采样点落样本
    for (let me = 0; me < 2; me++) {
      const x = stateFeatures(game, r, me, mems[me]);
      if (game.turn % SAMPLE_EVERY === 0 && x) feats.push({ turn: game.turn, me, x });
    }
    if (game.turn % SAMPLE_EVERY === 0) {
      const owner = new Int8Array(size);
      for (let i = 0; i < size; i++) owner[i] = game.map.tileAt(i);
      snaps.push({ turn: game.turn, owner });
    }
  }

  // 打标签:未来 LOOKAHEAD 半回合内从对手手里夺走多少块地
  const byTurn = new Map();
  for (const s of snaps) byTurn.set(s.turn, s.owner);
  let n = 0;
  for (const f of feats) {
    const now = byTurn.get(f.turn);
    const fut = byTurn.get(f.turn + LOOKAHEAD);
    if (!now || !fut) continue;
    const opp = 1 - f.me;
    let caps = 0;
    for (let i = 0; i < size; i++) if (now[i] === opp && fut[i] === f.me) caps++;
    outRows.push({ t: f.turn, x: f.x, y: caps >= MIN_CAPS ? 1 : 0 });
    n++;
  }
  return n;
}

function main() {
  const argv = process.argv.slice(2);
  let limit = Infinity;
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--games') limit = parseInt(argv[++i], 10);

  const files = fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'pick.json');
  const trainOut = fs.createWriteStream(TRAIN_OUT);
  const heldOut = fs.createWriteStream(HELD_OUT);
  let games = 0, rows = 0, pos = 0;
  const t0 = Date.now();

  for (const f of files) {
    if (games >= limit) break;
    let r;
    try { r = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, f))); } catch (e) { continue; }
    if (!r.mapWidth || !r.generals || r.generals.length !== 2) continue;
    const buf = [];
    const n = processGame(r, buf);
    if (!n) continue;
    // 按对局 id 划分训练/留出(同一局不能跨集,否则泄漏)
    const held = (hashStr(r.id || f) % 10) === 0;
    const sink = held ? heldOut : trainOut;
    for (const row of buf) { sink.write(JSON.stringify(row) + '\n'); rows++; if (row.y) pos++; }
    games++;
    if (games % 200 === 0) console.log(`  已处理 ${games} 局,${rows} 样本 (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  trainOut.end(); heldOut.end();
  console.log(`\n完成:${games} 局,${rows} 个样本,正例(进攻窗口)占比 ${(pos / rows * 100).toFixed(1)}%`);
  console.log(`标签定义:未来 ${LOOKAHEAD} 半回合(${LOOKAHEAD / 2} 真实回合)内夺取 >= ${MIN_CAPS} 块敌地`);
  console.log(`特征 ${FEAT} 维:`);
  FEAT_NAMES.forEach((s) => console.log('  ' + s));
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (require.main === module) main();
module.exports = { stateFeatures, FEAT, FEAT_NAMES };
