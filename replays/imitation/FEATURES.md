# 模仿学习候选步特征定义(24 维)

由 `replays/imitation/extract.js` 生成;下游推理(src/imitation.js)必须按**完全相同**的逻辑实现。

## 数据格式

- `dataset.jsonl`(index.json 前 90% = 422 局)/ `heldout.jsonl`(后 10% = 47 局),每行:
  `{g: 局id, t: 半回合, c: [[24 floats(3位小数)], ...], y: 高手所选候选下标}`
- `t` 取自高手 move 的 `turn` 字段(半回合计数,与 `game.turn` 同刻度)。

## 决策点

重放官方引擎 `replays/Game.js`(协议循环:`moves[mi].turn <= game.turn` 时按序 `handleAttack`,然后 `game.update()`),cap 800 半回合。目标玩家 `me = usernames.indexOf(player)`。**决策点 = 目标玩家在某半回合的第一个 move,快照取在该 move 执行前**(同半回合内其它玩家的更早 move 已执行)。若高手 (start,end) 不在候选集中则丢弃该决策点。

## 迷雾重建(高手视角)

- 可见 = me 拥有格子的 **8 邻域(含自身)**。
- 可见格:`terrain` = 真实 `tileAt`(owner≥0 / -1 空地 / -2 山),`army` = 真实。
- 不可见格:`army = 0`;真实为山或城(`game.cities` 含将军死后变的城)→ `terrain = -4`,否则 `-3`。
- **已知城** = `game.cities` 中**当前可见**的(不做记忆)。
- **已知敌将** = 带记忆:任一决策点上若敌方将军格可见(`game.generals[p] >= 0` 且可见),永久记住该位置;初始未知(-1)。记忆按局维护、逐决策点更新。
- **兵力总量**(f20/f23)用真实全图值(计分板公开信息):myArmy = me 所有格兵力和,allArmy = 所有玩家格兵力和。

## 候选集

所有 (t, n):高手视角 `terrain[t] === me` 且 `army[t] >= 2`,n 为 t 的 4 邻(界内),且 `terrain[n]` 不是 -2(山)也不是 -4(雾中障碍)。可见的城(己方/中立/敌方)都是合法目的地。候选按格子索引扫描顺序排列(t 升序,同 t 内邻居顺序:上、下、左、右)。

若候选数 > 64:保留高手所选 + 用 mulberry32(fnv1a(局id)) 随机取 63 个,**保持原扫描顺序**输出。

## 特征(顺序固定;W/H = 地图宽高,normD = W+H,md = 曼哈顿距离,row=(i/W)|0, col=i%W)

| # | 定义 |
|---|---|
| f1 | `log(1+srcArmy)/5`(自然对数) |
| f2 | src 是我方将军 ? 1 : 0 |
| f3 | `terrain[dest] === me` ? 1 : 0 |
| f4 | `terrain[dest] === -1`(可见空地;含可见中立城,因其 tile 为 -1)? 1 : 0 |
| f5 | `terrain[dest] === -3`(平雾)? 1 : 0 |
| f6 | dest 是敌格(`terrain >= 0 && != me`)? 1 : 0 |
| f7 | `log(1+destArmy)/5`;destArmy = 高手视角 army(可见=真实,雾=0) |
| f8 | dest 是已知城(当前可见的 `game.cities` 成员)? 1 : 0 |
| f9 | `md(src, 我将军) / normD` |
| f10 | dest 到最近**可见敌格**的曼哈顿距离 / normD;无可见敌格 = 1 |
| f11 | dest 是否比 src 更靠近**敌方重心**:+1 更近 / -1 更远 / 0 相等或无敌。敌方重心 = 可见敌格 (row,col) 均值(浮点);距离 = `|row-er|+|col-ec|`(曼哈顿,对浮点重心) |
| f12 | dest 是否比 src 更靠近**已知敌将**(记忆,见上):+1 更近 / -1 更远 / 0 相等;未知 = 0 |
| f13 | `(turn % 50) / 50`(turn = 半回合) |
| f14 | `turn % 50 >= 30` ? 1 : 0 |
| f15 | `min(turn / 400, 1)` |
| f16 | dest 的 4 邻中 terrain 为 -1 或 -3(空地/平雾)的个数 / 4(界外不计) |
| f17 | src 的 4 邻中存在可见敌格 ? 1 : 0 |
| f18 | dest 的 8 邻(不含 dest 自身)中当前**不可见**的格数 / 8(= 走过去能新揭开的雾格) |
| f19 | 若 f6=1:`clip((srcArmy - 1 - destArmy)/50, -1, 1)`;否则 0 |
| f20 | `myArmy / allArmy`(真实总兵力;allArmy=0 时取 0.5) |
| f21 | dest 是否在"我将军 → 敌重心"方向的前半平面:`dot(dest - 我将军, 敌重心 - 我将军) > 0` ? +1 : -1(点积 ≤ 0 为 -1);无可见敌格 = 0。向量用 (row,col) |
| f22 | `destArmy === 1 && terrain[dest] === me` ? 1 : 0 |
| f23 | `clip(srcArmy / myArmy, 0, 1)` |
| f24 | `md(dest, 我将军) / normD` |

所有值四舍五入到 3 位小数。实测全量取值范围 [-1, 1.302],均在 [-2, 2] 内。

## 生成统计(2026-07-27)

- 469/469 局成功处理(corpus 433 + pro 36),0 局跳过。
- 决策点 121,297,保留 121,257,丢弃 40(高手 move 不在候选集,如 srcArmy<2 的失败排队步)。
- dataset.jsonl 106,602 行;heldout.jsonl 14,655 行。最大候选数 64。
