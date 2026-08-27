'use strict';

const io = require('socket.io-client');
const { GameState } = require('./gamestate');
const StrategyPath = process.env.STRATEGY_FILE || './strategy';
const StrategyMod = require(StrategyPath);
const Strategy = StrategyMod.Strategy || StrategyMod;

// 服务器地址(从官方客户端 bundle 确认):
//   主服务器(真人)  ws.generals.io      —— 官方已允许 bot 进入,更新日志有
//                                          "Option to avoid bots in 1v1"(人类可选择避开 bot)
//   机器人服务器     botws.generals.io
// 两边账号系统是分开的:同一个 user_id 在另一台服务器上是全新的。
const SERVER = process.env.GENERALS_SERVER || 'https://botws.generals.io';

class BotClient {
  /**
   * @param {object} cfg
   * @param {string} cfg.userId   自己保管好的密钥字符串(任意,但要唯一且保密)
   * @param {string} cfg.username 必须以 "[Bot] " 开头,只需注册一次,之后不可改
   * @param {'private'|'1v1'|'ffa'} cfg.mode
   * @param {string} [cfg.gameId] private 模式的自定义房间 id
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.gs = new GameState();
    this.strategy = new Strategy(this.gs);
    this.socket = null;
    this.playing = false;
  }

  connect() {
    // 让 socket.io 处理短暂网络抖动的自动重连;服务器主动踢(io server disconnect)
    // 时它不会自动重连,由下面的指数退避手动处理,避免把服务器打崩触发封禁。
    this.socket = io(SERVER, {
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionDelay: 3000,
      reconnectionDelayMax: 30000,
      extraHeaders: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Origin': 'https://generals.io',
        'Referer': 'https://generals.io/',
      },
    });
    this.reconnectDelay = 5000; // 被服务器踢后的退避,失败翻倍,封顶 5 分钟

    // GIO_TRACE=1:打印服务端发来的每一个事件。用来分清"真在排队"和"请求石沉大海" ——
    // 只看本地 console.log 是分不出来的(见 gio_error 那次:白等了几分钟)。
    if (process.env.GIO_TRACE) {
      let upd = 0;
      this.socket.onAny((ev, ...args) => {
        if (ev === 'game_update') { if (++upd % 50 === 1) console.log(`[trace] <= game_update #${upd}`); return; }
        let s; try { s = JSON.stringify(args); } catch (e) { s = String(args); }
        if (s && s.length > 400) s = s.slice(0, 400) + `…(${s.length}B)`;
        console.log(`[trace] <= ${ev} ${s}`);
      });
    }

    this.socket.on('connect', () => {
      console.log('[net] 已连接 bot 服务器');
      this.reconnectDelay = 5000; // 连上就重置退避
      // 注册用户名(同一 user_id 只需成功一次,重复调用会被忽略/报错,无碍)。
      // SKIP_REGISTER=1 时只登录、不注册 —— 换服务器时用它先确认账号是否已存在,
      // 避免在新服务器上无意中开一个新账号。
      if (!process.env.SKIP_REGISTER) {
        this.socket.emit('set_username', this.cfg.userId, this.cfg.username);
      } else {
        console.log('[net] SKIP_REGISTER:跳过注册,仅用现有账号登录');
      }
      this.joinQueue();
    });

    // 只注册一次:有人进出私人房时保持 force start(以前每次 join 都注册,会叠加成风暴)
    this.socket.on('queue_update', (data) => {
      if (data && data.usernames) {
        console.log('[net] 房间玩家列表:', data.usernames.join(', '));
      }
      if (this.cfg.mode !== '1v1' && this.cfg.mode !== 'ffa' && this.currentGid) {
        this.socket.emit('set_force_start', this.currentGid, true);
      }
      // FFA:joinQueue 里那次 set_force_start 是紧跟着 play 发的,服务器还没把我们
      // 登记进 lobby 就被丢掉了 —— GIO_TRACE 实测 numForce 里只有对方、没有我们,
      // 于是只能干等 lobby 凑满 playerCap(12),机器服上等不到,对方十几秒就退了。
      // 这里在确认已进 lobby 后补发,并限流 5s 一次,避免打成事件风暴触发封禁。
      if (this.cfg.mode === 'ffa' && data && data.numPlayers >= 2) {
        const now = Date.now();
        if (!this._lastForce || now - this._lastForce > 5000) {
          this._lastForce = now;
          this.socket.emit('set_force_start', null, true);
        }
      }
    });

    this.socket.on('disconnect', (reason) => {
      this.playing = false;
      if (reason === 'io server disconnect') {
        // 服务器主动断开:退避后再连,并逐次翻倍,别硬刷
        console.log(`[net] 被服务器断开,${Math.round(this.reconnectDelay / 1000)}s 后重连…`);
        setTimeout(() => this.socket.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 300000);
      } else {
        console.log('[net] 连接断开(网络抖动),socket.io 自动重连中…');
      }
    });

    // 服务器返回的用户名错误:翻译成人话,并给出该怎么办
    // 服务器的通用错误通道。以前没监听,导致服务端的拒绝被静默吞掉:
    // 实测在 ws.generals.io 上 join_1v1 会在 300ms 内收到
    // gio_error ["Bots cannot play on the NA server."],但日志停在"加入 1v1 队列",
    // 看起来和"正在排队"完全一样,白等了几分钟才发现根本没排上。
    this.socket.on('gio_error', (msg) => {
      console.log(`[net] ❌ 服务器错误: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
      const m = String(msg).toLowerCase();
      if (m.includes('bots cannot play')) {
        console.log('       含义:本账号已被服务端标记为 bot,该服务器拒绝 bot 入场。');
        console.log('       这不是网络问题,重试无用 —— 排队请求已被拒,不会有匹配。');
      }
    });

    this.socket.on('error_set_username', (msg) => {
      if (!msg) {
        console.log('[net] ✅ 用户名注册成功(服务器无异议)');
        return;
      }
      console.log('[net] ⚠️ 服务器拒绝了用户名设置,原句: ' + msg);
      const m = String(msg).toLowerCase();
      if (m.includes('already have a username')) {
        console.log('       含义:这个 user_id 在本服务器上已经注册过了,不用再注册,直接用即可。');
        console.log('       (改名需要 Supporter 会员,所以这条不是错误,可以忽略。)');
      } else if (m.includes('taken') || m.includes('in use')) {
        console.log('       含义:这个用户名已经被别人占用了。换一个名字再试。');
      } else if (m.includes('cannot start with [bot]')) {
        console.log('       含义:本服务器【禁止】用户名以 "[Bot] " 开头 —— 这是主服务器(ws.generals.io)的规则。');
        console.log('       "[Bot] " 前缀是机器人服务器(botws.generals.io)专用的。');
      } else if (m.includes('must begin with') || (m.includes('must start with') && m.includes('bot'))) {
        console.log('       含义:服务器已经把本账号识别为 bot,要求用户名以 "[Bot] " 开头。');
        console.log('       注意:主服务器(ws.generals.io)同时又禁止用 "[Bot] " 开头 —— 两条规则合起来');
        console.log('       就是"bot 不能在主服务器注册账号"。bot 请用 botws.generals.io(默认值)。');
      } else if (m.includes('invalid') || m.includes('character')) {
        console.log('       含义:用户名含有不允许的字符。官方禁止 < > / \\ 这四个字符。');
      } else if (m.includes('wait a bit longer')) {
        console.log('       含义:服务器触发了新账号注册频率限制,请稍等后自动重试。');
      } else {
        console.log('       含义:不在已知清单里。把上面这句原文发给我,我来判断。');
      }
    });

    // 其余各类服务器报错也打出来(以前这些是静默的,所以"报错看不懂")
    for (const ev of ['error', 'connect_error', 'error_banned', 'error_queue_full',
                      'game_lost_reason', 'error_set_custom_map', 'error_user_id']) {
      this.socket.on(ev, (a, b) => {
        console.log(`[net] ⚠️ 服务器事件 ${ev}: ${JSON.stringify(a) || ''} ${b !== undefined ? JSON.stringify(b) : ''}`);
      });
    }

    this.socket.on('game_start', (data) => {
      this.playing = true;
      this.gs = new GameState();
      this.strategy = new Strategy(this.gs);
      this.gs.start(data);
      this._dumpPath = null; // 每局单独一个录制文件(否则连打多局会全部追加进第一局的文件)
      const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      const vsStr = data.usernames ? data.usernames.join(' vs ') : '对局';
      console.log(`[game ${timeStr}] 🎮 匹配成功! 开局: ${vsStr} (我是 index=${data.playerIndex})`);
      console.log(`[game] 回放: ${this.gs.replayUrl}`);
      try {
        const { exec } = require('child_process');
        const title = 'Generals.io Bot 匹配成功!';
        const body = `对局开局: ${vsStr}`;
        exec(`osascript -e 'display notification "${body}" with title "${title}" sound name "Glass"'`);
      } catch (e) {}
    });

    this.socket.on('game_update', (data) => {
      this.gs.update(data);
      // 协议录制(仅 DUMP_PROTO 设置时):把服务器视角逐半回合落盘,
      // 用于离线模拟器的保真度校验(见 conformance.js)。不影响正常对局。
      if (process.env.DUMP_PROTO) this.dumpFrame(data);
      const mv = this.strategy.nextMove();
      if (mv) {
        this.socket.emit('attack', mv.from, mv.to, !!mv.is50); // 第三参:is50 半推
      }
      if (this.gs.turn % 100 === 0) {
        const s = this.gs.myScore();
        console.log(`[game] turn=${this.gs.turn} 兵力=${s.total} 地块=${s.tiles}`);
      }
    });

    this.socket.on('game_won', () => {
      this.endGame('🏆 胜利!');
      try {
        const { exec } = require('child_process');
        exec(`osascript -e 'display notification "🏆 恭喜! 获得本局胜利!" with title "Generals.io Bot 对局结束"'`);
      } catch (e) {}
    });
    this.socket.on('game_lost', () => {
      this.endGame('💀 战败。');
      try {
        const { exec } = require('child_process');
        exec(`osascript -e 'display notification "💀 本局战败" with title "Generals.io Bot 对局结束"'`);
      } catch (e) {}
    });
  }

  /**
   * 把服务器发来的这一帧"我方视角"落盘(每半回合一行 JSON)。
   * 记录的是 GameState 打完补丁后的最终视图 —— 也正是离线 injectView
   * 必须逐格复现的东西。文件名: DUMP_PROTO 目录/<replay_id>_p<idx>.jsonl
   */
  dumpFrame(data) {
    const fs = require('fs');
    const path = require('path');
    if (!this._dumpPath) {
      const dir = process.env.DUMP_PROTO;
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
      const rid = (this.gs.replayUrl || 'unknown').split('/').pop();
      this._dumpPath = path.join(dir, `${rid}_p${this.gs.playerIndex}.jsonl`);
      fs.writeFileSync(this._dumpPath, JSON.stringify({
        meta: true, replayId: rid, playerIndex: this.gs.playerIndex,
        usernames: this.gs.usernames, width: this.gs.width, height: this.gs.height,
      }) + '\n');
    }
    fs.appendFileSync(this._dumpPath, JSON.stringify({
      turn: data.turn,
      armies: this.gs.armies,
      terrain: this.gs.terrain,
      cities: this.gs.cities,
      generals: this.gs.generals,
      scores: this.gs.scores.map((s) => ({ i: s.i, total: s.total, tiles: s.tiles, dead: !!s.dead })),
    }) + '\n');
  }

  endGame(msg) {
    console.log('[game] ' + msg + ' 回放: ' + this.gs.replayUrl);
    this.socket.emit('leave_game');
    this.playing = false;
    if (process.env.SINGLE_GAME === 'true') {
      const isWin = msg.includes('胜利');
      // Exit code 0 = winner, 42 = loser (distinct non-error code)
      this.socket.disconnect();
      setTimeout(() => process.exit(isWin ? 0 : 42), 500);
      return;
    }
    // 稍等后自动排下一局
    setTimeout(() => this.joinQueue(), 5000);
  }

  joinQueue() {
    if (this.playing) return;
    const { userId, mode, gameId } = this.cfg;
    if (mode === '1v1') {
      console.log('[net] 加入 1v1 队列');
      this.socket.emit('join_1v1', userId);
    } else if (mode === 'ffa') {
      console.log('[net] 加入 FFA 队列');
      this.socket.emit('play', userId);
      this.socket.emit('set_force_start', null, true);
    } else {
      const gid = gameId || 'bot_test_' + Math.floor(Math.random() * 1e6);
      this.currentGid = gid; // queue_update 处理器(只注册一次)用它保持 force start
      console.log(`[net] 加入自定义房间: ${gid}`);
      console.log(`[net] 浏览器打开加入对战: https://bot.generals.io/games/${encodeURIComponent(gid)}`);
      this.socket.emit('join_private', gid, userId);
      setTimeout(() => this.socket.emit('set_force_start', gid, true), 2000);
    }
  }
}

module.exports = { BotClient };
