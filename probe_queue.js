'use strict';
/*
 * probe_queue.js — 排队探针:验证"我们真的排上了队"这件事本身。
 *
 * 为什么需要:index.js 的日志里那三行全是本地 console.log,
 * 只能证明我们**发出**了 join_1v1,不能证明服务器**收到并接受**。
 * 这里用 socket.onAny 把服务器发来的每一个事件原样打印,
 * 有回音 = 真在队列里;全程静默 = 石沉大海。
 *
 * 用法: GENERALS_SERVER=https://ws.generals.io GENERALS_USER_ID=xxx node probe_queue.js
 */

const io = require('socket.io-client');

const SERVER = process.env.GENERALS_SERVER || 'https://botws.generals.io';
const USER_ID = process.env.GENERALS_USER_ID;
if (!USER_ID) { console.log('缺 GENERALS_USER_ID'); process.exit(1); }

const t0 = Date.now();
const ts = () => `[+${((Date.now() - t0) / 1000).toFixed(1)}s]`;

const socket = io(SERVER, {
  transports: ['polling', 'websocket'],
  reconnection: true,
  extraHeaders: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Origin': 'https://generals.io',
    'Referer': 'https://generals.io/',
  },
});

// 服务器发来的任何东西都打出来。game_update 太吵,只报计数。
let updates = 0;
socket.onAny((ev, ...args) => {
  if (ev === 'game_update') { if (++updates % 25 === 1) console.log(`${ts()} <= game_update #${updates}`); return; }
  let s;
  try { s = JSON.stringify(args); } catch (e) { s = String(args); }
  if (s && s.length > 600) s = s.slice(0, 600) + `…(${s.length}B)`;
  console.log(`${ts()} <= ${ev} ${s}`);
});

socket.on('connect', () => {
  console.log(`${ts()} 已连接 ${SERVER}  sid=${socket.id}  transport=${socket.io.engine.transport.name}`);
  console.log(`${ts()} => join_1v1`);
  socket.emit('join_1v1', USER_ID);
  // 有些服务端要 force_start 才动;人服 1v1 一般不需要,这里只作对照观察。
});
socket.on('connect_error', (e) => console.log(`${ts()} !! connect_error: ${e && e.message}`));
socket.on('disconnect', (r) => console.log(`${ts()} !! disconnect: ${r}`));

// 每 15s 报一次心跳,证明进程还活着、连接还在。
setInterval(() => {
  console.log(`${ts()} 心跳 connected=${socket.connected} transport=${socket.connected ? socket.io.engine.transport.name : '-'}`);
}, 15000);
