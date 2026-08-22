#!/usr/bin/env bash
# Headless contact-sheet renderer for the Lena chibi avatar.
#
#   ./shot.sh                 -> avatar/contact-sheet.png
#   ./shot.sh out.png         -> custom output path
#   ./shot.sh out.png 1360 2600  -> custom viewport
#
# preview.html fetches lena.svg, so it must be served over http (file:// is
# blocked by the browser's same-origin policy). This script starts a throwaway
# static server on a free port, screenshots it, then tears the server down.
#
# Requires: python3 and either `npx playwright` (chromium) or a `chromium` binary.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$DIR/contact-sheet.png}"
VW="${2:-1360}"
VH="${3:-2600}"

PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$DIR" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  if python3 - "$PORT" <<'PY' 2>/dev/null; then break; fi
import socket,sys
s=socket.create_connection(("127.0.0.1",int(sys.argv[1])),0.2); s.close()
PY
  sleep 0.1
done

URL="http://127.0.0.1:$PORT/preview.html"

if npx --yes playwright@latest --version >/dev/null 2>&1; then
  npx --yes playwright@latest screenshot \
      --full-page --viewport-size="${VW},${VH}" --wait-for-timeout=1200 \
      "$URL" "$OUT"
elif command -v chromium >/dev/null 2>&1; then
  chromium --headless --disable-gpu --hide-scrollbars \
           --virtual-time-budget=4000 \
           --window-size="${VW},${VH}" --screenshot="$OUT" "$URL"
else
  echo "No chromium/playwright found. Try: npx playwright install chromium" >&2
  exit 1
fi
echo "wrote $OUT"
