'use strict';
/*
 * ffa_report.js — FFA 对局统计,**只采信 2 人局**
 *
 * 用户的判断:bot 服务器的 FFA 里只有实际参与人数 == 2 的局才等价于 1v1,
 * 3 人以上当娱乐局,数据不可参考。这里按参与人数过滤后再统计。
 *
 * 同时报告那个已被证明是胜负唯一判别变量的指标:有没有(以及多早)找到敌将。
 * 参考:与用户的 6 局实战里,唯一赢的那局 ht170 找到敌将,输的 5 局基本没找到。
 *
 * 用法: node ffa_report.js [protodump_ffa]
 */
const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || 'protodump_ffa';
if (!fs.existsSync(dir)) { console.log(`目录 ${dir} 不存在(还没打过局)`); process.exit(0); }

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
if (!files.length) { console.log('还没有录到对局'); process.exit(0); }

const rows = [];
for (const f of files) {
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => l.length > 1);
  if (lines.length < 3) continue;
  let meta;
  try { meta = JSON.parse(lines[0]); } catch (e) { continue; }
  const frames = lines.slice(1).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  if (!frames.length) continue;
  const me = meta.playerIndex;
  const nPlayers = (meta.usernames || []).length;
  const last = frames[frames.length - 1];
  const myScore = last.scores.find((s) => s.i === me);
  // 存活的其他玩家
  const others = last.scores.filter((s) => s.i !== me);
  const aliveOthers = others.filter((s) => s.tiles > 0 && !s.dead).length;
  const won = myScore && myScore.tiles > 0 && aliveOthers === 0;
  const died = !myScore || myScore.tiles === 0 || myScore.dead;

  // 首次看到任一敌将
  let foundTurn = -1;
  for (const fr of frames) {
    if (fr.generals.some((g, i) => i !== me && g >= 0)) { foundTurn = fr.turn; break; }
  }
  rows.push({
    id: meta.replayId, nPlayers, won, died, turns: last.turn,
    foundTurn, myTiles: myScore ? myScore.tiles : 0,
    opp: (meta.usernames || []).filter((_, i) => i !== me).join(', '),
  });
}

const duel = rows.filter((r) => r.nPlayers === 2);
const party = rows.filter((r) => r.nPlayers > 2);

console.log(`录到 ${rows.length} 局:  2 人局 ${duel.length} 局(可参考)  /  3 人以上 ${party.length} 局(娱乐局,不计)\n`);

if (duel.length) {
  const w = duel.filter((r) => r.won).length;
  const found = duel.filter((r) => r.foundTurn >= 0 && r.foundTurn < r.turns - 5).length;
  console.log(`【2 人局】战绩 ${w} 胜 ${duel.length - w} 负   胜率 ${(w / duel.length * 100).toFixed(1)}%`);
  console.log(`  真正找到过敌将(排除死亡瞬间揭示): ${found}/${duel.length} = ${(found / duel.length * 100).toFixed(1)}%`);
  console.log(`\n  回放          结果  对手                     找将      总长`);
  for (const r of duel) {
    const realFound = r.foundTurn >= 0 && r.foundTurn < r.turns - 5;
    console.log(`  ${r.id.padEnd(12)} ${(r.won ? '胜' : '负').padEnd(4)} ${(r.opp || '?').slice(0, 22).padEnd(24)} ` +
      `${(realFound ? 'ht' + r.foundTurn : '从未').padEnd(9)} ${r.turns}`);
  }
} else {
  console.log('还没有 2 人局。FFA 通常要等人少的时段才凑得出 1v1。');
}

if (party.length) {
  const w = party.filter((r) => r.won).length;
  console.log(`\n【3 人以上,仅供参考】${party.length} 局,赢 ${w} 局,平均人数 ${(party.reduce((a, b) => a + b.nPlayers, 0) / party.length).toFixed(1)}`);
}
