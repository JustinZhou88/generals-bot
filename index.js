'use strict';

const { BotClient } = require('./src/client');

// ---------- 配置 ----------
// 1) USER_ID:随便一串你自己保密的字符串(相当于账号密码),建议用环境变量
// 2) USERNAME:官方要求 bot 用户名必须以 "[Bot] " 开头;同一 user_id 只能注册一次
const USER_ID = process.env.GENERALS_USER_ID || 'change_me_to_a_secret_string';
const USERNAME = process.env.GENERALS_USERNAME || '[Bot] MyStrategyBot';

// 命令行参数: --mode private|1v1|ffa   --game <自定义房间id>
function parseArgs() {
  const args = process.argv.slice(2);
  const out = { mode: 'private', gameId: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode') out.mode = args[++i];
    if (args[i] === '--game') out.gameId = args[++i];
  }
  return out;
}

const { mode, gameId } = parseArgs();

if (USER_ID === 'change_me_to_a_secret_string') {
  console.log('⚠️  请先设置 GENERALS_USER_ID 环境变量(或直接改 index.js 里的 USER_ID)');
  console.log('   例如: GENERALS_USER_ID=my_secret_123 GENERALS_USERNAME="[Bot] 小钢炮" node index.js --mode private --game test123');
}

const bot = new BotClient({ userId: USER_ID, username: USERNAME, mode, gameId });
bot.connect();
