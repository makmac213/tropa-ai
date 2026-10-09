#!/bin/bash
# Install or update tropa.
#   curl -fsSL https://raw.githubusercontent.com/makmac213/tropa-ai/main/install.sh | bash
# Options (env vars):
#   TROPA_VERSION=0.2.0   install a tagged version (default: latest release, else main)
#   TROPA_DIR=~/.tropa    where it is installed       BIN_DIR=...  where `tropa` is linked
#   TROPA_REPO=owner/repo GitHub repo to install from
set -e
REPO="${TROPA_REPO:-makmac213/tropa-ai}"
DIR="${TROPA_DIR:-$HOME/.tropa}"
VER="${TROPA_VERSION:-}"

say() { printf '%s\n' "$*"; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }
command -v curl >/dev/null || die "curl is required"
command -v tar  >/dev/null || die "tar is required"

if [ -n "$TROPA_ARCHIVE" ]; then VER="${VER:-local}"   # install from a local .tar.gz (testing)
elif [ -z "$VER" ]; then
    VER=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null |
          sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -1)
fi
if [ -n "$VER" ]; then URL="https://github.com/$REPO/archive/refs/tags/v$VER.tar.gz"; LABEL="$VER"
else URL="https://github.com/$REPO/archive/refs/heads/main.tar.gz"; LABEL="main"; fi

say "⬇️  Installing tropa ($LABEL) from $REPO"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
if [ -n "$TROPA_ARCHIVE" ]; then cp "$TROPA_ARCHIVE" "$TMP/tropa.tar.gz"; LABEL="$VER"
else curl -fsSL "$URL" -o "$TMP/tropa.tar.gz" || die "download failed: $URL (private repo? see README)"; fi
tar -xzf "$TMP/tropa.tar.gz" -C "$TMP"
SRC=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1)
[ -f "$SRC/tropa" ] || die "archive does not contain tropa"
chmod +x "$SRC/tropa" "$SRC/install.sh" "$SRC"/scripts/*.sh "$SRC"/kit/.agent_sync/*.sh "$SRC"/kit/.agent_sync/*.py 2>/dev/null || true

mkdir -p "$DIR/versions"
DEST="$DIR/versions/$LABEL"
# keep an existing node_modules so the Node fallback doesn't reinstall
[ -d "$DEST/server/node_modules" ] && mv "$DEST/server/node_modules" "$TMP/node_modules"
rm -rf "$DEST"; mv "$SRC" "$DEST"
[ -d "$TMP/node_modules" ] && mv "$TMP/node_modules" "$DEST/server/node_modules"
ln -sfn "$DEST" "$DIR/app"

if [ -z "$BIN_DIR" ]; then
    if [ -w /usr/local/bin ]; then BIN_DIR=/usr/local/bin
    elif [ -d /opt/homebrew/bin ] && [ -w /opt/homebrew/bin ]; then BIN_DIR=/opt/homebrew/bin
    else BIN_DIR="$HOME/.local/bin"; fi
fi
mkdir -p "$BIN_DIR"; ln -sf "$DIR/app/tropa" "$BIN_DIR/tropa"
say "✅ tropa $(cat "$DEST/VERSION" 2>/dev/null || echo "$LABEL") → $BIN_DIR/tropa"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "   Add to PATH:  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc && exec zsh";; esac

missing=""
for b in tmux python3; do command -v "$b" >/dev/null || missing="$missing $b"; done
if [ -n "$missing" ]; then
    if [ "$(uname)" = Darwin ]; then hint="brew install$missing"
    elif command -v apt-get >/dev/null; then hint="sudo apt-get install -y$missing"
    else hint="install$missing with your package manager"; fi
    say "⚠️  Also needed:$missing   ($hint)"
fi
command -v docker >/dev/null || command -v node >/dev/null || say "⚠️  Install Docker or Node ≥ 22.13 to run the TropaAI server"
say "   Start:  cd your-project && tropa init -p 8888"
