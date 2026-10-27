#!/bin/sh
# Installs the azaad command for the current user.
#   curl -fsSL https://sehajr-singhs.github.io/azaadai-web/install.sh | sh
set -e
SITE="https://sehajr-singhs.github.io/azaadai-web"
DIR="$HOME/.azaad/bin"
BIN="$HOME/.local/bin"
mkdir -p "$DIR" "$BIN"

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "Python 3.9+ is required." >&2; exit 1; }

curl -fsSL "$SITE/azaad.py" -o "$DIR/azaad.py"
printf '#!/bin/sh\nexec %s "%s/azaad.py" "$@"\n' "$PY" "$DIR" > "$BIN/azaad"
chmod +x "$BIN/azaad"

echo ""
echo "azaad installed to $BIN/azaad"
case ":$PATH:" in
  *":$BIN:"*) echo "Run: azaad" ;;
  *) echo "Add $BIN to your PATH, then run: azaad" ;;
esac
