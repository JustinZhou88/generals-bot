'use strict';

/**
 * 统一跑步器:把 KEY=VAL 参数写入 process.env 后运行白名单内的项目脚本。
 * 目的:让所有调参/评估只需一条权限白名单条目 `Bash(node tools/run.js *)`,
 * 不再因 env 前缀变化反复弹授权。
 *
 * 用法: node tools/run.js [KEY=VAL ...] <脚本名> [脚本参数...]
 * 例:  node tools/run.js DGOAL_W=0.5 EXPAND_REACH=8 scorecard --bot 10
 *      node tools/run.js opening
 *      node tools/run.js PAUSE_OFF=1 ab-v25        (自定义对战脚本也可入白名单)
 *
 * 安全:只允许运行下方 SCRIPTS 白名单里的脚本(全部是仓库内的分析/测试脚本),
 * 不能执行任意代码;KEY 仅限大写字母/数字/下划线。
 */

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = {
  sim: 'test/sim.js',
  opening: 'opening_test.js',
  arena: 'arena.js',
  defense: 'defense_test.js',
  discover: 'discover_test.js',
  eff: 'eff_test.js',
  reach: 'reach_test.js',
  sniper: 'sniper_test.js',
  scorecard: 'replays/scorecard.js',
  'metric-stepeff': 'replays/metric_stepeff.js',
  'metric-aggression': 'replays/metric_aggression.js',
  'metric-city': 'replays/metric_city_econ.js',
  'metric-territory': 'replays/metric_territory.js',
  'metric-mainforce': 'replays/metric_mainforce.js',
  'metric-botcheck': 'replays/metric_botcheck.js',
  'metric-concentration': 'replays/metric_concentration.js',
  'im-extract': 'replays/imitation/extract2.js',
  'im-train': 'replays/imitation/train2.js',
  'im-smoke': 'replays/imitation/smoke.js',
  'im-eval': 'replays/imitation/eval.js',
  'im-parity': 'replays/imitation/parity2.js',
};

const argv = process.argv.slice(2);
const env = { ...process.env };
let i = 0;
while (i < argv.length && /^[A-Z][A-Z0-9_]*=/.test(argv[i])) {
  const eq = argv[i].indexOf('=');
  env[argv[i].slice(0, eq)] = argv[i].slice(eq + 1);
  i++;
}
const name = argv[i];
if (!name || !SCRIPTS[name]) {
  console.log('用法: node tools/run.js [KEY=VAL ...] <脚本> [参数...]');
  console.log('可用脚本: ' + Object.keys(SCRIPTS).join(' '));
  process.exit(name ? 1 : 0);
}
const scriptRel = SCRIPTS[name];
// scorecard/metric 系脚本约定在 replays/ 目录下运行
const cwd = scriptRel.startsWith('replays/') ? path.join(ROOT, 'replays') : ROOT;
const scriptPath = path.join(ROOT, scriptRel);
const r = spawnSync(process.execPath, [scriptPath, ...argv.slice(i + 1)], {
  cwd, env, stdio: 'inherit',
});
process.exit(r.status === null ? 1 : r.status);
