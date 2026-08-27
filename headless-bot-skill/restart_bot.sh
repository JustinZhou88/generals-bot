#!/bin/bash
# 安全重启 Bot:确认「不在对局中」后立即重启,避免把正在进行的比赛打断判负。
#
# 人工先检查再手动 kill 的做法不可靠 —— 检查与执行之间哪怕隔十几秒,
# 都可能刚好卡在匹配成功的瞬间。这里把「检查 → kill」压在同一个循环迭代里。
#
#   ./restart_bot.sh          # 等待当前对局结束后重启
#   ./restart_bot.sh --force  # 不等待,立即重启(会判负)

set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/.bot.pid"
STATUS_JSON="$DIR/live_status.json"
LOG="$DIR/bot.log"
FORCE="${1:-}"

if [ "$FORCE" != "--force" ]; then
  echo "⏳ 等待当前对局结束(每 3 秒检查一次,Ctrl-C 可中止)…"
  while true; do
    phase=$(sed -n 's/.*"phase": *"\([a-z_]*\)".*/\1/p' "$STATUS_JSON" 2>/dev/null | head -1)
    [ "$phase" != "in_game" ] && break
    sleep 3
  done
fi

# 检查通过后立刻动手,不留窗口
OLD=$(cat "$PID_FILE" 2>/dev/null)
if [ -n "$OLD" ]; then
  kill -9 "$OLD" 2>/dev/null && echo "🛑 已停止旧实例 (pid $OLD)"
fi
rm -f "$PID_FILE"
sleep 1

nohup node "$DIR/headless_bot.js" >> "$LOG" 2>&1 &
sleep 2
NEW=$(cat "$PID_FILE" 2>/dev/null)
echo "🚀 新实例已启动 (pid ${NEW:-未知})，日志: $LOG"
