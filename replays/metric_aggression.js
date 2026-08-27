'use strict';
// 指标族:攻击性 —— 同一把尺子分别量高手语料与 bot 自对弈
// 1) 接敌后每25回合周期吃敌格次数
// 2) 吃敌格发生在翻倍前10回合窗口(game.turn%50>=30)的占比
// 3) 入侵深度:吃敌格时该格到对手将军的曼哈顿距离均值
// 4) 斩杀转化:首次己方move落点进入敌将2格内 -> 敌将被破 的转化率与平均耗时(半回合)

const fs = require('fs');
const path = require('path');
const Game = require('./Game');
const { injectView, loadReplays } = require('../arena');
const { GameState } = require('../src/gamestate');
const { Strategy } = require('../src/strategy');

// ---------- 共用测量核心 ----------
// game: 官方引擎实例(未走过任何回合)
// players: 要测量的玩家编号数组(高手局只测 me;bot 自对弈测 [0,1])
// cap: 半回合上限
// driver(t): 在 game.update() 之前被调用,负责注入该半回合的移动
//            (高手局直接 handleAttack;bot 局跑 nextMove 并 push inputBuffer)
function measure(game, players, cap, driver) {
  const W = game.map.width, H = game.map.height, size = W * H;
  const gen0 = game.generals.slice(); // 开局将军位置(死后 generals 会变 -1,先存)
  const manh = (a, b) => Math.abs(((a / W) | 0) - ((b / W) | 0)) + Math.abs((a % W) - (b % W));

  const stats = players.map((p) => ({
    p, opp: 1 - p,
    caps: [],          // {turn, dist} 每次吃敌格
    threatTurn: -1,    // 首次 move 落点进入敌将2格内
    killTurn: -1,      // 敌将被破
  }));

  // 包一层 handleAttack,记录“成功执行”的移动(两种模式统一走这里)
  const orig = game.handleAttack.bind(game);
  let okMoves = [];
  game.handleAttack = function (i, s, e, is50, ai) {
    const res = orig(i, s, e, is50, ai);
    if (res !== false) okMoves.push({ i, e });
    return res;
  };

  const prev = new Int16Array(size);
  for (let t = 0; t < size; t++) prev[t] = game.map.tileAt(t);

  let contactTurn = -1;

  while (!game.isOver() && game.turn < cap) {
    okMoves = [];
    const t = game.turn; // 该半回合编号(移动执行时的 turn)
    driver(t);
    game.update();

    // 斩杀威胁:己方成功移动的落点进入敌将2格内
    for (const st of stats) {
      if (st.threatTurn < 0 && gen0[st.opp] >= 0) {
        for (const m of okMoves) {
          if (m.i === st.p && manh(m.e, gen0[st.opp]) <= 2) { st.threatTurn = t; break; }
        }
      }
    }

    // 吃敌格:归属从 opp 变成 p
    for (let x = 0; x < size; x++) {
      const now = game.map.tileAt(x);
      if (now !== prev[x]) {
        for (const st of stats) {
          if (prev[x] === st.opp && now === st.p) st.caps.push({ turn: t, dist: manh(x, gen0[st.opp]) });
        }
        prev[x] = now;
      }
    }

    // 接敌检测(4邻接,双方对称,只找一次)
    if (contactTurn < 0) {
      outer: for (let x = 0; x < size; x++) {
        const o = game.map.tileAt(x);
        if (o < 0) continue;
        const cc = x % W, rr = (x / W) | 0;
        if (cc + 1 < W) { const o2 = game.map.tileAt(x + 1); if (o2 >= 0 && o2 !== o) { contactTurn = t; break outer; } }
        if (rr + 1 < H) { const o2 = game.map.tileAt(x + W); if (o2 >= 0 && o2 !== o) { contactTurn = t; break outer; } }
      }
    }

    // 敌将被破
    for (const st of stats) {
      if (st.killTurn < 0 && game.deaths.indexOf(game.sockets[st.opp]) >= 0) st.killTurn = t;
    }
  }

  const endTurn = game.turn;
  return stats.map((st) => ({
    p: st.p,
    contactTurn,
    endTurn,
    caps: st.caps,
    threatTurn: st.threatTurn,
    killTurn: st.killTurn,
  }));
}

// ---------- 汇总 ----------
function aggregate(samples) {
  // samples: 每个 = measure 返回的单玩家结果
  let capsAfter = 0, cycles = 0, winCaps = 0, distSum = 0, distN = 0;
  let threatGames = 0, kills = 0, killDurSum = 0;
  const perGameRates = [];
  for (const s of samples) {
    if (s.contactTurn >= 0 && s.endTurn > s.contactTurn) {
      const c = (s.endTurn - s.contactTurn) / 50; // 50半回合 = 25真实回合
      const n = s.caps.filter((x) => x.turn >= s.contactTurn).length;
      capsAfter += n; cycles += c;
      perGameRates.push(n / c);
    }
    for (const x of s.caps) {
      distSum += x.dist; distN++;
      if (x.turn % 50 >= 30) winCaps++;
    }
    if (s.threatTurn >= 0) {
      threatGames++;
      if (s.killTurn >= 0 && s.killTurn >= s.threatTurn) {
        kills++; killDurSum += s.killTurn - s.threatTurn;
      }
    }
  }
  return {
    games: samples.length,
    capsPerCycle: cycles > 0 ? capsAfter / cycles : NaN,          // 指标1(池化)
    capsPerCycleMean: perGameRates.length ? perGameRates.reduce((a, b) => a + b, 0) / perGameRates.length : NaN,
    windowShare: distN > 0 ? winCaps / distN : NaN,               // 指标2
    meanDist: distN > 0 ? distSum / distN : NaN,                  // 指标3
    totalCaps: distN,
    threatGames, kills,
    killRate: threatGames > 0 ? kills / threatGames : NaN,        // 指标4
    killDur: kills > 0 ? killDurSum / kills : NaN,
  };
}

// ---------- 高手语料 ----------
function runExpert() {
  const proDir = path.join(__dirname, 'pro');
  const pick = JSON.parse(fs.readFileSync(path.join(proDir, 'pick.json')));
  const samples = [];
  for (const player of Object.keys(pick)) {
    for (const g of pick[player]) {
      const r = JSON.parse(fs.readFileSync(path.join(proDir, g.id + '.json')));
      const me = r.usernames.indexOf(player);
      if (me < 0 || r.generals.length !== 2) continue;
      const game = Game.createFromReplay(r);
      let mi = 0;
      const res = measure(game, [me], 1200, () => {
        while (r.moves.length > mi && r.moves[mi].turn <= game.turn) {
          const m = r.moves[mi++];
          game.handleAttack(m.index, m.start, m.end, m.is50);
        }
      });
      samples.push(res[0]);
    }
  }
  return samples;
}

// ---------- bot 自对弈 ----------
function runBot() {
  const replays = loadReplays().slice(0, 12);
  const samples = [];
  for (const r of replays) {
    const game = Game.createFromReplay(r);
    const gsA = new GameState(); gsA.start({ playerIndex: 0, replay_id: 'x', usernames: ['A', 'B'], teams: undefined });
    const gsB = new GameState(); gsB.start({ playerIndex: 1, replay_id: 'x', usernames: ['A', 'B'], teams: undefined });
    const A = new Strategy(gsA), B = new Strategy(gsB);
    const res = measure(game, [0, 1], 700, () => {
      injectView(gsA, game, 0);
      let a = null; try { a = A.nextMove(); } catch (e) {}
      injectView(gsB, game, 1);
      let b = null; try { b = B.nextMove(); } catch (e) {}
      if (a) game.inputBuffer[0].push([a.from, a.to, !!a.is50]);
      if (b) game.inputBuffer[1].push([b.from, b.to, !!b.is50]);
    });
    samples.push(...res);
  }
  return samples;
}

// ---------- 主程序 ----------
function fmt(x, d) { return Number.isFinite(x) ? x.toFixed(d) : '-'; }

function report(tag, agg) {
  console.log(`\n===== ${tag} (${agg.games} 个玩家样本) =====`);
  console.log(`1) 接敌后每25回合周期吃敌格: ${fmt(agg.capsPerCycle, 2)} 次/周期 (逐局均值 ${fmt(agg.capsPerCycleMean, 2)})`);
  console.log(`2) 翻倍前10回合窗口占比: ${fmt(agg.windowShare * 100, 1)}%  (总吃敌格 ${agg.totalCaps})`);
  console.log(`3) 入侵深度(到敌将曼哈顿距离均值): ${fmt(agg.meanDist, 2)} 格`);
  console.log(`4) 斩杀转化: 威胁局 ${agg.threatGames}, 转化 ${agg.kills}, 转化率 ${fmt(agg.killRate * 100, 1)}%, 平均耗时 ${fmt(agg.killDur, 1)} 半回合`);
}

const expertSamples = runExpert();
const expertAgg = aggregate(expertSamples);
report('高手语料', expertAgg);

const botSamples = runBot();
const botAgg = aggregate(botSamples);
report('bot 自对弈 (v21)', botAgg);

console.log('\nJSON:', JSON.stringify({ expert: expertAgg, bot: botAgg }));
