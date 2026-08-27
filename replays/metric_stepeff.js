// 步数效率指标族: 回头率 / 踩1兵地率 / 空转率 / 每真实回合出手数
// 同一把尺子: makeStats + record + finish 逻辑对高手与 bot 完全一致
'use strict';
const path = require('path');
const Game = require(path.join(__dirname, 'Game'));

const OPEN_EXCLUDE = 24; // 排除开局前24个半回合(t=0..23)

function makeStats() {
  return { moves: 0, back: 0, one: 0, movedTurns: new Set(), recent: [], endTurn: 0 };
}

// 在该步执行前调用: t=决策所在半回合(game.turn), from/to, map 为当前地图, p=玩家编号
function record(st, t, from, to, game, p) {
  st.moves++;
  st.movedTurns.add(t);
  if (st.recent.includes(to)) st.back++;
  st.recent.push(from);
  if (st.recent.length > 8) st.recent.shift();
  if (game.map.tileAt(to) === p && game.map.armyAt(to) === 1) st.one++;
}

function finish(st, endTurn) {
  st.endTurn = endTurn;
}

function aggregate(list, label) {
  let moves = 0, back = 0, one = 0, idleNum = 0, idleDen = 0, halfTurns = 0;
  for (const st of list) {
    moves += st.moves;
    back += st.back;
    one += st.one;
    const den = Math.max(0, st.endTurn - OPEN_EXCLUDE); // 决策半回合窗口 [24, endTurn-1]
    let movedInWin = 0;
    for (const t of st.movedTurns) if (t >= OPEN_EXCLUDE) movedInWin++;
    idleDen += den;
    idleNum += den - movedInWin;
    halfTurns += st.endTurn;
  }
  const res = {
    label,
    games: list.length,
    moves,
    backRate: moves ? back / moves : 0,
    oneRate: moves ? one / moves : 0,
    idleRate: idleDen ? idleNum / idleDen : 0,
    movesPerRealTurn: halfTurns ? moves / (halfTurns / 2) : 0,
  };
  console.log(
    `[${label}] games=${res.games} moves=${moves} ` +
    `回头率=${(res.backRate * 100).toFixed(2)}% ` +
    `踩1兵地率=${(res.oneRate * 100).toFixed(2)}% ` +
    `空转率=${(res.idleRate * 100).toFixed(2)}% ` +
    `每真实回合出手数=${res.movesPerRealTurn.toFixed(3)}`
  );
  return res;
}

// ---------- 高手侧 ----------
function runPro() {
  const pick = require(path.join(__dirname, 'pro', 'pick.json'));
  const out = [];
  for (const [name, games] of Object.entries(pick)) {
    for (const g of games) {
      let r;
      try { r = require(path.join(__dirname, 'pro', g.id + '.json')); } catch (e) { continue; }
      const me = r.usernames.indexOf(name);
      if (me < 0) continue;
      const game = Game.createFromReplay(r);
      const st = makeStats();
      let mi = 0;
      while (!game.isOver() && game.turn < 1200) {
        while (r.moves.length > mi && r.moves[mi].turn <= game.turn) {
          const m = r.moves[mi++];
          if (m.index === me) record(st, game.turn, m.start, m.end, game, me);
          game.handleAttack(m.index, m.start, m.end, m.is50);
        }
        game.update();
      }
      finish(st, game.turn);
      out.push(st);
    }
  }
  return out;
}

// ---------- bot 自对弈侧 ----------
function runBot() {
  const { injectView, loadReplays } = require(path.join(__dirname, '..', 'arena'));
  const { GameState } = require(path.join(__dirname, '..', 'src', 'gamestate'));
  const { Strategy } = require(path.join(__dirname, '..', 'src', 'strategy'));
  const maps = loadReplays().slice(0, 12);
  const out = [];
  for (const r of maps) {
    const game = Game.createFromReplay(r);
    const gsA = new GameState();
    gsA.start({ playerIndex: 0, replay_id: 'x', usernames: ['A', 'B'], teams: undefined });
    const gsB = new GameState();
    gsB.start({ playerIndex: 1, replay_id: 'x', usernames: ['A', 'B'], teams: undefined });
    const A = new Strategy(gsA), B = new Strategy(gsB);
    const sts = [makeStats(), makeStats()];
    while (!game.isOver() && game.turn < 700) {
      injectView(gsA, game, 0);
      let a = null; try { a = A.nextMove(); } catch (e) {}
      injectView(gsB, game, 1);
      let b = null; try { b = B.nextMove(); } catch (e) {}
      // 与高手侧同口径: 在执行前(update 前)按当前地图状态判定
      if (a) record(sts[0], game.turn, a.from, a.to, game, 0);
      if (b) record(sts[1], game.turn, b.from, b.to, game, 1);
      if (a) game.inputBuffer[0].push([a.from, a.to, !!a.is50]);
      if (b) game.inputBuffer[1].push([b.from, b.to, !!b.is50]);
      game.update();
    }
    finish(sts[0], game.turn);
    finish(sts[1], game.turn);
    out.push(sts[0], sts[1]);
  }
  return out;
}

const proRes = aggregate(runPro(), 'PRO');
const botRes = aggregate(runBot(), 'BOT');
console.log(JSON.stringify({ pro: proRes, bot: botRes }));
