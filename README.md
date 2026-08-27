# generals-io-bot (高性能竞技级 Generals.io AI 机器人)

面向 [generals.io](https://generals.io) 的全自动、高性能策略对战机器人与研究框架。  
本项目经历了 **57+ 个版本的代际演进与实验调优**，融合了：
- **分层规则引擎与保护闩机制**（防守、斩首、早期节拍抢地、防撞塔保护、聚兵树）
- **动态自适应侦察与贝叶斯推断**（针对 Bot 与真人玩家切换侦察策略，敌将后验信念建模）
- **高手语料模仿学习混合体**（精选高分专家子集训练轻量 MLP 动作排序器，指引发育行军）
- **全自动天梯挂机与监控系统**（基于 Playwright Headless 驱动真实浏览器自动排位与状态快照）
- **逐帧一致性模拟器与多维审计评测工具链**（离线对齐官方引擎、多维度对局缺陷审计、分星级置信胜率评估）

---

## 🌟 核心特性与架构

### 1. 分层决策策略 (Hierarchical Strategy Engine)
每半回合（约 0.5s）按严格优先级执行单步决策：
1. **生死防守反打 (Defend & Counter)**：实时监测将军威胁半径与敌军主力动向，必要时集结重兵沿最小代价路径回防。
2. **绝杀斩首 (Sniper / Decapitation)**：一旦定位敌将，精确测算攻坚所需兵力（`驻军 + 距离 + 容错余量`），兵力充足立即总攻突刺；不足则沿出击轴线预先聚兵。
3. **开局扩张与黄金节拍 (Opening Expansion)**：前 50 个半回合全力抢占外围空地（每 25 回合经济产兵周期对齐）；后续优先利用高兵地块形成“蛇形连吃”。
4. **守得住才打的攻城机制 (City Siege & Safety Clamp)**：只有在不弱于全局最强对手且判定该城“离我方将军更近、守得住”时才开火。内置 `CITY_NOBOUNCE` 机制，杜绝兵力不足时穿城行军撞塔送兵。
5. **边际正收益蚕食 (Nibble)**：前线局部兵力占优时吃掉能稳赢的相邻敌格，贪心最大净增收益。
6. **低成本树状聚兵 (Gathering Tree)**：以后方散兵为叶子、前线推进点为根，沿己方低代价地块反向收编兵力推向前线。

### 2. 动态侦察与敌将推断 (Belief & Adaptive Scouting)
- **对手类型自适应 (v51 突破)**：
  - **面对 [Bot] 机器人对手**：启用侦察投影封顶（`projCap`），沿敌方领地边缘寻找前沿，避免盲目穿透。
  - **面对真人玩家对手**：真人通常偏好深潜龟缩，自动切换为“瞄准先验深度定向扫描”（对齐真实语料双将平均距离分布），突破真人反侦察盲区。
- **空间信念网络 (`belief.js`)**：结合迷雾地形、已发现城市与障碍、敌兵出现首个坐标，实时更新敌将可能坐标的概率分布。

### 3. 模仿学习混合体 (Imitation Learning Hybrid)
- **专家数据精炼**：实验证明盲目扩充语料会导致不同风格相互稀释反而降低实战胜率；本项目从数百局高分语料库中筛选出**精英玩家（Elite Subsets）**子集重训。
- **特征工程与 MLP 排序器**：提取 24 维棋盘与移动特征（见 `replays/imitation/FEATURES.md`），训练紧凑型模型（`model*.json` / `commit_model.json`）。
- **规则 + 学习混合架构**：关键生死点（斩首、防守、攻城、开局节奏）由硬性规则掌控，发育行军与日常调度交由模仿模型排序打分，实现高灵巧性与高下限的统一。

### 4. 自动化天梯巡航 (Playwright Headless Bot)
- 脚本 `headless_bot.js` 通过 Playwright-core 驱动无头 Chrome，自动连接官方对局，支持：
  - 自动进入 1v1 / FFA 排位队列；
  - 对局事件与胜负结果自动落盘（`match_history.log`）；
  - 实时战局截屏渲染（`current_status.png`），便于随时远程监控对战状态。

### 5. 逐帧一致性模拟器与审计套件 (Audit & Benchmark Suite)
- **逐帧一致性离线验证 (`conformance.js`)**：与官方服务器真实对局数据对比，5100+ 帧逐格移动与状态完全一致。
- **真实随机地图生成器 (`mapgen.js`)**：参数严格校准于 1804 局真实官方对战语料分布。
- **多维度缺陷审计工具链**：
  - 首府攻防与失守审计 (`cap_audit.js`)
  - 城市占领与聚兵审计 (`city_audit.js`, `city_gather_audit.js`, `city_gate_audit.js`)
  - 闲置行军与漏算审计 (`idle_audit.js`, `leak_audit.js`, `oscil_audit.js`)
  - 断子滞留审计 (`stranded_audit.js`)
  - 突袭与闪击测试 (`strike_audit.js`, `sniper_test.js`)
- **严谨置信区间评估 (`ver_report.js`, `arena.js`)**：
  - 按对手天梯星级（全部、≥20★、≥25★、≥30★）分段输出真实胜率，消除对手池漂移导致的虚假胜率陷阱；
  - 采用 Wilson 95% 置信区间衡量代际强度提升。

---

## 📁 目录结构

```text
├── index.js                     # 官方 Bot 协议客户端入口 (CLI 参数、房间配置)
├── headless_bot.js              # Playwright 无头浏览器全自动天梯挂机脚本
├── src/
│   ├── client.js                # Socket.io 协议通信层与断线重连
│   ├── gamestate.js             # 棋盘状态管理、迷雾记忆、map_diff 解包
│   ├── pathfinding.js           # 二叉堆带权 Dijkstra 与多源 BFS 寻路
│   ├── belief.js                # 敌方将军位置贝叶斯后验概率推断
│   ├── commit.js                # 行动承诺与连续推进控制器
│   ├── strategy.js              # 核心策略分发入口 (当前激活: v55 策略)
│   ├── strategy_v1.js ~ v57.js  # 历代策略演进全纪录
│   └── imitation*.js            # 模仿学习推理策略模块
├── replays/
│   ├── Game.js, Map.js ...      # 官方回放解压与模拟重放引擎 (.gior 支持)
│   ├── corpus/                  # 真实高手对战语料库
│   ├── pro/                     # 职业级高水平对局切片
│   ├── imitation/               # 模仿学习特征提取器、训练器与模型文件
│   └── scorecard.js             # 多维度战绩指标评分卡
├── test/
│   └── sim.js                   # 离线 5x5 冒烟测试套件
├── arena.js                     # 策略对战离线擂台
├── conformance.js               # 与官方协议逐帧一致性校验
├── ver_report.js                # 分星级实战成绩报表工具
├── cap_audit.js / city_audit.js # 专项缺陷审计脚本集
└── current_status.png           # 自动化实战实时截图
```

---

## 🚀 快速开始

### 1. 环境准备
需要 Node.js (>= 18.0.0)。克隆仓库后安装依赖：

```bash
npm install
```

### 2. 离线冒烟测试
无需联网，快速验证补丁算法、寻路与策略完整性：

```bash
node test/sim.js
```

### 3. 私人房间测试 (推荐首选)
在自定义房间与机器人或朋友对局调试：

```bash
# 设置您的密钥与机器人名称 (注: 官方要求 Bot 名称必须以 "[Bot] " 开头)
GENERALS_USER_ID="your_secret_token" GENERALS_USERNAME="[Bot] MyBot" \
  node index.js --mode private --game test_room_123
```
控制台会打印对局链接，直接在浏览器中打开链接即可加入房间对战。

### 4. 天梯与实战模式
- **直接连线排位 (需 Bot 账号已通过官方审核)：**
  ```bash
  # 1v1 天梯
  node index.js --mode 1v1

  # FFA 混战
  node index.js --mode ffa
  ```
- **自动化无头浏览器巡航模式 (Playwright)：**
  ```bash
  GENERALS_USER_ID="your_user_id" node headless_bot.js
  ```
  该模式会自动打开无头 Chrome 排位，并在当前目录生成 `current_status.png` 实时截图与 `match_history.log`。

### 5. 评测与审计

- **版本间离线对位对战：**
  ```bash
  node arena.js
  ```
- **复盘对局并生成星级胜率审计报表：**
  ```bash
  GIO_ME=your_bot_name node ver_report.js protodump_by_ver/v55
  ```
- **将军失守专项审计：**
  ```bash
  node cap_audit.js protodump_ladder
  ```

---

## 📜 许可证

本项目遵循 [MIT License](LICENSE) 开源许可证。
