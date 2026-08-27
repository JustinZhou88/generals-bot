'use strict';
/*
 * dump_status.js — 汇总实战录制目录:有效样本(2 人局)数、胜负、对手。
 *
 * 只有 2 人局算有效样本 —— 多人 FFA 与 1v1 不可比,cap_audit.js 也是按
 * usernames.length === 2 过滤的,这里用同一口径,免得看着攒了很多其实不算数。
 *
 * 用法: node dump_status.js protodump_v51_ffa
 */

const fs = require('fs');
const path = require('path');
const LZString = require('lz-string');
const Game = require('./replays/Game');

const DIR = process.argv[2];
if (!DIR) { console.log('用法: node dump_status.js <dump目录>'); process.exit(1); }

function deserialize(buf) {
  const obj = JSON.parse(LZString.decompressFromUint8Array(new Uint8Array(buf)));
  let i = 0; const r = {};
  for (const k of ['version','id','mapWidth','mapHeight','usernames','stars','cities','cityArmies','generals','mountains']) r[k] = obj[i++];
  r.moves = obj[i++].map((s) => ({ index: s[0], start: s[1], end: s[2], is50: s[3], turn: s[4] }));
  r.afks = obj[i++].map((s) => ({ index: s[0], turn: s[1] }));
  r.teams = obj[i++]; r.map_title = obj[i++];
  return r;
}

const ME = process.env.GIO_ME || '[Bot] syndrome_bot';
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.gior'));
let valid = 0, win = 0, loss = 0, multi = 0, bad = 0;
const rows = [];

for (const f of files) {
  let r;
  try { r = deserialize(fs.readFileSync(path.join(DIR, f))); } catch (e) { bad++; continue; }
  if (!r.usernames) { bad++; continue; }
  if (r.usernames.length !== 2) { multi++; continue; }
  const me = r.usernames.indexOf(ME);
  if (me < 0) { bad++; continue; }
  const opp = 1 - me;

  let game;
  try { game = Game.createFromReplay(r); } catch (e) { bad++; continue; }
  let mi = 0, ai = 0;
  while (!game.isOver() && game.turn < 3000) {
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
  }
  const iLost = game.deaths.indexOf(game.sockets[me]) >= 0;
  valid++; if (iLost) loss++; else win++;
  const oppIsBot = /^\[Bot\]/.test(r.usernames[opp]);
  // 弃权局:对手挂机/早退。实测机器服上很常见(有一局对手 0 步就 AFK),
  // 这种局不含任何策略信息,算进胜率会给出假信号 —— 单独列出、不计入有效胜率。
  const oppMoves = r.moves.filter((m) => m.index === opp).length;
  const oppAfk = r.afks.find((a) => a.index === opp);
  const forfeit = oppMoves < 20 || (oppAfk && oppAfk.turn < 100);
  // 最关键的一栏:这局到底是不是**打完**的。
  // 对手有 afk 记录 = 他中途退了(不管是 0 步挂机还是落后了投降),
  // 我们并没有真的斩下他的将军 —— 这种"胜"不能证明 v51 能收官。
  // afks 为空 = 双方打到分出胜负,只有这种局对强弱判断有效。
  const decided = !oppAfk;
  // 主服务器的回放里 stars 可能整个是 null(未定级/匿名),不能直接下标
  rows.push({ id: r.id, opp: r.usernames[opp], stars: (r.stars && r.stars[opp]) || 0, bot: oppIsBot,
    res: iLost ? '负' : '胜', turn: Math.floor(game.turn / 2), oppMoves, forfeit, decided });
}

rows.sort((a, b) => a.id.localeCompare(b.id));
console.log(`目录 ${DIR}:  .gior ${files.length} 个`);
console.log(`有效样本(2 人局) ${valid} 局 —— ${win} 胜 ${loss} 负` +
  (valid ? `,胜率 ${(win / valid * 100).toFixed(1)}%` : ''));
if (multi) console.log(`多人局 ${multi} 局(不计入)`);
if (bad) console.log(`无法解析/非本账号 ${bad} 个`);
const dec = rows.filter((r) => r.decided);
const quit = rows.filter((r) => !r.decided);
const wr = (a) => a.length ? `${a.filter((x) => x.res === '胜').length}/${a.length}` : '-';
console.log(`  其中对手中途退出 ${quit.length} 局(含 ${rows.filter((r) => r.forfeit).length} 局挂机/秒退)`);
console.log(`\n★★ 真正打完分出胜负的 ${dec.length} 局 —— ${wr(dec)}` +
  (dec.length ? `,胜率 ${(dec.filter((x) => x.res === '胜').length / dec.length * 100).toFixed(1)}%` : ''));
console.log(`   对 [Bot] 前缀对手 ${wr(dec.filter((r) => r.bot))}    对无前缀对手 ${wr(dec.filter((r) => !r.bot))}`);
if (rows.length) {
  console.log('\n  回放ID       结果  回合  对手走子  结束方式      对手(星)');
  for (const r of rows) {
    const how = r.decided ? '打完(斩首)  ' : (r.forfeit ? '对手挂机/秒退' : '对手中途投降');
    console.log(`  ${r.id.padEnd(12)} ${r.res}   ${String(r.turn).padStart(4)}   ${String(r.oppMoves).padStart(5)}   ${how}  ` +
      `${r.opp}${r.bot ? '' : ` (${r.stars}★)`}`);
  }
}
