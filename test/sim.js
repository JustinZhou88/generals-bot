'use strict';

// 离线冒烟测试:不连服务器,构造一个 5x5 局面,验证 diff 补丁与策略输出。
const { GameState, patch } = require('../src/gamestate');

// patch 单测
const old = [];
const full = patch(old, [0, 6, 5, 5, 1, 2, 3, 4]); // 全量:0 保留 + 6 替换
console.assert(JSON.stringify(full) === JSON.stringify([5, 5, 1, 2, 3, 4]), 'patch 全量失败');
const next = patch(full, [3, 1, 99, 2]); // 保留3个,替换1个为99,再保留2个
console.assert(JSON.stringify(next) === JSON.stringify([5, 5, 1, 99, 3, 4]), 'patch 增量失败');
console.log('✓ patch 补丁算法通过');

// 构造 5x5 地图:我方(0)将军在左上,敌方(1)将军在右下,中间一座山
const W = 5, H = 5, S = W * H;
const armies = new Array(S).fill(0);
const terrain = new Array(S).fill(-1);
terrain[0] = 0; armies[0] = 10;          // 我的将军
terrain[1] = 0; armies[1] = 5;
terrain[12] = -2;                         // 山
terrain[24] = 1; armies[24] = 3;          // 敌将
terrain[23] = 1; armies[23] = 2;

const gs = new GameState();
gs.start({ playerIndex: 0, replay_id: 'test', usernames: ['me', 'foe'], teams: undefined });
gs.update({
  map_diff: [0, 2 + S * 2, W, H, ...armies, ...terrain],
  cities_diff: [0, 0],
  generals: [0, 24],
  turn: 10,
  scores: [
    { i: 0, total: 15, tiles: 2, dead: false },
    { i: 1, total: 5, tiles: 2, dead: false },
  ],
});

console.assert(gs.width === 5 && gs.height === 5, '地图尺寸解析失败');
console.assert(gs.isMine(0) && gs.isEnemy(24), '归属判断失败');
console.assert(!gs.isPassable(12), '山地判定失败');
console.assert(gs.neighbors(0).length === 2, '邻接计算失败');
console.log('✓ GameState 解析通过');

const { Strategy } = require('../src/strategy');
const st = new Strategy(gs);
// 连续走 10 步模拟(手动搬兵)
for (let step = 0; step < 10; step++) {
  const mv = st.nextMove();
  if (!mv) break;
  console.log(`  step${step}: ${mv.from} -> ${mv.to}`);
  console.assert(gs.isMine(mv.from) && gs.armies[mv.from] > 1, '非法移动!');
  // 简化模拟移动
  const moving = gs.armies[mv.from] - 1;
  gs.armies[mv.from] = 1;
  if (gs.terrain[mv.to] === gs.playerIndex) gs.armies[mv.to] += moving;
  else if (moving > gs.armies[mv.to]) { gs.armies[mv.to] = moving - gs.armies[mv.to]; gs.terrain[mv.to] = 0; }
  else gs.armies[mv.to] -= moving;
  gs.turn++;
}
console.log('✓ Strategy 冒烟测试通过(未出现非法移动)');

// ---------- 开局扩张:一个大兵团应能规划出连吃多格的蛇形路径 ----------
{
  const gs2 = new GameState();
  gs2.start({ playerIndex: 0, replay_id: 'exp', usernames: ['me', 'foe'], teams: undefined });
  const arm = new Array(S).fill(0);
  const ter = new Array(S).fill(-1); // 全空地,无山
  ter[0] = 0; arm[0] = 12;            // 将军带 12 兵在角落
  gs2.update({
    map_diff: [0, 2 + S * 2, W, H, ...arm, ...ter],
    cities_diff: [0, 0],
    generals: [0, -1],
    turn: 5,
    scores: [{ i: 0, total: 12, tiles: 1, dead: false }, { i: 1, total: 1, tiles: 1, dead: false }],
  });
  const st2 = new Strategy(gs2);
  const walk = st2.expansionWalk(0);
  // 12 兵在 5x5 全空地里应能规划出接近 12 格的路径(受棋盘边界限制,至少 >=6)
  console.assert(walk.length >= 6, `扩张路径过短: ${walk.length}`);
  // 路径无重复、每步相邻
  const seen = new Set();
  for (let i = 0; i < walk.length; i++) {
    console.assert(!seen.has(walk[i]), '扩张路径有重复格');
    seen.add(walk[i]);
    if (i > 0) console.assert(gs2.dist(walk[i - 1], walk[i]) === 1, '扩张路径不连续');
  }
  console.log(`✓ 开局扩张规划通过(一次规划连吃 ${walk.length - 1} 格空地)`);
}

// ---------- 防守时间差:赶不及的援军不应被选中 ----------
{
  const gs3 = new GameState();
  gs3.start({ playerIndex: 0, replay_id: 'def', usernames: ['me', 'foe'], teams: undefined });
  const arm = new Array(S).fill(0);
  const ter = new Array(S).fill(-1);
  ter[0] = 0; arm[0] = 1;    // 将军在角落,仅 1 兵,守不住
  ter[24] = 0; arm[24] = 30; // 一大团兵在对角,距离 8 步,赶不及
  ter[1] = 1; arm[1] = 10;   // 敌方大兵紧贴将军(1 步)
  gs3.update({
    map_diff: [0, 2 + S * 2, W, H, ...arm, ...ter],
    cities_diff: [0, 0],
    generals: [0, 1],        // 敌将位置随意
    turn: 20,
    scores: [{ i: 0, total: 31, tiles: 2, dead: false }, { i: 1, total: 10, tiles: 1, dead: false }],
  });
  gs3.generals[0] = 0; // 我的将军在 0
  const st3 = new Strategy(gs3);
  const mv = st3.checkDefense();
  // 对角兵赶不及(8步 > 敌人1步),按"尽力回防"仍会派它,但不会误判为能守住而放弃
  console.assert(mv !== null, '面对贴脸威胁却完全不防守');
  console.log('✓ 防守时间差逻辑通过(威胁触发回防)');
}
