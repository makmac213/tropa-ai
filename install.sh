#!/bin/bash
# Install or update tropa, then start it and open it in your browser.
#   curl -fsSL https://raw.githubusercontent.com/makmac213/tropa-ai/main/install.sh | bash
#
# It checks the computer first and installs what TropaAI needs (asking once), and only then
# installs tropa itself, so a missing tool never leaves a half-working install behind.
#
# Options (env vars):
#   TROPA_VERSION=0.5.0   install a tagged version (default: latest release, else main)
#   TROPA_DIR=~/.tropa    where it is installed       BIN_DIR=...  where `tropa` is linked
#   TROPA_REPO=owner/repo GitHub repo to install from
#   TROPA_YES=1           install missing tools without asking      TROPA_NO_DEPS=1  don't install any (and don't stop for them)
#   TROPA_CLI=claude|opencode|both|none   which AI agent to install if there's none (default: ask; with TROPA_YES, claude)
#   TROPA_NO_START=1      don't start TropaAI at the end             TROPA_PORT=8888  port to start it on (default: the one already in use, else 8888)
# (macOS bash 3.2 compatible)
set -e
REPO="${TROPA_REPO:-makmac213/tropa-ai}"
DIR="${TROPA_DIR:-$HOME/.tropa}"
VER="${TROPA_VERSION:-}"
NODE_MIN="22.13"
PY_MIN="3.8"

say()  { printf '%s\n' "$*"; }
die()  { printf '\n❌ %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
step() { say ""; say "━━━ Step $1 of 4 · $2"; say ""; }
good() { say "  ✅ $*"; }
bad()  { say "  ❌ $*"; }
info() { say "     $*"; }
OS=$(uname -s); ARCH=$(uname -m)
case "$OS" in Darwin|Linux) ;; *) die "TropaAI runs on macOS, Linux, and Windows through WSL. On Windows, use the PowerShell installer from the README." ;; esac
tty_ok() { { [ -r /dev/tty ] && : </dev/tty; } 2>/dev/null; }
# `curl | bash` reads the script from stdin, so questions go to the terminal
ask() {   # $1 question → 0 for yes
    [ -n "${TROPA_YES:-}" ] && return 0
    tty_ok || return 1
    printf '%s [Y/n] ' "$1" >/dev/tty; local a; read -r a </dev/tty || return 1
    case "$a" in ""|y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}
have curl || die "curl is needed to download TropaAI. Install it with your package manager, then run this again."
have tar  || die "tar is needed to unpack TropaAI. Install it with your package manager, then run this again."
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# tools installed earlier in this run (or by an earlier run) must be found right away
for d in "$DIR/node/bin" "$HOME/.local/bin" "$HOME/.opencode/bin" /opt/homebrew/bin /usr/local/bin; do
    [ -d "$d" ] && case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH" ;; esac
done
export PATH

say ""
say "👋 Setting up TropaAI on this $( [ "$OS" = Darwin ] && echo Mac || echo computer )."
say "   1. check what's already installed   2. install what's missing (it asks first)"
say "   3. install TropaAI                  4. open it in your browser"
say "   It usually takes 5–10 minutes. You can stop it any time with Ctrl+C and run it again later."

# ================================================================ 1. check the computer
node_ok()   { have node && node -e "const [a,b]=process.versions.node.split('.').map(Number);const [x,y]='$NODE_MIN'.split('.').map(Number);process.exit(a>x||(a===x&&b>=y)?0:1)" 2>/dev/null; }
docker_ok() { have docker && docker info >/dev/null 2>&1; }
clt_ok()    { [ "$OS" != Darwin ] || xcode-select -p >/dev/null 2>&1; }   # Apple's Command Line Tools: git and python3 on a Mac
git_ok()    { clt_ok && have git && git --version >/dev/null 2>&1; }     # (without them, macOS's git is a stub that opens an installer)
py_ok()     { clt_ok && have python3 && python3 -c "import sys; sys.exit(sys.version_info < tuple(map(int, '$PY_MIN'.split('.'))))" 2>/dev/null; }
tmux_ok()   { have tmux; }
brew_ok()   { have brew; }
AGENT_CLIS="claude opencode codex qwen gemini"
agent_ok()  { local c; for c in $AGENT_CLIS; do have "$c" && return 0; done; return 1; }
agents_found() { local c out=""; for c in $AGENT_CLIS; do have "$c" && out="$out $c"; done; printf '%s' "${out# }"; }

need=""     # what's missing, in install order
check() {
    need=""
    if [ "$OS" = Darwin ]; then
        if clt_ok; then good "Apple Command Line Tools (git and Python)"
        else bad "Apple Command Line Tools: the team uses git to share work, and TropaAI's helpers run on Python"; need="$need clt"; fi
    fi
    if git_ok; then good "git $(git --version | awk '{print $3}')"
    elif [ "$OS" != Darwin ] || clt_ok; then bad "git: the team uses it to share and review work"; need="$need git"; fi
    if py_ok; then good "Python $(python3 -c 'import platform; print(platform.python_version())')"
    elif [ "$OS" != Darwin ] || clt_ok; then bad "Python $PY_MIN or newer: TropaAI's helpers run on it"; need="$need python3"; fi
    if tmux_ok; then good "tmux $(tmux -V | awk '{print $2}')"
    else
        bad "tmux: keeps each agent running in its own window"
        if [ "$OS" = Darwin ] && ! brew_ok; then info "(installed with Homebrew, which isn't on this Mac yet: it's installed first)"; need="$need brew"; fi
        need="$need tmux"
    fi
    if node_ok; then good "Node.js $(node --version)"
    elif docker_ok; then good "Docker (runs the chat server instead of Node.js)"
    else bad "Node.js $NODE_MIN or newer: runs the chat"; need="$need node"; fi
    if agent_ok; then good "AI agent: $(agents_found)"
    else bad "An AI agent (Claude Code, OpenCode, Codex, Qwen Code or Gemini CLI): it does the work"; need="$need agent"; fi
}
needs() { case " $need " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
label() {   # plain names for the summary
    local out="" x
    for x in $need; do case "$x" in
        clt) out="$out, Apple Command Line Tools" ;; brew) out="$out, Homebrew" ;; python3) out="$out, Python" ;;
        node) out="$out, Node.js" ;; agent) out="$out, an AI agent" ;; *) out="$out, $x" ;; esac; done
    out="${out#, }"
    case "$out" in *", "*) out="${out%, *} and ${out##*, }" ;; esac   # "a, b and c"
    printf '%s' "$out"
}

step 1 "Checking this computer"
check
[ -z "$need" ] && { say ""; say "  Everything TropaAI needs is already here."; }

# ================================================================ 2. install what's missing
install_clt() {   # Apple's installer runs in its own window: start it and wait for it
    xcode-select --install >/dev/null 2>&1 || true
    say "  🍎 A window from Apple should appear: click Install (and Agree). It takes a few minutes."
    say "     This waits for it to finish. If no window appeared, open System Settings → General → Software Update."
    local n=0
    until xcode-select -p >/dev/null 2>&1 && git --version >/dev/null 2>&1; do
        sleep 5; n=$((n + 1))
        [ $((n % 12)) = 0 ] && say "     …still waiting for Apple's installer ($((n / 12)) min)"
        [ "$n" -ge 720 ] && { bad "Apple's installer didn't finish within an hour."; return 1; }
    done
    good "Apple Command Line Tools installed"
}
install_brew() {   # the official Homebrew installer; it asks for your password itself
    if ! id -Gn 2>/dev/null | grep -qw admin; then
        bad "Homebrew needs an administrator account, and $(id -un) isn't one."
        info "Ask whoever manages this Mac to install Homebrew (https://brew.sh), or log in as an administrator, then run this again."
        return 1
    fi
    say "  🍺 Installing Homebrew (the usual way to add tools to a Mac). Enter your Mac password when asked."
    sudo -v </dev/tty || return 1   # ask once here; the installer then runs without stopping for questions
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty || return 1
    local b; for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && { eval "$("$b" shellenv)"; break; }; done
    brew_ok || return 1
    local line="eval \"\$($(command -v brew) shellenv)\"   # Homebrew (added by the tropa installer)"
    grep -qsF "$line" "$HOME/.zprofile" || printf '\n%s\n' "$line" >>"$HOME/.zprofile"
    good "Homebrew installed"
}
pm_install() {   # $@ packages, with the system's package manager (sudo unless already root)
    local SUDO=sudo; [ "$(id -u)" = 0 ] && SUDO=""
    if [ "$OS" = Darwin ]; then brew install "$@"
    elif have apt-get; then $SUDO apt-get update -qq && $SUDO apt-get install -y "$@"
    elif have dnf; then $SUDO dnf install -y "$@"
    elif have pacman; then $SUDO pacman -S --needed --noconfirm "$@"
    elif have zypper; then $SUDO zypper install -y "$@"
    elif have apk; then $SUDO apk add "$@"
    else bad "No package manager found (apt, dnf, pacman, zypper or apk). Install these yourself: $*"; return 1; fi
}
install_node() {   # the official Node 22 LTS into ~/.tropa/node: no admin rights, no package manager
    local os arch base file sums want got
    case "$OS" in Darwin) os=darwin ;; Linux) os=linux ;; *) return 1 ;; esac
    case "$ARCH" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) return 1 ;; esac
    base="${TROPA_NODE_DIST:-https://nodejs.org/dist/latest-v22.x}"
    sums=$(curl -fsSL "$base/SHASUMS256.txt") || return 1
    file=$(printf '%s\n' "$sums" | awk -v f="-$os-$arch.tar.gz" '{ if (substr($2, length($2) - length(f) + 1) == f) { print $2; exit } }')
    [ -n "$file" ] || return 1
    say "  ⬇️  Node.js ($file), just for TropaAI: no password needed"
    curl -fsSL "$base/$file" -o "$TMP/$file" || return 1
    want=$(printf '%s\n' "$sums" | awk -v f="$file" '$2==f {print $1}')
    if have shasum; then got=$(shasum -a 256 "$TMP/$file" | awk '{print $1}'); else got=$(sha256sum "$TMP/$file" | awk '{print $1}'); fi
    [ -n "$want" ] && [ "$want" = "$got" ] || { bad "The Node.js download failed its checksum"; return 1; }
    rm -rf "$DIR/node" && mkdir -p "$DIR/node" && tar -xzf "$TMP/$file" -C "$DIR/node" --strip-components 1 || return 1
    export PATH="$DIR/node/bin:$PATH"
    good "Node.js $(node --version) (in ${DIR/#$HOME/\~}/node)"
}
pick_agent() {   # which AI agent to install: claude | opencode | both | none
    local c="${TROPA_CLI:-}"
    if [ -z "$c" ]; then
        if [ -n "${TROPA_YES:-}" ] || ! tty_ok; then c=claude
        else
            say "  Which AI agent do you want to use? You can add others later." >/dev/tty
            say "     1) Claude Code: Anthropic's agent. Needs a Claude subscription or an Anthropic API key." >/dev/tty
            say "     2) OpenCode: works with many providers, including free models." >/dev/tty
            say "     3) Both" >/dev/tty
            printf '  Choose 1, 2 or 3 [1]: ' >/dev/tty; local a; read -r a </dev/tty || a=1
            case "$a" in 2) c=opencode ;; 3) c=both ;; *) c=claude ;; esac
        fi
    fi
    printf '%s' "$c"
}
installed_now=""
install_agent() {
    local c ok=1; c=$(pick_agent)
    case "$c" in none) return 0 ;; esac
    if [ "$c" = claude ] || [ "$c" = both ]; then
        say "  ⬇️  Claude Code (Anthropic's official installer)"
        if curl -fsSL https://claude.ai/install.sh | bash; then export PATH="$HOME/.local/bin:$PATH"; have claude && { good "Claude Code installed (ignore any note above about PATH: tropa adds it for you)"; installed_now="$installed_now claude"; ok=0; }; fi
    fi
    if [ "$c" = opencode ] || [ "$c" = both ]; then
        say "  ⬇️  OpenCode (its official installer)"
        if curl -fsSL https://opencode.ai/install | bash; then export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"; have opencode && { good "OpenCode installed"; installed_now="$installed_now opencode"; ok=0; }; fi
    fi
    return $ok
}
how_to() {   # what to do by hand for each thing still missing
    local x
    for x in $need; do case "$x" in
        clt)     info "• Apple Command Line Tools: run  xcode-select --install  and click Install." ;;
        brew)    info "• Homebrew: follow the one-line install on https://brew.sh (needs an administrator account)." ;;
        tmux)    info "• tmux: $( [ "$OS" = Darwin ] && echo 'brew install tmux' || echo 'sudo apt install tmux  (or your package manager)')" ;;
        git)     info "• git: $( [ "$OS" = Darwin ] && echo 'xcode-select --install' || echo 'sudo apt install git  (or your package manager)')" ;;
        python3) info "• Python: $( [ "$OS" = Darwin ] && echo 'xcode-select --install' || echo 'sudo apt install python3  (or your package manager)')" ;;
        node)    info "• Node.js 22: download the LTS installer from https://nodejs.org (or install Docker Desktop)" ;;
        agent)   info "• An AI agent, e.g. Claude Code:  curl -fsSL https://claude.ai/install.sh | bash" ;;
    esac; done
}

if [ -n "$need" ]; then
    step 2 "Installing what's missing"
    if [ -n "${TROPA_NO_DEPS:-}" ]; then
        say "  TROPA_NO_DEPS is set, so nothing is installed. Still missing: $(label)"
        how_to
    else
        say "  Missing: $(label)."
        pw=0
        [ "$OS" = Linux ] && [ "$(id -u)" != 0 ] && { needs git || needs python3 || needs tmux; } && pw=1
        [ "$OS" = Darwin ] && needs brew && pw=1
        [ "$pw" = 1 ] && say "  Some of these need your computer password (the one you log in with). Nothing shows while you type it; that's normal."
        if ask "  Install $( [ "$(printf '%s' "$need" | wc -w)" -gt 1 ] && echo them || echo it ) now?"; then
            needs clt && { install_clt || true; }
            needs brew && { install_brew || true; }
            pkgs=""
            needs git && pkgs="$pkgs git"; needs python3 && pkgs="$pkgs python3"; needs tmux && pkgs="$pkgs tmux"
            if [ "$OS" = Darwin ]; then pkgs=""; needs tmux && pkgs="tmux"; fi   # git and Python come with Apple's tools
            if [ -n "$pkgs" ] && { [ "$OS" = Linux ] || brew_ok; }; then
                say "  📦 Installing:$pkgs"
                pm_install $pkgs || true
            fi
            needs node && { install_node || bad "Couldn't download Node.js."; }
            needs agent && { install_agent || bad "Couldn't install the AI agent."; }
        elif tty_ok; then say "  Skipped."
        else say "  Nothing was installed: this isn't running in a terminal that can ask you (set TROPA_YES=1 to install without asking)."
        fi
        say ""; say "  Checking again:"
        check
        if [ -n "$need" ]; then
            say ""
            say "TropaAI isn't installed yet: it still needs $(label)."
            say "Here's how to add $( [ "$(printf '%s' "$need" | wc -w)" -gt 1 ] && echo them || echo it ) yourself:"
            how_to
            say ""
            say "Then paste the same install command again: it picks up where it left off."
            exit 1
        fi
        say ""; say "  All set."
    fi
else
    step 2 "Installing what's missing"
    say "  Nothing to install."
fi

# ================================================================ 3. tropa itself
step 3 "Installing TropaAI"
if [ -n "$TROPA_ARCHIVE" ]; then VER="${VER:-local}"   # install from a local .tar.gz (testing)
elif [ -z "$VER" ]; then
    VER=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null |
          sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -1)
fi
if [ -n "$VER" ]; then URL="https://github.com/$REPO/archive/refs/tags/v$VER.tar.gz"; LABEL="$VER"
else URL="https://github.com/$REPO/archive/refs/heads/main.tar.gz"; LABEL="main"; fi

say "  ⬇️  tropa ($LABEL) from $REPO"
if [ -n "$TROPA_ARCHIVE" ]; then cp "$TROPA_ARCHIVE" "$TMP/tropa.tar.gz"; LABEL="$VER"
else curl -fsSL "$URL" -o "$TMP/tropa.tar.gz" || die "The download failed ($URL). Check your internet connection and run this again."; fi
mkdir -p "$TMP/src" && tar -xzf "$TMP/tropa.tar.gz" -C "$TMP/src"
SRC=$(find "$TMP/src" -mindepth 1 -maxdepth 1 -type d | head -1)
[ -f "$SRC/tropa" ] || die "The download doesn't contain tropa. Try again in a minute."
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
good "tropa $(cat "$DEST/VERSION" 2>/dev/null || echo "$LABEL") is installed"

# put BIN_DIR, the Node.js we installed and the agents we installed on the PATH of new terminals (once)
case "${SHELL##*/}" in zsh) rc="$HOME/.zshrc" ;; bash) if [ "$OS" = Darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;; *) rc="$HOME/.profile" ;; esac
agent_dirs=""
case " $installed_now " in *" claude "*) agent_dirs="$agent_dirs $HOME/.local/bin" ;; esac
case " $installed_now " in *" opencode "*) agent_dirs="$agent_dirs $HOME/.opencode/bin" ;; esac
for d in "$BIN_DIR" $( [ -x "$DIR/node/bin/node" ] && echo "$DIR/node/bin" ) $agent_dirs; do
    [ -d "$d" ] || continue
    line="export PATH=\"$d:\$PATH\"   # tropa"
    if ! grep -qsF "$line" "$rc"; then printf '\n%s\n' "$line" >>"$rc" && info "Added ${d/#$HOME/\~} to your PATH in ${rc/#$HOME/\~} (for new terminals)."; fi
done
export PATH="$BIN_DIR:$PATH"

# ================================================================ 4. start it
step 4 "Opening TropaAI"
started=0
if [ -n "${TROPA_NO_START:-}" ]; then
    info "Start it with: tropa start"
elif ! tmux_ok || ! py_ok || { ! node_ok && ! docker_ok; }; then
    info "Some tools are still missing (see step 1), so it can't start yet. Once they're installed, run: tropa start"
else
    "$BIN_DIR/tropa" start ${TROPA_PORT:+-p "$TROPA_PORT"} && started=1 || info "It didn't start. Try again with: tropa start"
fi

say ""
say "🎉 TropaAI is installed."
[ "$started" = 1 ] && info "It's open in your browser. The Setup page there shows anything left to do."
case " $installed_now " in *" claude "*)
    say ""
    say "   One more thing: sign in to Claude Code once. Open a new terminal window, type  claude  and press Enter,"
    say "   then follow the steps (it opens your browser). Type /exit when you're done." ;;
esac
case " $installed_now " in *" opencode "*)
    say ""
    say "   OpenCode: open a new terminal window, type  opencode  and press Enter, then type /connect to pick a provider"
    say "   (some have free models). Press Ctrl+C to leave." ;;
esac
say ""
say "Every day: tropa start  ·  stop: tropa stop  ·  start when you log in: tropa autostart on"
