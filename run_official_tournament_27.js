'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NUM_BOTS = 27;
const RESULTS_FILE = path.join(__dirname, 'official_bo3_tournament_27.json');
const CONCURRENCY = 1; // 1 match at a time using registered accounts

// Track all active child processes for cleanup
const activeChildren = new Set();

function cleanupChildren() {
  for (const child of activeChildren) {
    try { child.kill('SIGKILL'); } catch(e) {}
  }
  activeChildren.clear();
}

// Ensure children are killed when parent exits
process.on('SIGTERM', () => { cleanupChildren(); process.exit(1); });
process.on('SIGINT', () => { cleanupChildren(); process.exit(1); });
process.on('exit', () => { cleanupChildren(); });

// Initialize or load state
let tournamentData = {
  pairingsCompleted: 0,
  totalPairings: (NUM_BOTS * (NUM_BOTS - 1)) / 2,
  pairingResults: {}, // key: "i_vs_j", value: { winner, seriesScore: [wA, wB], games: [...] }
  botStats: {} // key: "v1".."v27", value: { seriesWins: 0, seriesLosses: 0, gameWins: 0, gameLosses: 0 }
};

for (let b = 1; b <= NUM_BOTS; b++) {
  tournamentData.botStats[`v${b}`] = { seriesWins: 0, seriesLosses: 0, gameWins: 0, gameLosses: 0 };
}

if (fs.existsSync(RESULTS_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
    tournamentData = Object.assign(tournamentData, saved);
    console.log(`Loaded saved tournament data: ${tournamentData.pairingsCompleted}/${tournamentData.totalPairings} pairings completed.`);
  } catch (e) {
    console.error('Failed to parse existing results file, starting fresh.');
  }
}

// Generate queue of pairings
const queue = [];
for (let i = 1; i <= NUM_BOTS; i++) {
  for (let j = i + 1; j <= NUM_BOTS; j++) {
    const key = `${i}_vs_${j}`;
    if (!tournamentData.pairingResults[key] || tournamentData.pairingResults[key].status !== 'completed') {
      queue.push({ vA: i, vB: j, key });
    }
  }
}

function saveResults() {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(tournamentData, null, 2));
}

function updateStats() {
  // Reset
  for (let b = 1; b <= NUM_BOTS; b++) {
    tournamentData.botStats[`v${b}`] = { seriesWins: 0, seriesLosses: 0, gameWins: 0, gameLosses: 0 };
  }
  for (const key in tournamentData.pairingResults) {
    const res = tournamentData.pairingResults[key];
    if (res.status === 'completed') {
      const [vA, vB] = key.split('_vs_').map(x => parseInt(x));
      const [wA, wB] = res.seriesScore;
      tournamentData.botStats[`v${vA}`].gameWins += wA;
      tournamentData.botStats[`v${vA}`].gameLosses += wB;
      tournamentData.botStats[`v${vB}`].gameWins += wB;
      tournamentData.botStats[`v${vB}`].gameLosses += wA;
      if (wA > wB) {
        tournamentData.botStats[`v${vA}`].seriesWins += 1;
        tournamentData.botStats[`v${vB}`].seriesLosses += 1;
      } else {
        tournamentData.botStats[`v${vB}`].seriesWins += 1;
        tournamentData.botStats[`v${vA}`].seriesLosses += 1;
      }
    }
  }
}

function printLeaderboard() {
  updateStats();
  const sorted = Object.keys(tournamentData.botStats).map(v => {
    const st = tournamentData.botStats[v];
    const totalSeries = st.seriesWins + st.seriesLosses;
    const seriesWinRate = totalSeries > 0 ? ((st.seriesWins / totalSeries) * 100).toFixed(1) : '0.0';
    return {
      version: v,
      ...st,
      totalSeries,
      seriesWinRate: parseFloat(seriesWinRate)
    };
  }).sort((a, b) => b.seriesWins - a.seriesWins || b.gameWins - a.gameWins);

  console.log('\n================ 🏆 官方服务器 BO3 大循环赛最新排行榜 🏆 ================');
  console.log(' 排名 | 版本   | 系列赛 (胜-负) | 系列战率 (%) | 单局 (胜-负) | 单局胜率');
  console.log('-----------------------------------------------------------------------');
  sorted.forEach((item, idx) => {
    const rankStr = `#${idx + 1}`.padEnd(4);
    const verStr = item.version.padEnd(6);
    const sWinStr = `${item.seriesWins}胜-${item.seriesLosses}负`.padEnd(12);
    const sRateStr = `${item.seriesWinRate}%`.padEnd(12);
    const gWinStr = `${item.gameWins}胜-${item.gameLosses}负`.padEnd(12);
    const totalGames = item.gameWins + item.gameLosses;
    const gRateStr = totalGames > 0 ? `${((item.gameWins / totalGames) * 100).toFixed(1)}%` : '0.0%';
    console.log(` ${rankStr} | ${verStr} | ${sWinStr} | ${sRateStr} | ${gWinStr} | ${gRateStr}`);
  });
  console.log('================-------------------------------------------------------\n');
}

// Run single BO3 pairing
function runPairing(vA, vB, key) {
  return new Promise((resolve) => {
    const roomName = `bo3_v${vA}_v${vB}_${Date.now().toString(36).slice(-4)}`;
    console.log(`\n▶️ 开始 BO3 对决: v${vA} vs v${vB} (房间: ${roomName})`);
    
    let wA = 0;
    let wB = 0;
    const games = [];

    function nextGame() {
      if (wA >= 2 || wB >= 2) {
        // Pairing finished!
        const winner = wA >= 2 ? `v${vA}` : `v${vB}`;
        console.log(`✅ BO3 对决结束: v${vA} vs v${vB} | 结果: ${winner} 获胜 (${wA}-${wB})`);
        tournamentData.pairingResults[key] = {
          status: 'completed',
          seriesScore: [wA, wB],
          winner,
          games
        };
        tournamentData.pairingsCompleted += 1;
        saveResults();
        printLeaderboard();
        return resolve();
      }

      const gameNum = games.length + 1;
      console.log(`  🎮 运行第 ${gameNum} 局 (v${vA} [${wA}] vs v${vB} [${wB}])...`);

      // Spawn process for Bot A
      const envA = Object.assign({}, process.env, {
        GENERALS_USER_ID: `syndrome_bot`,
        GENERALS_USERNAME: `[Bot] syndrome_bot`,
        STRATEGY_FILE: `./strategy_v${vA}.js`,
        SINGLE_GAME: 'true'
      });
      const childA = spawn('node', ['index.js', '--mode', 'private', '--game', roomName], { env: envA, cwd: __dirname });
      activeChildren.add(childA);

      // Spawn process for Bot B
      const envB = Object.assign({}, process.env, {
        GENERALS_USER_ID: `syndrome_bot_b`,
        GENERALS_USERNAME: `[Bot] Bot_B`,
        STRATEGY_FILE: `./strategy_v${vB}.js`,
        SINGLE_GAME: 'true'
      });
      const childB = spawn('node', ['index.js', '--mode', 'private', '--game', roomName], { env: envB, cwd: __dirname });
      activeChildren.add(childB);

      let replayUrl = '';
      let allOutputA = '';
      let allOutputB = '';

      function collectOutput(dataStr) {
        const replayMatch = dataStr.match(/https:\/\/bot\.generals\.io\/replays\/[A-Za-z0-9_-]+/);
        if (replayMatch && !replayUrl) {
          replayUrl = replayMatch[0];
        }
      }

      childA.stdout.on('data', (d) => { const s = d.toString(); allOutputA += s; collectOutput(s); });
      childA.stderr.on('data', (d) => { const s = d.toString(); allOutputA += s; collectOutput(s); });
      childB.stdout.on('data', (d) => { const s = d.toString(); allOutputB += s; collectOutput(s); });
      childB.stderr.on('data', (d) => { const s = d.toString(); allOutputB += s; collectOutput(s); });

      let finished = false;
      let exitCodeA = null;
      let exitCodeB = null;

      const timeout = setTimeout(() => {
        if (!finished) {
          finished = true;
          childA.kill('SIGKILL');
          childB.kill('SIGKILL');
          console.log(`  ⚠️ 第 ${gameNum} 局超时(5分钟)，重新尝试本局...`);
          setTimeout(nextGame, 3000);
        }
      }, 300000); // 5 min timeout per game

      function tryResolve() {
        if (finished) return;
        if (exitCodeA === null || exitCodeB === null) return; // wait for both

        finished = true;
        clearTimeout(timeout);

        // Exit code 0 = winner, 42 = loser
        let winnerThisGame = null;
        if (exitCodeA === 0 && exitCodeB === 42) {
          winnerThisGame = `v${vA}`;
          wA++;
        } else if (exitCodeB === 0 && exitCodeA === 42) {
          winnerThisGame = `v${vB}`;
          wB++;
        } else {
          // Fallback: check stdout for '胜利'
          if (allOutputA.includes('🏆 胜利!') && !allOutputB.includes('🏆 胜利!')) {
            winnerThisGame = `v${vA}`;
            wA++;
          } else if (allOutputB.includes('🏆 胜利!') && !allOutputA.includes('🏆 胜利!')) {
            winnerThisGame = `v${vB}`;
            wB++;
          } else {
            console.log(`  ⚠️ 第 ${gameNum} 局未判定胜负 (exitA=${exitCodeA}, exitB=${exitCodeB})，重新尝试本局...`);
            setTimeout(nextGame, 3000);
            return;
          }
        }

        console.log(`  🏁 第 ${gameNum} 局完成 | 胜者: ${winnerThisGame} | Replay: ${replayUrl}`);
        games.push({ gameNum, winner: winnerThisGame, replayUrl });
        setTimeout(nextGame, 2000);
      }

      childA.on('exit', (code) => { exitCodeA = code; activeChildren.delete(childA); tryResolve(); });
      childB.on('exit', (code) => { exitCodeB = code; activeChildren.delete(childB); tryResolve(); });
    }

    nextGame();
  });
}

// Queue Worker Loop
async function startTournament() {
  console.log(`🚀 启动官方服务器 27-Bot 循环赛 (BO3 三局两胜制)`);
  console.log(`总 Pairing 组数: ${tournamentData.totalPairings} | 剩余未完成: ${queue.length}`);

  let running = 0;

  function next() {
    if (queue.length === 0 && running === 0) {
      console.log('\n🎉🎉🎉 全 27 个 Bot 官方服务器 BO3 大循环赛全部完成！ 🎉🎉🎉');
      printLeaderboard();
      process.exit(0);
    }

    while (running < CONCURRENCY && queue.length > 0) {
      const item = queue.shift();
      running++;
      runPairing(item.vA, item.vB, item.key).then(() => {
        running--;
        next();
      });
    }
  }

  next();
}

startTournament();
