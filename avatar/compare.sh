#!/usr/bin/env bash
# Render lena.svg at 512 and slam it next to the reference bust crop.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
SHELL_BIN="$HOME/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell"
OUT="${1:-$DIR/_shots/compare.png}"
mkdir -p "$(dirname "$OUT")"
cat > "$DIR/_shots/_solo.html" <<'HTML'
<!doctype html><html><body style="margin:0;background:#fff">
<img src="../lena.svg" width="512" height="512">
</body></html>
HTML
PORT=8734
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$DIR" >/dev/null 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/_shots/_solo.html" -o /dev/null && break; sleep 0.1; done
"$SHELL_BIN" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --virtual-time-budget=1500 --window-size=512,512 --screenshot="$DIR/_shots/_mine.png" \
  "http://127.0.0.1:$PORT/_shots/_solo.html" >/dev/null 2>&1
magick "$DIR/_shots/_mine.png" "$DIR/reference-bust.png" +append -bordercolor '#20242e' -border 6 "$OUT"
echo "$OUT"
