'use strict';

const { chromium } = require('playwright-core');
const { GameState } = require('./src/gamestate');
const { Strategy } = require('./src/strategy_v51');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const USER_ID = process.env.GENERALS_USER_ID || 'HkiU9LHoj';
const INITIAL_URL = `http://generals.io/?user_id=${encodeURIComponent(USER_ID)}&email=justinzhouwuxi%40gmail.com`;
const MATCH_LOG = path.join(__dirname, 'match_history.log');
const STATUS_PNG = path.join(__dirname, 'current_status.png');
const SURRENDER_FILE = path.join(__dirname, 'do_surrender');

console.log(`[headless] 🚀 正在精准使用初始链接打开并刷新主服务器: ${INITIAL_URL}`);
console.log(`[headless] 目标账号: ${USER_ID}, 激活策略: src/strategy_v51.js`);
console.log(`[headless] 实时界面截图存储至: ${STATUS_PNG}`);

let gs = null;
let strategy = null;
let currentGameData = null;

function logMatchEvent(text) {
  const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = `[${timeStr}] ${text}`;
  console.log(line);
  try {
    fs.appendFileSync(MATCH_LOG, line + '\n');
  } catch (e) {}
}

(async () => {
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--window-size=1280,720']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 }
  });

  const page = await context.newPage();

  // 开启每 2 秒实时截图更新机制与 Surrender 信号监听
  setInterval(async () => {
    try {
      await page.screenshot({ path: STATUS_PNG });
    } catch (e) {}

    // 检测投降信号
    if (fs.existsSync(SURRENDER_FILE)) {
      try {
        fs.unlinkSync(SURRENDER_FILE);
      } catch (e) {}
      logMatchEvent(`🏳️ 收到用户投降指令，正在向网页端 window.socket 发送 surrender / leave_game…`);
      await page.evaluate(() => {
        if (window.socket && window.socket.connected) {
          window.socket.emit('surrender');
          window.socket.emit('leave_game');
        }
      });
    }
  }, 2000);

  page.on('console', msg => {
    const txt = msg.text();
    if (txt.includes('[browser]') || txt.includes('[v51 bot]') || txt.includes('[headless]')) {
      console.log(txt);
    }
  });

  // 绑定 Node.js 与 Headless Chrome 浏览器的 v51 决策桥梁
  await page.exposeFunction('bridgeGameStart', (data) => {
    currentGameData = data;
    gs = new GameState();
    strategy = new Strategy(gs);
    gs.start(data);

    const opponent = data.usernames ? data.usernames.filter((_, idx) => idx !== data.playerIndex).join(', ') : '未知对手';
    const replayLink = `https://generals.io/replays/${encodeURIComponent(data.replay_id)}`;
    
    logMatchEvent(`🎮 匹配成功! 开局对战对手: [${opponent}] (我是 index=${data.playerIndex})`);
    logMatchEvent(`🔗 实时对局/回放地址: ${replayLink}`);

    try {
      exec(`osascript -e 'display notification "对局开局! 对手: ${opponent}" with title "Generals.io v51 匹配成功!" sound name "Glass"'`);
    } catch (e) {}
  });

  await page.exposeFunction('bridgeGameUpdate', async (data) => {
    if (!gs || !strategy) return;
    gs.update(data);

    // 调用 v51 计算下一步算法路线
    const mv = strategy.nextMove();
    if (mv) {
      // 实时向网页端 window.socket 发送移动操作指令
      await page.evaluate(({ from, to, is50 }) => {
        if (window.socket && window.socket.connected) {
          window.socket.emit('attack', from, to, !!is50);
        }
      }, { from: mv.from, to: mv.to, is50: mv.is50 });
    }

    if (gs.turn % 20 === 0) {
      const s = gs.myScore();
      console.log(`[v51 bot] turn=${gs.turn} 兵力=${s.total} 地块=${s.tiles}`);
    }
  });

  await page.exposeFunction('bridgeGameWon', async () => {
    const replayLink = currentGameData ? `https://generals.io/replays/${encodeURIComponent(currentGameData.replay_id)}` : '';
    logMatchEvent(`🏆 比赛结束 - 本局获得【胜利】! 官方回放地址: ${replayLink}`);

    try {
      exec(`osascript -e 'display notification "🏆 恭喜! 本局获得胜利! 回放: ${replayLink}" with title "v51 Bot 结果"'`);
    } catch (e) {}

    // 自动连续排队: 稍等3秒后自动进入下一局匹配
    logMatchEvent(`🔄 正在自动准备下一局 1v1 匹配…`);
    setTimeout(() => startQueue(page), 3000);
  });

  await page.exposeFunction('bridgeGameLost', async () => {
    const replayLink = currentGameData ? `https://generals.io/replays/${encodeURIComponent(currentGameData.replay_id)}` : '';
    logMatchEvent(`💀 比赛结束 - 本局【战败】。 官方回放地址: ${replayLink}`);

    try {
      exec(`osascript -e 'display notification "💀 本局战败。 回放: ${replayLink}" with title "v51 Bot 结果"'`);
    } catch (e) {}

    // 自动连续排队: 稍等3秒后自动进入下一局匹配
    logMatchEvent(`🔄 正在自动准备下一局 1v1 匹配…`);
    setTimeout(() => startQueue(page), 3000);
  });

  // 在页面初始化时精准拦截 window.socket
  await page.addInitScript(() => {
    const checkSocket = setInterval(() => {
      const s = window.socket;
      if (s && s.connected && !s._v51Hooked) {
        s._v51Hooked = true;
        console.log('[browser] ✅ 成功精准挂载网页端 window.socket 实例!');
        s.on('game_start', (d) => window.bridgeGameStart(d));
        s.on('game_update', (d) => window.bridgeGameUpdate(d));
        s.on('game_won', () => window.bridgeGameWon());
        s.on('game_lost', () => window.bridgeGameLost());
        clearInterval(checkSocket);
      }
    }, 100);
  });

  console.log(`[headless] 正在通过初始链接访问 ${INITIAL_URL} …`);
  await page.goto(INITIAL_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // 设置凭据并重新刷新页面
  console.log(`[headless] 注入 localStorage 凭据并跳转回主页面关闭改名弹窗…`);
  await page.evaluate((uid) => {
    localStorage.setItem('user_id', uid);
    localStorage.setItem('email', 'justinzhouwuxi@gmail.com');
  }, USER_ID);
  
  await page.goto('https://generals.io/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.keyboard.press('Escape');

  logMatchEvent(`✅ 重新刷新主界面完成 (账号: zjxnb, user_id: ${USER_ID})`);
  await startQueue(page);
})();

async function startQueue(page) {
  try {
    logMatchEvent(`🔄 正在检查并确保返回主界面排队…`);
    
    // 检查是否在主界面，如果不在，强制跳转至初始链接并刷新
    const isMainMenu = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('*'));
      return !!btns.find(b => b.innerText && b.innerText.trim() === 'PLAY');
    });

    if (!isMainMenu) {
      logMatchEvent(`🌐 页面未在主界面，使用初始链接重新加载刷新…`);
      await page.goto(INITIAL_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await page.evaluate((uid) => {
        localStorage.setItem('user_id', uid);
        localStorage.setItem('email', 'justinzhouwuxi@gmail.com');
      }, USER_ID);
      await page.goto('https://generals.io/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await page.keyboard.press('Escape');
    }

    logMatchEvent(`🎮 执行网页端物理坐标精准点击 (PLAY -> 1v1 绿框按钮)…`);
    
    // 1. 点击主界面 PLAY 按钮
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('*'));
      const p = btns.find(b => b.innerText && b.innerText.trim() === 'PLAY');
      if (p) p.click();
    });

    await page.waitForTimeout(1000);

    // 2. 物理点击弹窗内 1v1 按钮的精确坐标 (614, 293)
    await page.mouse.click(614, 293);
    await page.waitForTimeout(1500);

    logMatchEvent(`✅ 已成功触发【Finding a match...】真实 1v1 匹配界面！`);

  } catch (e) {
    logMatchEvent(`⚠️ 排队点击出现异常: ${e.message}`);
  }
}
