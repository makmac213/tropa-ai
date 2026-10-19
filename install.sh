#!/bin/bash
# Install or update tropa, then start it and open it in your browser.
#   curl -fsSL https://raw.githubusercontent.com/makmac213/tropa-ai/main/install.sh | bash
# Options (env vars):
#   TROPA_VERSION=0.5.0   install a tagged version (default: latest release, else main)
#   TROPA_DIR=~/.tropa    where it is installed       BIN_DIR=...  where `tropa` is linked
#   TROPA_REPO=owner/repo GitHub repo to install from
#   TROPA_YES=1           install missing tools without asking      TROPA_NO_DEPS=1  don't install any
#   TROPA_NO_START=1      don't start TropaAI at the end             TROPA_PORT=8888  port to start it on (default: the one already in use, else 8888)
set -e
REPO="${TROPA_REPO:-makmac213/tropa-ai}"
DIR="${TROPA_DIR:-$HOME/.tropa}"
VER="${TROPA_VERSION:-}"
NODE_MIN="22.13"

say() { printf '%s\n' "$*"; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
OS=$(uname -s); ARCH=$(uname -m)
is_wsl() { [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; }
have curl || die "curl is required"
have tar  || die "tar is required"
# `curl | bash` reads the script from stdin, so questions go to the terminal
ask() {   # $1 question → 0 for yes
    [ -n "${TROPA_YES:-}" ] && return 0
    { [ -r /dev/tty ] && : </dev/tty; } 2>/dev/null || return 1
    printf '%s [Y/n] ' "$1" >/dev/tty; local a; read -r a </dev/tty || return 1
    case "$a" in ""|y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# ---------------------------------------------------------------- 1. tropa itself
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
chmod +x "$SRC/tropa" "$SRC/install.sh" "$SRC"/scripts/*.sh "$SRC"/kit/.agent_sync/*.sh "$SRC"/kit/.agent_sync/*.py "$SRC"/host/*.py 2>/dev/null || true

mkdir -p "$DIR/versions"
DEST="$DIR/versions/$LABEL"
# keep an existing node_modules so the server doesn't reinstall
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

# put BIN_DIR on the PATH of new terminals (once)
case ":$PATH:" in *":$BIN_DIR:"*) ;; *)
    case "${SHELL##*/}" in zsh) rc="$HOME/.zshrc" ;; bash) if [ "$OS" = Darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;; *) rc="$HOME/.profile" ;; esac
    line="export PATH=\"$BIN_DIR:\$PATH\"   # tropa"
    if ! grep -qsF "$line" "$rc"; then printf '\n%s\n' "$line" >>"$rc" && say "   Added $BIN_DIR to your PATH in ${rc/#$HOME/~} (for new terminals)."; fi
    export PATH="$BIN_DIR:$PATH" ;;
esac

# ---------------------------------------------------------------- 2. what it needs
node_ok() { have node && node -e "const [a,b]=process.versions.node.split('.').map(Number);const [x,y]='$NODE_MIN'.split('.').map(Number);process.exit(a>x||(a===x&&b>=y)?0:1)" 2>/dev/null; }
git_ok() { have git && git --version >/dev/null 2>&1; }   # macOS ships a stub that only opens an installer
install_node() {   # the official Node 22 LTS into ~/.tropa/node: no admin rights, no package manager
    local os arch base file sums want got
    case "$OS" in Darwin) os=darwin ;; Linux) os=linux ;; *) return 1 ;; esac
    case "$ARCH" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) return 1 ;; esac
    base="${TROPA_NODE_DIST:-https://nodejs.org/dist/latest-v22.x}"
    sums=$(curl -fsSL "$base/SHASUMS256.txt") || return 1
    file=$(printf '%s\n' "$sums" | awk -v f="-$os-$arch.tar.gz" '{ if (substr($2, length($2) - length(f) + 1) == f) { print $2; exit } }')
    [ -n "$file" ] || return 1
    say "⬇️  Node.js ($file)"
    curl -fsSL "$base/$file" -o "$TMP/$file" || return 1
    want=$(printf '%s\n' "$sums" | awk -v f="$file" '$2==f {print $1}')
    if have shasum; then got=$(shasum -a 256 "$TMP/$file" | awk '{print $1}'); else got=$(sha256sum "$TMP/$file" | awk '{print $1}'); fi
    [ -n "$want" ] && [ "$want" = "$got" ] || { say "❌ The Node.js download failed its checksum"; return 1; }
    rm -rf "$DIR/node" && mkdir -p "$DIR/node" && tar -xzf "$TMP/$file" -C "$DIR/node" --strip-components 1 || return 1
    export PATH="$DIR/node/bin:$PATH"
}
pm_install() {   # $@ packages, with the system's package manager
    if [ "$OS" = Darwin ]; then
        have brew || { say "   Homebrew is needed for: $*  →  https://brew.sh (then run this installer again)"; return 1; }
        brew install "$@"
    elif have apt-get; then sudo apt-get update -qq && sudo apt-get install -y "$@"
    elif have dnf; then sudo dnf install -y "$@"
    elif have pacman; then sudo pacman -S --needed --noconfirm "$@"
    elif have zypper; then sudo zypper install -y "$@"
    elif have apk; then sudo apk add "$@"
    else say "   Install with your package manager: $*"; return 1; fi
}
[ -x "$DIR/node/bin/node" ] && export PATH="$DIR/node/bin:$PATH"
pkgs=""
have tmux || pkgs="$pkgs tmux"
have python3 || pkgs="$pkgs python3"
if ! git_ok; then
    if [ "$OS" = Darwin ]; then say "⚠️  git isn't installed (the team uses it for branches). Install Apple's Command Line Tools: xcode-select --install"
    else pkgs="$pkgs git"; fi
fi
need_node=0; node_ok || need_node=1
if [ -n "${TROPA_NO_DEPS:-}" ]; then
    [ -n "$pkgs" ] && say "⚠️  Also needed:$pkgs"
    [ "$need_node" = 1 ] && say "⚠️  Also needed: Node.js ≥ $NODE_MIN (or Docker)"
elif [ -n "$pkgs" ] || [ "$need_node" = 1 ]; then
    say ""
    say "tropa needs:${pkgs}$( [ "$need_node" = 1 ] && echo " Node.js≥$NODE_MIN")"
    if ask "Install them now?"; then
        if [ -n "$pkgs" ]; then pm_install $pkgs || say "⚠️  Couldn't install:$pkgs"; fi
        if [ "$need_node" = 1 ]; then
            if install_node; then say "✅ Node.js $(node --version) in ${DIR/#$HOME/~}/node"
            else say "⚠️  Couldn't install Node.js: get it from https://nodejs.org (or use Docker)"; fi
        fi
    else
        say "   Skipped. Install them yourself, then run: tropa start"
    fi
fi

# ---------------------------------------------------------------- 3. agent CLIs (a hint only; the Setup page in the browser checks them)
if ! have claude; then
    say ""
    say "💡 Claude Code isn't installed. New projects are set up by chatting with it (your agents can use any CLI):"
    say "   curl -fsSL https://claude.ai/install.sh | bash      then run 'claude' once to sign in"
fi

# ---------------------------------------------------------------- 4. start it
missing=""; have tmux || missing="$missing tmux"; have python3 || missing="$missing python3"
if [ -n "${TROPA_NO_START:-}" ]; then
    say "   Start it with: tropa start"
elif [ -n "$missing" ]; then
    say "⚠️  Can't start yet:$missing missing. Install it, then run: tropa start"
elif ! node_ok && ! { have docker && docker info >/dev/null 2>&1; }; then
    say "⚠️  Can't start yet: needs Node.js ≥ $NODE_MIN or Docker. Then run: tropa start"
else
    say ""
    "$BIN_DIR/tropa" start ${TROPA_PORT:+-p "$TROPA_PORT"} || say "⚠️  Start it later with: tropa start"
fi
say ""
say "Next time: tropa start  ·  stop: tropa stop  ·  start when you log in: tropa autostart on"
