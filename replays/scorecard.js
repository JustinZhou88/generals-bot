'use strict';

/**
 * 统一"高手画像距离"计分器 —— 37 项指标,两种模式:
 *
 *   node scorecard.js --expert    在 36 局高手语料上算全部 37 项,
 *                                 写 replays/expert_profile.json (mean + std)
 *   node scorecard.js --bot [N]   当前 src/strategy.js 自对弈(Strategy vs Strategy),
 *                                 loadReplays().slice(0,N||10) 双侧、cap 600 半回合,
 *                                 与 expert_profile.json 对比,打表 + "DISTANCE=<数值>"
 *
 * 说明:
 * - t 均为真实回合 = game.turn/2;"接敌" = 双方领土首次 4 邻相邻之后。
 * - strategy.js 的参数 P(k,d) 是运行时读 process.env(见 src/strategy.js:6,
 *   所有 P() 调用都在方法体内),所以 --bot 模式无需清 require.cache,
 *   直接 require 一次即可 —— env 变量在每次 nextMove 时生效。
 * - 只依赖 replays/Game.js(裁判)与 arena.js 的 injectView/loadReplays,不改任何现有文件。
 */

const fs = require('fs');
const path = require('path');
const Game = require('./Game');

const PROFILE_PATH = path.join(__dirname, 'expert_profile.json');
const PRO_DIR = path.join(__dirname, 'pro');

// ---------------- 指标定义(id, 名称, 权重) ----------------
const METRICS = [
  ['m1', 'land@t25', 1],
  ['m2', 'land@t50', 1],
  ['m3', '首动半回合', 1],
  ['m4', '最远触角@t50', 1],
  ['m5', '空转率', 2],
  ['m6', '每回合出手数', 2],
  ['m7', '相位[0-9]占比', 1],
  ['m8', '相位[10-19]占比', 1],
  ['m9', '相位[20-29]占比', 1],
  ['m10', '相位[30-39]占比', 1],
  ['m11', '相位[40-49]占比', 1],
  ['m12', '吃敌格窗口占比', 2],
  ['m13', '接敌后吃敌格/25回合', 2],
  ['m14', '入侵深度', 2],
  ['m15', '斩杀转化率', 1],
  ['m16', '接敌到首吃敌格半回合', 1],
  ['m17', '首城真实回合(中位)', 2],
  ['m18', '持城@t100', 2],
  ['m19', '持城@t150', 2],
  ['m20', '持城@t200', 2],
  ['m21', '最大兵团占比@t50', 1],
  ['m22', '最大兵团占比@t100', 1],
  ['m23', '最大兵团占比@t150', 1],
  ['m24', '前5兵团占比@t100', 1],
  ['m25', '前5兵团占比@t150', 1],
  ['m26', '将军格占比@t100', 1],
  ['m27', '周长比@t50', 1],
  ['m28', '周长比@t100', 1],
  ['m29', '平均触角@t50', 1],
  ['m30', 'land@t100', 1],
  ['m31', '主力距敌格@t75', 1],
  ['m32', '主力距敌格@t125', 1],
  ['m33', '翻倍刻就位率', 1],
  ['m34', '主力活跃度', 1],
  ['m35', '回头率', 1],
  ['m36', '踩己方1兵地率', 1],
  ['m37', 'is50次数/局', 1],
];

// 定时采样的半回合刻(真实回合 * 2)
const TIMED = new Set([50, 100, 150, 200, 250, 300, 400]);

function manh(a, b, W) {
  return Math.abs(((a / W) | 0) - ((b / W) | 0)) + Math.abs((a % W) - (b % W));
}

// ---------------- 单侧记录器:喂采样 + move 事件,finalize 出 37 项 ----------------
class Recorder {
  constructor(replay, p) {
    this.p = p;
    this.opp = 1 - p;
    this.W = replay.mapWidth;
    this.H = replay.mapHeight;
    this.myGen = replay.generals[p];   // 初始将军位(engine 里会被改成 -1,故存快照)
    this.oppGen = replay.generals[this.opp];
    this.moves = [];          // {turn,start,end,is50,preTile,preArmy,captured}
    this.contactScan = null;  // 4 邻扫描出的接敌半回合
    this.firstCityTurn = null;
    this.s = {};              // 定时采样值
    this.dblTicks = 0;
    this.dblReady = 0;
    this.mfPrev = null;
    this.mfSamples = 0;
    this.mfChanged = 0;
  }

  onMove(turn, start, end, is50, preTile, preArmy) {
    const ev = { turn, start, end, is50: !!is50, preTile, preArmy, captured: false };
    this.moves.push(ev);
    return ev;
  }

  // 每半回合调用一次(状态点:该半回合的 move 已/未落地对两种模式各差半拍,统计上可忽略)
  sample(game) {
    const h = game.turn;
    const needTimed = TIMED.has(h);
    const needContact = this.contactScan === null;
    const needCity = this.firstCityTurn === null;
    const needDbl = h > 0 && h % 50 === 0;
    const needMF = h % 2 === 0;
    if (!needTimed && !needContact && !needCity && !needDbl && !needMF) return;

    const map = game.map, size = map.size(), W = this.W, p = this.p, opp = this.opp;
    const own = [];   // [tile, army]
    const oppT = [];
    for (let t = 0; t < size; t++) {
      const v = map.tileAt(t);
      if (v === p) own.push(t);
      else if (v === opp) oppT.push(t);
    }
    if (own.length === 0) return; // 已死(1v1 下随即终局),不再采样

    // 接敌:己方格与敌格 4 邻相邻
    if (needContact && oppT.length) {
      const oppSet = new Set(oppT);
      outer: for (const t of own) {
        const r = (t / W) | 0, c = t % W;
        if (c > 0 && oppSet.has(t - 1)) { this.contactScan = h; break outer; }
        if (c < W - 1 && oppSet.has(t + 1)) { this.contactScan = h; break outer; }
        if (r > 0 && oppSet.has(t - W)) { this.contactScan = h; break outer; }
        if (r < this.H - 1 && oppSet.has(t + W)) { this.contactScan = h; break outer; }
      }
    }

    // 首城(game.cities 含中立城与后来变城的死将格)
    if (needCity) {
      for (const c of game.cities) if (map.tileAt(c) === p) { this.firstCityTurn = h; break; }
    }

    // 主力(兵最多的己方格)
    let mfTile = -1, mfArmy = -1;
    for (const t of own) {
      const a = map.armyAt(t);
      if (a > mfArmy) { mfArmy = a; mfTile = t; }
    }
    const nearestEnemy = () => {
      if (!oppT.length) return NaN;
      let d = Infinity;
      for (const t of oppT) { const dd = manh(mfTile, t, W); if (dd < d) d = dd; }
      return d;
    };

    if (needDbl) {
      const d = nearestEnemy();
      if (Number.isFinite(d)) { this.dblTicks++; if (d <= 3) this.dblReady++; }
    }
    if (needMF) {
      if (this.mfPrev !== null) { this.mfSamples++; if (mfTile !== this.mfPrev) this.mfChanged++; }
      this.mfPrev = mfTile;
    }

    if (!needTimed) return;
    const S = this.s;
    const land = own.length;
    let total = 0;
    const armies = [];
    for (const t of own) { const a = map.armyAt(t); total += a; armies.push(a); }
    armies.sort((a, b) => b - a);
    const conc = total > 0 ? armies[0] / total : NaN;
    const cityCnt = () => { let n = 0; for (const c of game.cities) if (map.tileAt(c) === p) n++; return n; };
    const perim = () => {
      let n = 0;
      const ownSet = new Set(own);
      for (const t of own) {
        const r = (t / W) | 0, c = t % W;
        if ((c > 0 && !ownSet.has(t - 1)) || (c < W - 1 && !ownSet.has(t + 1)) ||
            (r > 0 && !ownSet.has(t - W)) || (r < this.H - 1 && !ownSet.has(t + W))) n++;
      }
      return n / own.length;
    };

    if (h === 50) S.land25 = land;
    if (h === 100) {
      S.land50 = land;
      let mx = 0, sum = 0;
      for (const t of own) { const d = manh(t, this.myGen, W); if (d > mx) mx = d; sum += d; }
      S.reach50 = mx;
      S.avgReach50 = sum / own.length;
      S.perim50 = perim();
      S.conc50 = conc;
    }
    if (h === 150) S.mfDist75 = nearestEnemy();
    if (h === 200) {
      S.land100 = land;
      S.conc100 = conc;
      S.top5_100 = total > 0 ? armies.slice(0, 5).reduce((x, y) => x + y, 0) / total : NaN;
      S.genShare100 = (map.tileAt(this.myGen) === p && total > 0) ? map.armyAt(this.myGen) / total : NaN;
      S.cities100 = cityCnt();
      S.perim100 = perim();
    }
    if (h === 250) S.mfDist125 = nearestEnemy();
    if (h === 300) {
      S.conc150 = conc;
      S.top5_150 = total > 0 ? armies.slice(0, 5).reduce((x, y) => x + y, 0) / total : NaN;
      S.cities150 = cityCnt();
    }
    if (h === 400) S.cities200 = cityCnt();
  }

  finalize(game) {
    const W = this.W, endTurn = game.turn, mv = this.moves, S = this.s;
    const enemyBroken = game.deaths.indexOf(game.sockets[this.opp]) >= 0;
    const M = {};
    const nan = NaN;

    // 开局
    M.m1 = S.land25 !== undefined ? S.land25 : nan;
    M.m2 = S.land50 !== undefined ? S.land50 : nan;
    M.m3 = mv.length ? mv[0].turn : nan;
    M.m4 = S.reach50 !== undefined ? S.reach50 : nan;

    // 节奏
    const denom = endTurn - 24;
    if (denom > 0) {
      const activeTurns = new Set();
      for (const e of mv) if (e.turn >= 24) activeTurns.add(e.turn);
      M.m5 = 1 - activeTurns.size / denom;
    } else M.m5 = nan;
    M.m6 = endTurn > 0 ? mv.length / (endTurn / 2) : nan;
    const buckets = [0, 0, 0, 0, 0];
    for (const e of mv) buckets[Math.min(4, ((e.turn % 50) / 10) | 0)]++;
    for (let i = 0; i < 5; i++) M['m' + (7 + i)] = mv.length ? buckets[i] / mv.length : nan;
    const enemyMoves = mv.filter((e) => e.preTile === this.opp);
    M.m12 = enemyMoves.length ? enemyMoves.filter((e) => e.turn % 50 >= 30).length / enemyMoves.length : nan;

    // 攻击
    const captures = enemyMoves.filter((e) => e.captured);
    let contact = this.contactScan;
    if (enemyMoves.length) {
      const t0 = enemyMoves[0].turn;
      if (contact === null || t0 < contact) contact = t0;
    }
    if (contact !== null && endTurn > contact) {
      const after = captures.filter((e) => e.turn >= contact).length;
      M.m13 = after / ((endTurn - contact) / 50);
    } else M.m13 = nan;
    M.m14 = captures.length
      ? captures.reduce((x, e) => x + manh(e.end, this.oppGen, W), 0) / captures.length
      : nan;
    const killTry = mv.some((e) => manh(e.end, this.oppGen, W) <= 2);
    M.m15 = killTry ? (enemyBroken ? 1 : 0) : nan;
    M.m16 = (contact !== null && captures.length)
      ? Math.max(0, captures[0].turn - contact)
      : nan;

    // 城市
    M.m17 = this.firstCityTurn !== null ? this.firstCityTurn / 2 : nan;
    M.m18 = S.cities100 !== undefined ? S.cities100 : nan;
    M.m19 = S.cities150 !== undefined ? S.cities150 : nan;
    M.m20 = S.cities200 !== undefined ? S.cities200 : nan;

    // 集中度
    M.m21 = S.conc50 !== undefined ? S.conc50 : nan;
    M.m22 = S.conc100 !== undefined ? S.conc100 : nan;
    M.m23 = S.conc150 !== undefined ? S.conc150 : nan;
    M.m24 = S.top5_100 !== undefined ? S.top5_100 : nan;
    M.m25 = S.top5_150 !== undefined ? S.top5_150 : nan;
    M.m26 = S.genShare100 !== undefined ? S.genShare100 : nan;

    // 领土
    M.m27 = S.perim50 !== undefined ? S.perim50 : nan;
    M.m28 = S.perim100 !== undefined ? S.perim100 : nan;
    M.m29 = S.avgReach50 !== undefined ? S.avgReach50 : nan;
    M.m30 = S.land100 !== undefined ? S.land100 : nan;

    // 主力
    M.m31 = S.mfDist75 !== undefined ? S.mfDist75 : nan;
    M.m32 = S.mfDist125 !== undefined ? S.mfDist125 : nan;
    M.m33 = this.dblTicks ? this.dblReady / this.dblTicks : nan;
    M.m34 = this.mfSamples ? this.mfChanged / this.mfSamples : nan;

    // 微操
    if (mv.length) {
      const recent = [];
      let back = 0, own1 = 0, is50n = 0;
      for (const e of mv) {
        if (recent.indexOf(e.end) >= 0) back++;
        recent.push(e.start);
        if (recent.length > 8) recent.shift();
        if (e.preTile === this.p && e.preArmy === 1) own1++;
        if (e.is50) is50n++;
      }
      M.m35 = back / mv.length;
      M.m36 = own1 / mv.length;
      M.m37 = is50n;
    } else { M.m35 = nan; M.m36 = nan; M.m37 = 0; }

    return M;
  }
}

// ---------------- 高手模式:官方引擎逐半回合重放 ----------------
function simulateExpert(r, me, cap) {
  const game = Game.createFromReplay(r);
  const rec = new Recorder(r, me);
  let mi = 0;
  while (!game.isOver() && game.turn < cap) {
    while (r.moves.length > mi && r.moves[mi].turn <= game.turn) {
      const m = r.moves[mi++];
      if (m.index === me) {
        const preTile = game.map.tileAt(m.end);
        const preArmy = game.map.armyAt(m.end);
        const ev = rec.onMove(m.turn, m.start, m.end, m.is50, preTile, preArmy);
        game.handleAttack(m.index, m.start, m.end, m.is50);
        if (preTile === rec.opp && game.map.tileAt(m.end) === me) ev.captured = true;
      } else {
        game.handleAttack(m.index, m.start, m.end, m.is50);
      }
    }
    rec.sample(game);
    game.update();
  }
  return rec.finalize(game);
}

function runExpert() {
  const pick = JSON.parse(fs.readFileSync(path.join(PRO_DIR, 'pick.json')));
  const rows = [];
  let games = 0;
  for (const [player, list] of Object.entries(pick)) {
    for (const g of list) {
      const r = JSON.parse(fs.readFileSync(path.join(PRO_DIR, g.id + '.json')));
      const me = r.usernames.indexOf(player);
      if (me < 0) continue;
      rows.push(simulateExpert(r, me, 2000));
      games++;
    }
  }
  const profile = { generatedAt: new Date().toISOString(), games, metrics: {} };
  for (const [id, name] of METRICS) {
    const vals = rows.map((row) => row[id]).filter((v) => Number.isFinite(v));
    const agg = { name, n: vals.length, mean: NaN, std: NaN };
    if (vals.length) {
      if (id === 'm17') {
        const s = vals.slice().sort((a, b) => a - b);
        const mid = s.length >> 1;
        agg.mean = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2; // 按定义取中位数
      } else {
        agg.mean = vals.reduce((x, y) => x + y, 0) / vals.length;
      }
      if (vals.length > 1) {
        const mu = vals.reduce((x, y) => x + y, 0) / vals.length;
        agg.std = Math.sqrt(vals.reduce((x, y) => x + (y - mu) * (y - mu), 0) / (vals.length - 1));
      }
    }
    profile.metrics[id] = agg;
  }
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2));
  console.log(`高手画像已写入 ${PROFILE_PATH}(${games} 局样本)\n`);
  for (const [id, name] of METRICS) {
    const m = profile.metrics[id];
    console.log(`${id.padEnd(4)} ${name.padEnd(16)} mean=${fmt(m.mean)}  std=${fmt(m.std)}  n=${m.n}`);
  }
  // 自检锚点
  console.log('\n[自检] 空转率 m5 ≈0.30 →', fmt(profile.metrics.m5.mean));
  console.log('[自检] 吃敌格窗口 m12 ≈0.62 →', fmt(profile.metrics.m12.mean));
  console.log('[自检] 首城中位 m17 ≈89.5 →', fmt(profile.metrics.m17.mean));
  console.log('[自检] 持城@t200 m20 ≈2.67 →', fmt(profile.metrics.m20.mean));
}

// ---------------- bot 模式:Strategy 自对弈,双侧采样 ----------------
function runBot(nMaps) {
  // strategy.js 的 P() 运行时读 env,普通 require 即可(无需清缓存)
  const { injectView, loadReplays } = require('../arena');
  const { GameState } = require('../src/gamestate');
  const { Strategy } = require('../src/strategy');

  const replays = loadReplays().slice(0, nMaps);
  const CAP = 600;
  const rows = [];
  for (const r of replays) {
    const game = Game.createFromReplay(r);
    const gsA = new GameState(), gsB = new GameState();
    gsA.start({ playerIndex: 0, replay_id: 'x', usernames: ['A', 'B'], teams: undefined });
    gsB.start({ playerIndex: 1, replay_id: 'x', usernames: ['A', 'B'], teams: undefined });
    const bots = [new Strategy(gsA), new Strategy(gsB)];
    const gss = [gsA, gsB];
    const recs = [new Recorder(r, 0), new Recorder(r, 1)];
    while (!game.isOver() && game.turn < CAP) {
      recs[0].sample(game);
      recs[1].sample(game);
      const pend = [];
      for (let p = 0; p < 2; p++) {
        injectView(gss[p], game, p);
        let mv = null;
        try { mv = bots[p].nextMove(); } catch (e) { mv = null; }
        if (mv && Number.isInteger(mv.from) && Number.isInteger(mv.to)) {
          const preTile = game.map.tileAt(mv.to);
          const preArmy = game.map.armyAt(mv.to);
          const ev = recs[p].onMove(game.turn, mv.from, mv.to, mv.is50, preTile, preArmy);
          pend.push([p, ev]);
          game.inputBuffer[p].push([mv.from, mv.to, !!mv.is50]);
        }
      }
      game.update();
      for (const [p, ev] of pend) {
        if (ev.preTile === 1 - p && game.map.tileAt(ev.end) === p) ev.captured = true;
      }
    }
    rows.push(recs[0].finalize(game), recs[1].finalize(game));
  }

  if (!fs.existsSync(PROFILE_PATH)) {
    console.error('缺少 expert_profile.json,先跑 node scorecard.js --expert');
    process.exit(1);
  }
  const profile = JSON.parse(fs.readFileSync(PROFILE_PATH));

  // bot 侧聚合(m17 同样取中位数)
  const botAgg = {};
  for (const [id] of METRICS) {
    const vals = rows.map((row) => row[id]).filter((v) => Number.isFinite(v));
    if (!vals.length) { botAgg[id] = NaN; continue; }
    if (id === 'm17') {
      const s = vals.slice().sort((a, b) => a - b);
      const mid = s.length >> 1;
      botAgg[id] = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    } else {
      botAgg[id] = vals.reduce((x, y) => x + y, 0) / vals.length;
    }
  }

  console.log(`bot 自对弈 ${replays.length} 图 x 双侧 = ${rows.length} 侧样本,cap ${CAP} 半回合\n`);
  console.log('指标   名称                 expert      bot        dev   w');
  console.log('-----------------------------------------------------------------');
  let sumW = 0, sumWD = 0;
  const devs = [];
  for (const [id, name, w] of METRICS) {
    const em = profile.metrics[id] ? profile.metrics[id].mean : NaN;
    const bm = botAgg[id];
    if (!Number.isFinite(em)) continue; // expert 无该项,跳过
    let dev;
    if (!Number.isFinite(bm)) dev = 2.0; // bot 缺失该行为,按上限罚
    else dev = Math.min(2.0, Math.abs(bm - em) / Math.max(Math.abs(em), 0.01));
    sumW += w; sumWD += w * dev;
    devs.push({ id, name, em, bm, dev, w });
    console.log(
      `${id.padEnd(5)} ${name.padEnd(18)} ${fmt(em).padStart(9)} ${fmt(bm).padStart(9)} ` +
      `${dev.toFixed(3).padStart(7)}  ${w}`
    );
  }
  const D = sumWD / sumW;
  console.log('-----------------------------------------------------------------');
  const worst = devs.slice().sort((a, b) => b.dev - a.dev).slice(0, 5);
  console.log('偏差最大 5 项: ' + worst.map((x) => `${x.id}(${x.dev.toFixed(2)})`).join(' '));
  console.log(`总距离 D(加权平均) = ${D.toFixed(4)}`);
  console.log(`DISTANCE=${D.toFixed(4)}`);
}

function fmt(v) {
  if (!Number.isFinite(v)) return 'NaN';
  return Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3);
}

// ---------------- CLI ----------------
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--expert')) return runExpert();
  const bi = argv.indexOf('--bot');
  if (bi >= 0) {
    const n = parseInt(argv[bi + 1], 10);
    return runBot(Number.isFinite(n) && n > 0 ? n : 10);
  }
  console.log('用法: node scorecard.js --expert | --bot [N]');
}

if (require.main === module) main();

module.exports = { Recorder, simulateExpert, METRICS };
