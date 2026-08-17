#!/bin/sh
# KB installer (macOS / Linux): sets up the repo and puts `kb` on your PATH.
# Run from a clone of this repo:  ./install.sh
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "KB installer"
echo "============"

# ── prerequisites ─────────────────────────────────────────────────────────────
missing=0
for cmd in node pnpm docker; do
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "  ✓ $cmd $($cmd --version 2>/dev/null | head -1)"
  else
    echo "  ✗ $cmd not found"
    missing=1
  fi
done
if [ "$missing" = 1 ]; then
  echo ""
  echo "Install the missing tools first:"
  echo "  node   → https://nodejs.org (v18+)"
  echo "  pnpm   → corepack enable   (ships with node)"
  echo "  docker → https://docs.docker.com/get-docker/"
  exit 1
fi

# ── dependencies + build ──────────────────────────────────────────────────────
echo ""
echo "Installing dependencies…"
pnpm install
echo "Building packages…"
pnpm --filter @kb/db exec prisma generate   # must precede tsc: builds use the generated client's types
pnpm -r --filter './packages/*' build

# ── .env ──────────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "  Created .env from .env.example — EDIT IT before first use"
  echo "  (LLM_PROVIDER / OLLAMA_BASE_URL / EMBEDDING_DIMENSIONS must match the HEAD PC)"
fi

# ── link `kb` onto PATH ───────────────────────────────────────────────────────
BIN_DIR="${KB_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"
chmod +x "$ROOT/bin/kb.mjs"
ln -sf "$ROOT/bin/kb.mjs" "$BIN_DIR/kb"
echo ""
echo "  Linked $BIN_DIR/kb → bin/kb.mjs"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "  ⚠ $BIN_DIR is not on your PATH — add this to your shell profile:"
     echo "      export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

echo ""
echo "Done. Next steps:"
echo "  kb serve                  # start the local stack (Postgres + API)"
echo "  kb sync <your-repos-dir>  # bootstrap the index from the HEAD PC"
echo "  kb watch <your-repos-dir> # keep it in sync with your branches"
echo "  kb --help                 # everything else"
