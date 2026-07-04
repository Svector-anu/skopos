#!/usr/bin/env bash
# Render the Skopos "shipped this week" social card to a 1920x1080 PNG.
# Requires Google Chrome. Usage: ./render.sh [output.png]
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$DIR/shipped-card.png}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

[ -x "$CHROME" ] || { echo "Google Chrome not found at $CHROME"; exit 1; }

"$CHROME" --headless=new --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1920,1080 --virtual-time-budget=4000 \
  --screenshot="$OUT" "file://$DIR/shipped-card.html" 2>/dev/null

echo "rendered → $OUT"
