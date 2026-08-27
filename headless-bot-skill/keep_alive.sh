#!/bin/bash
# 守护进程:每 30 秒检查 Bot 是否存活,不在就拉起。
#
# 为什么需要它:网络故障会把 Chrome 页面搞死,之后 Playwright 抛
# ProtocolError 导致 node 进程退出。没有守护的话就是静默停机
# (2026-07-30 凌晨曾因此停了 5.5 小时都没人发现)。
#
#   nohup ./keep_alive.sh >/dev/null 2>&1 &   # 启动守护
#   pkill -f keep_alive.sh                    # 停止守护(不会停 bot 本身)

set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/.bot.pid"
BOT_LOG="$DIR/bot.log"
KA_LOG="$DIR/keepalive.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$KA_LOG"; }

log "守护进程启动 (pid $$)"

while true; do
  PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -z "${PID:-}" ] || ! kill -0 "$PID" 2>/dev/null; then
    log "Bot 未运行,正在拉起…"
    rm -f "$PID_FILE"
    nohup node "$DIR/headless_bot.js" >> "$BOT_LOG" 2>&1 &
    sleep 15
    NEW=$(cat "$PID_FILE" 2>/dev/null || true)
    log "已启动 (pid ${NEW:-未知})"
  fi
  sleep 30
done
