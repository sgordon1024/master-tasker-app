#!/bin/zsh
# Run by launchd every 5 minutes. If the server is running but stops answering twice in a row
# (hung, not crashed: launchd already restarts crashes), restart it. Never touches anything else.
set -u
PORT="${MT_PORT:-4820}"
LABEL="local.master-tasker.server"
STATE="${MT_DATA_DIR:-$HOME/Library/Application Support/MasterTasker}/.healthcheck-failures"
LOG="${MT_LOG_DIR:-$HOME/Library/Logs/MasterTasker}/healthcheck.log"

# Keep this log small.
if [[ -f "$LOG" ]] && (( $(stat -f%z "$LOG") > 262144 )); then tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" | grep -q '"db":"ok"'; then
  rm -f "$STATE"
  exit 0
fi

fails=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
# Without its folder the count isn't saved, so it would never reach two.
mkdir -p "${STATE:h}"
echo "$fails" > "$STATE"
echo "$(ts) health check failed ($fails in a row)"
if (( fails >= 2 )); then
  echo "$(ts) restarting $LABEL"
  launchctl kickstart -k "gui/$(id -u)/$LABEL" && rm -f "$STATE"
fi
