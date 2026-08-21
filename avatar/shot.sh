#!/usr/bin/env bash
# Serve avatar/ over http and screenshot preview.html headlessly.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
SHELL_BIN="$HOME/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell"
OUT="${1:-$DIR/_shots/latest.png}"
mkdir -p "$(dirname "$OUT")"
PORT="${PORT:-8731}"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$DIR" >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/preview.html" -o /dev/null && break; sleep 0.1; done
"$SHELL_BIN" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --virtual-time-budget=2000 --default-background-color=00000000 \
  --window-size=1560,1500 --screenshot="$OUT" "http://127.0.0.1:$PORT/preview.html" >/dev/null 2>&1
echo "$OUT"
