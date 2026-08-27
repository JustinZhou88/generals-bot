---
name: generals-io-headless-bot
description: 在 generals.io 上无人值守运行 1v1 对战 Bot,并提供浏览器实时观战直播。通过 Playwright Headless Chrome 登录账号、拦截页面内 window.socket 获取对局数据、驱动策略引擎自动出招,配套自动排队、掉线自愈、进程守护、自动投降、回放归档与 SSE 直播面板。Use this skill whenever the user wants to run, restart, debug, or monitor the generals.io bot — including "跑一下 bot"、"开直播/看战况"、"切换策略版本(v51/v54/v55...)"、"bot 卡住了/排不进队列/掉线了"、"投降"、"改观战面板", or any work involving headless_bot.js, live_viewer.js, keep_alive.sh, restart_bot.sh in this directory.
---

# Generals.io Headless Bot + 实时观战直播

一套可长期无人值守运行的 generals.io 1v1 对战系统。Bot 侧用 Playwright 驱动 Headless Chrome,
挂钩页面内的 `window.socket` 收发对局数据;观战侧是一个独立的 SSE 服务器,把战况实时推到浏览器。

**这份文档里的绝大多数细节都来自实战踩坑**(见 [排障与已知陷阱](#排障与已知陷阱))。
改动前请先读对应条目 —— 好几处"看起来更合理"的写法都已经被证伪过。

---

## 目录结构

```
generals_io_headless_bot_skill/
├── SKILL.md              # 本文件
├── headless_bot.js       # 主程序:登录、Socket Hook、自动排队、自愈、战况输出
├── live_viewer.js        # 观战直播服务器(独立进程,只读战况文件)
├── keep_alive.sh         # 守护脚本:进程崩溃后自动拉起
├── restart_bot.sh        # 安全重启:等当前对局结束再重启,避免弃权判负
├── src/                  # 策略引擎与状态计算
│   ├── gamestate.js      # 地图解码、diff 补丁、可见性/距离查询
│   ├── strategy_v55.js   # 当前启用的决策引擎(可切换,见「切换策略版本」)
│   ├── pathfinding.js    # 带权 Dijkstra + 二叉堆
│   └── imitation6.js     # 模仿学习先验
├── replays/imitation/    # 模仿学习模型权重
├── replay_links/         # 对局回放归档(自动生成)
│   ├── replays.md        # 索引表:时间/对手/胜负/回放链接
│   └── *.webloc          # 每局一个,macOS 双击直接打开
├── live_status.txt/.json # 实时战况快照(每半回合刷新)
├── current_status.png    # 仅空闲期截图,用于排查排队界面问题
├── bot.log / keepalive.log
└── .bot.pid              # 单实例锁
```

---

## 环境前提

1. **Node.js** v16+(实测 v22)
2. **Google Chrome**,路径写死在 `headless_bot.js` 的 `executablePath`。非 macOS 需自行修改。
3. **依赖**已随 `node_modules/` 提供,必要时 `npm install`。
4. **网络代理**(如果本机通过代理访问 generals.io)—— 见下方关键说明。

### 代理是必须显式指定的

Playwright 启动的 Chrome **不继承系统代理**。若本机用 Clash 之类的工具、DNS 把 generals.io
解析到 fake-IP(如 `198.18.x.x`),Headless Chrome 会直连那个假地址,表现为 `page.goto` 一直超时,
而同一台机器上 `curl` 完全正常 —— 因为 curl 读了 `HTTPS_PROXY` 环境变量。

程序会按 `GENERALS_PROXY` → `HTTPS_PROXY` → `HTTP_PROXY` 顺序自动取值并传给浏览器,
通常无需手动设置。诊断网络时用这条命令(它和浏览器走同一条路):

```bash
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" --max-time 15 https://generals.io/
```

---

## 快速开始

```bash
cd /Users/justin/Desktop/generals_io_headless_bot_skill

nohup ./keep_alive.sh >/dev/null 2>&1 &          # 守护脚本(它会负责拉起 bot)
nohup node live_viewer.js > /tmp/viewer.log 2>&1 &   # 观战直播
open http://127.0.0.1:8787
```

守护脚本每 30 秒检查一次,bot 不在就拉起,所以**不需要单独启动 bot**。

指定其他账号:

```bash
GENERALS_USER_ID=你的USER_ID node headless_bot.js
```

**停止**时要先停守护,否则杀了 bot 它又会被拉起来:

```bash
pkill -f keep_alive.sh
kill $(cat .bot.pid)
```

---

## 实时观战直播

`live_viewer.js` 监听 `live_status.txt` 的写入,解析成结构化棋盘后通过 **SSE** 推给浏览器,
bot 每走一步(半回合)刷新一帧。它是**独立进程**,改观战面板不需要重启 bot,也不会打断对局。

面板内容:

- **棋盘** —— 蓝=我方、红=敌方、`♛`=家(将军,金框)、`♜`=塔(城,圆形)、`▲`=山,
  深浅两级暗格区分"探索过的雾"和"从没去过";每格显示兵力;当前这一步起点虚线框、终点实线框
- **顶栏** —— 官方回合数、双方 ★星级、兵力/地块、♜塔数、兵力占比条
- **右侧** —— 兵力差/地块差、敌将是否已定位、最近威胁(几兵距将几格,≤3 格标红)、
  兵力走势折线、决策日志(每步带意图:expand / gather / raid / strike / defend)

### 为什么用文本快照而不是截图

早期版本每 2 秒截一张 PNG。截图只能看个轮廓,读不出每格兵力,也无法判断"该不该回防"。
现在 bot 直接把 Node 侧已有的完整 `GameState` 渲染成定宽文本棋盘写进 `live_status.txt`,
观战服务器再解析它。精度高得多,而且可以直接 `cat` 出来看:

```bash
cat live_status.txt      # 人读
cat live_status.json     # 机器读
```

截图只在**空闲期**保留(`current_status.png`),用途是排查排队界面点不动的问题 ——
那种时候页面长什么样是唯一有用的证据。

---

## 对局控制

### 手动投降

```bash
touch do_surrender
```

Bot 每 2 秒检查一次该文件,读到后向服务器发 `surrender` + `leave_game`,并在日志里回执
指令是否真的送达(socket 断开时会明确告知并转为强制重置,而不是静默失败)。

### 自动投降

对手兵力超过我方 `SURRENDER_RATIO` 倍(默认 5)时自动认输进下一局。挂机拖延局
(对手滚塔滚到几万兵却不收尾)会白白占掉几十分钟,认输换局的期望收益高得多。

三道防抖避免误判:需连续 6 个 tick 满足、回合 > 100 tick、对手兵力 ≥ 50。

```bash
SURRENDER_RATIO=8 node headless_bot.js   # 临时调阈值,不用改代码
```

### 回放归档

每局结束自动写入 `replay_links/`:`replays.md` 是带时间/对手/胜负的索引表,
另有每局一个 `.webloc`,Finder 双击直接打开回放。

```bash
echo "胜 $(grep -c '| WIN |' replay_links/replays.md) / 负 $(grep -c '| LOSS |' replay_links/replays.md)"
```

---

## 切换策略版本

策略引擎与外围完全解耦,所有版本都导出 `{ Strategy }` 且只依赖 `pathfinding` + `imitation6`。

```bash
cp /path/to/generals-bot/src/strategy_vNN.js src/     # 从开发仓取(注意核对时间戳!)
sed -i '' 's|strategy_v55|strategy_vNN|g' headless_bot.js
node --check headless_bot.js
./restart_bot.sh                                       # 等当前对局结束再切
```

从开发仓复制前**先看 mtime** —— 开发仓的文件可能在你复制之后又更新过,导致线上跑的是旧版。

复制时只拿策略文件。开发仓的 `gamestate.js` 把回放域名写成 `bot.generals.io`(官方 Bot 服务器),
我们打的是主站,**不要覆盖本地的 `gamestate.js`**。

### 离线胜率不等于实战胜率

v54 的三个离线裁判全部给正号,实战却对 ≥20★ 对手 **0 胜 14 负**(我们这边独立复现了 0 胜 11 负)。
作者最终拆开两项改动,只保留其中的保护闩发布为 v55。

**换版本后至少跑二三十局再下结论**,并且要排除掉线、弃权、重启造成的非对局失败 ——
这些同样记为 LOSS,会严重污染小样本。

---

## 自愈机制总览

无人值守的核心。每一层都对应一类实际发生过的故障:

| 机制 | 触发条件 | 动作 |
|---|---|---|
| 守护脚本 `keep_alive.sh` | 进程不存在 | 30 秒内拉起 |
| 进程内异常兜底 | `uncaughtException` / `unhandledRejection` | 记录原因、释放锁、干净退出,交给守护 |
| 掉线看门狗 | 对局中数据流静止 > 45 秒 | 重置 `inGame`、重载页面、重新排队 |
| socket 看门狗 | 非对局中 socket 断开 > 60 秒 | 强制重载页面重建连接 |
| 排队看门狗 | 确认停在主菜单且不在队列 | 重新排队 |
| 卡死判定 | 页面持续处于未知状态 > 2 分钟 | 强制重载 |
| 浮层清除 | `elementFromPoint` 发现按钮被遮挡 | 隐藏遮罩层 |

---

## 排障与已知陷阱

下面每一条都是实际踩过的坑,附带**为什么直觉的做法是错的**。

### 页面按钮只认真实鼠标事件

`element.click()` 合成事件对 generals.io 的 PLAY 和 1v1 按钮**时灵时不灵**,失灵时静默无效 ——
没有报错,只是弹窗不开、队列进不去。必须用 DOM 量出中心坐标,再 `page.mouse.click(x, y)`。

### 按钮坐标必须每次现测

模式选择弹窗的行数会变(活动期间会多出 "Big Team" 一行,1v1 从 y=293 挪到 y=355)。
任何硬编码坐标都会在某天突然失效,而且失败方式很隐蔽:点在按钮下方的说明文字上,
有时还会把弹窗关掉,让后续正确的点击也落空。

### 定位弹窗要用 "players active"

主菜单背景里有个显示战绩的 "1v1" 标签,排行榜弹窗的标签栏里也有 "1v1"/"FFA"/"2v2"。
仅按这些文字找会点到错误元素 —— 曾因此陷入"每 20 秒点一次排行榜标签"的死循环 6 分钟。
`players active` 只出现在真正的模式选择弹窗里,是可靠的判别特征。
另外排队前先按两次 Esc 清掉残留弹窗。

### 1v1 按钮会被服务器标记 disabled

刚打完一局重连后,服务器会在一段时间内把模式按钮设为 `<button disabled>`,
这期间**点多少次都无效**。正确做法是等它自己解禁(最长 180 秒,每 30 秒记一次进度)。

反直觉的地方:此时**重载页面反而更慢**,因为会重置 socket、把解禁窗口拖得更长。
曾经加过"每局结束就强制重载"的优化,基于错误归因,实际是负优化,已撤销。

### 通知类浮层会盖住按钮

玩过几局后 generals.io 会弹 "Want to enable Notifications?",盖在 1v1 按钮上。
按钮本身 DOM 正常(不 disabled、位置没变),但点击全落在遮罩上 —— 曾连续失败 14 次卡住 5 分钟。

程序用 `elementFromPoint(按钮中心)` 判断是否真的可点,被挡就把那层浮层 `display:none`。
这是通用逻辑,新出现的弹窗也能处理。
**绝不要去点 "Enable Notifications"** —— 那会触发浏览器权限请求。

### socket 断线重连会换新实例

挂钩代码**不能挂上一次就 `clearInterval`**。socket.io 重连时会创建新的 socket 实例,
老实例上的 handler 全部失效,表现为"对局中数据流突然静止、投降也没反应"。
必须持续轮询,发现未挂钩的新实例就重新挂。

曾因此在一局里静止 12 分钟无人发现 —— 因为收不到 `game_lost`,`inGame` 永远为 true,
空闲分支不执行,战况文件不更新,直播面板看起来就是"卡住"。

### 排队状态判定必须是三态

只判断「排队中 / 不在排队」会在"已匹配上但 `game_start` 还没送达"的过渡窗口里
误判为掉线并重载页面,把刚开局的客户端踢掉直接送掉一局。

正确的划分是 `searching` / `menu` / `unknown`,**只有确认停在主菜单时才主动排队**,
未知状态一律不碰,连续 2 分钟都是未知才认为真卡住。

还有个死角:**页面显示 "Finding a match..." 但 socket 已断** —— 页面文字骗过了看门狗,
实际永远等不到匹配。所以每轮还要单独检查 `window.socket.connected`。

### 单实例锁必须原子

`restart_bot.sh` 和 `keep_alive.sh` 可能同时拉起进程。「读取 pid → 判断 → 写入」不是原子操作,
两个进程会在对方写入前都完成读取、双双通过检查。两个实例抢同一账号会互相打断
(一个点 PLAY、另一个刚好重载页面),表现为**永远排不进队列**。

必须用 `fs.openSync(LOCK_FILE, 'wx')` 独占创建;发现锁存在时检查里面的 pid 是否存活,
是僵尸锁才清理重试。

### 停 bot 不要用 `pkill -f headless_bot.js`

这个模式会匹配到**执行它的那层 shell 自己**(命令行里含有该字符串),shell 被杀、
node 子进程变成孤儿活下来,于是你以为停干净了,实际留了个实例在跑。
用 `kill $(cat .bot.pid)`。

### 重启前必须确认不在对局中

人工"先检查再手动 kill"不可靠 —— 检查与执行之间哪怕隔十几秒,都可能刚好卡在匹配成功的瞬间。
这样丢过两局。用 `./restart_bot.sh`,它把「检查 → kill」压在同一个循环迭代里:

```bash
./restart_bot.sh            # 等对局结束后重启
./restart_bot.sh --force    # 立即重启(会判负)
```

### 网络故障会杀死页面进而杀死进程

代理抖动时 Chrome 页面可能彻底死掉,之后任何 Playwright 调用都抛
`ProtocolError: Not attached to an active page`。这个错误没人捕获就会直接结束 node 进程 ——
曾因此静默停机 5.5 小时(观战服务器还活着,面板停在故障那一帧,看起来像"卡住")。

现在异常兜底会记录原因并干净退出,由 `keep_alive.sh` 在 30 秒内拉起。

---

## 数据推断的两个技巧

### 塔数推断(对手的塔也能算出来)

将军和每座塔在**每个整回合**(= 2 个半回合 tick)各 +1 兵,其余地块只在每 25 回合的翻倍点 +1。
于是在「地块数不变(没扩张也没被吃)且未跨越翻倍点」的两个 tick 之间:

```
兵力增量 = 1 (将军) + 塔数
```

取 40 个样本滑动窗口的**众数**(不是均值)以抗交战噪声。我方同时给出"实测"(自己地图信息确定)
和"推断",可以直接验证估计器准不准 —— 稳态下两者一致。

注意 `game_update` 每个 tick 都触发(delta=1),所以必须跟**2 个 tick 之前**的帧比,
不能跟上一帧比。刚打下或丢掉一座塔时窗口会滞后几十回合才切换,属正常。

### 双方星级

socket 的 `stars` 事件**只推自己的**星级(按游戏模式索引),拿不到对手。
双方星级改用官方公开接口,在页面内 fetch(自动复用浏览器的代理与同源上下文):

```
/api/starsAndRanks?u=<用户名>
```

返回里还有 `ranks.duel` 和 `isBot` —— 对手是不是注册 bot 一眼可见。

---

## 合规提醒

本方案用普通账号排 generals.io 的**公开 1v1 天梯**,对手是真人。generals.io 官方规定
Bot 应通过 bot API 接入并使用 `[Bot]` 前缀用户名,站内也提供了"1v1 避开 bot"的选项。
用普通账号挂机排天梯违反其规则,账号存在被封风险。使用者需自行判断并承担后果。
