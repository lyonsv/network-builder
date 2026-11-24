#!/bin/bash
# network-builder for macOS: one paste sets up everything.
#
#   curl -fsSL https://raw.githubusercontent.com/lyonsv/network-builder/main/install.sh | bash
#
# This script only puts network-builder itself on your Mac: a private copy of Node.js and the `network-builder`
# command (in ~/.network-builder and ~/.local/bin; no sudo). Then it runs `network-builder setup`, which walks you
# through the rest: Claude Code, the desktop app, Chrome, your LinkedIn connections and Ahoy.
# Safe to run again: it updates network-builder and picks up where setup left off.

set -u
set -o pipefail

usage() {
  cat <<'EOF'
network-builder installer (macOS)

  curl -fsSL https://raw.githubusercontent.com/lyonsv/network-builder/main/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/lyonsv/network-builder/main/install.sh | bash -s -- [options]

Options (passed on to `network-builder setup`):
  --agent                   non-interactive, for Claude Code: automatic steps, then what the person must do
  --watch-downloads <min>   with --agent: wait for the connections export in Downloads and import it
  --status [--json]         show what's set up and what's missing
  --help                    this help

Environment (testing): NETWORK_BUILDER_HOME, NB_ASSET_BASE, NB_BIN_DIR, NB_APPS_DIR, NB_SKILLS_DIR,
NB_SKIP="claude mcp skill app dock extensions open rc"
EOF
}

REPO="lyonsv/network-builder"
NODE_LINE="latest-v24.x"
MIN_NODE="22.13.0"
NB_HOME="${NETWORK_BUILDER_HOME:-$HOME/.network-builder}"
BIN_DIR="${NB_BIN_DIR:-$HOME/.local/bin}"
NODE_DIR="$NB_HOME/runtime/node"
NODE="$NODE_DIR/bin/node"
NPM="$NODE_DIR/bin/npm"
APP_DIR="$NB_HOME/app"
PKG="$APP_DIR/node_modules/network-builder"
ENTRY="$PKG/dist/bin.js"
WRAPPER="$BIN_DIR/network-builder"
SKIP=" ${NB_SKIP:-} "

ARGS=()
AGENT=""
for a in "$@"; do
  case "$a" in
    -h|--help) usage; exit 0 ;;
    --agent|--status) AGENT=1; ARGS+=("$a") ;;
    *) ARGS+=("$a") ;;
  esac
done

if [ -t 1 ]; then B=$'\033[1m'; D=$'\033[2m'; R=$'\033[0m'; G=$'\033[32m'; RED=$'\033[31m'; M=$'\033[35m'; else B=""; D=""; R=""; G=""; RED=""; M=""; fi
ok() { printf '  %s✓%s %s\n' "$G" "$R" "$1"; }
info() { printf '  %s%s%s\n' "$D" "$1" "$R"; }
die() {
  printf '\n  %s✗ %s%s\n' "$RED" "$1" "$R"
  [ -n "${2:-}" ] && printf '    %s\n' "$2"
  printf '    Then paste the same command again; it picks up where it left off.\n'
  exit 1
}

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer is for macOS. On Linux: install Node.js 22.13+ and Claude Code, then run: npx github:$REPO"
  exit 1
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/nb-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fetch() { curl -fsL --retry 3 --connect-timeout 20 -o "$2" "$1" 2>/dev/null; }
# Apple silicon even when Terminal runs under Rosetta
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then NODE_ARCH="arm64"; else NODE_ARCH="x64"; fi
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" = "$2" ]; }

printf '\n%s network-builder %s %s· getting it onto your Mac%s\n' "$B$M" "$R" "$D" "$R"

# 1. Node.js: a private copy, so network-builder never depends on (or changes) yours
if [ -x "$NODE" ] && version_ge "$("$NODE" -p 'process.versions.node' 2>/dev/null || echo 0)" "$MIN_NODE"; then
  ok "Node.js $("$NODE" --version)"
else
  info "Downloading Node.js…"
  base="https://nodejs.org/dist/$NODE_LINE"
  fetch "$base/SHASUMS256.txt" "$TMP/SHASUMS256.txt" || die "Couldn't reach nodejs.org." "Check your internet connection."
  file="$(grep -Eo "node-v[0-9.]+-darwin-$NODE_ARCH\.tar\.gz" "$TMP/SHASUMS256.txt" | head -1)"
  [ -n "$file" ] || die "No Node.js build found for this Mac."
  fetch "$base/$file" "$TMP/$file" || die "The Node.js download failed." "Check your internet connection."
  want="$(grep " $file\$" "$TMP/SHASUMS256.txt" | awk '{print $1}')"
  [ "$(shasum -a 256 "$TMP/$file" | awk '{print $1}')" = "$want" ] || die "The Node.js download was corrupted."
  mkdir -p "$NB_HOME/runtime" && tar -xzf "$TMP/$file" -C "$NB_HOME/runtime" || die "Couldn't unpack Node.js."
  rm -rf "$NODE_DIR" && mv "$NB_HOME/runtime/${file%.tar.gz}" "$NODE_DIR"
  ok "Node.js $("$NODE" --version)"
fi

# 2. network-builder: the latest release (skipped when it's already that version)
pkg_version() { [ -f "$PKG/package.json" ] && "$NODE" -p "require('$PKG/package.json').version" 2>/dev/null; }
installed="$(pkg_version || true)"
if [ -n "${NB_ASSET_BASE:-}" ]; then
  tag=""; asset="$NB_ASSET_BASE/network-builder.tgz"
else
  tag="$(curl -fsI "https://github.com/$REPO/releases/latest" 2>/dev/null | tr -d '\r' | sed -n 's#^[Ll]ocation: .*/tag/v\{0,1\}\(.*\)$#\1#p' | tail -1)"
  if [ -n "$tag" ]; then asset="https://github.com/$REPO/releases/download/v$tag/network-builder.tgz"
  else asset="https://github.com/$REPO/releases/latest/download/network-builder.tgz"; fi
fi
if [ -n "$installed" ] && [ -f "$ENTRY" ] && [ "$installed" = "$tag" ]; then
  ok "network-builder $installed"
else
  info "Downloading network-builder${tag:+ $tag}…"
  fetch "$asset" "$TMP/network-builder.tgz" || die "Couldn't download network-builder from GitHub." "Check your internet connection."
  mkdir -p "$APP_DIR"
  [ -f "$APP_DIR/package.json" ] || echo '{"name":"network-builder-install","private":true}' >"$APP_DIR/package.json"
  PATH="$NODE_DIR/bin:$PATH" "$NPM" install --prefix "$APP_DIR" --omit=dev --no-audit --no-fund --loglevel=error "$TMP/network-builder.tgz" >"$TMP/npm.log" 2>&1 \
    || { tail -20 "$TMP/npm.log"; die "Installing network-builder failed."; }
  [ -f "$ENTRY" ] || die "network-builder installed, but its files are missing."
  new="$(pkg_version)"
  if [ -n "$installed" ] && [ "$installed" != "$new" ]; then ok "network-builder $installed → $new"; else ok "network-builder $new"; fi
fi

# 3. the `network-builder` command, pinned to that Node
mkdir -p "$BIN_DIR"
claude_dir="$HOME/.local/bin"
c="$(command -v claude 2>/dev/null || true)"; [ -n "$c" ] && claude_dir="$(dirname "$c")"
{
  echo '#!/bin/bash'
  echo '# network-builder launcher, written by install.sh. Paste the installer again to update.'
  echo "export PATH=\"$claude_dir:$HOME/.local/bin:\$PATH\""
  echo "export NB_LAUNCHER=\"$WRAPPER\""
  if [ -n "${NETWORK_BUILDER_HOME:-}" ]; then echo "export NETWORK_BUILDER_HOME=\"$NETWORK_BUILDER_HOME\""; fi
  echo "exec \"$NODE\" \"$ENTRY\" \"\$@\""
} >"$WRAPPER"
chmod +x "$WRAPPER"
"$WRAPPER" --version >/dev/null 2>&1 || die "The network-builder command doesn't start." "Try: $WRAPPER --version"
case "$SKIP" in *" rc "*) ;; *)
  for rc in "$HOME/.zshrc" "$HOME/.bash_profile"; do
    [ "$rc" = "$HOME/.bash_profile" ] && [ ! -f "$rc" ] && continue
    grep -qF "$BIN_DIR" "$rc" 2>/dev/null || printf '\n# added by network-builder\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >>"$rc"
  done
;; esac
ok "The network-builder command is ready"

# 4. hand over to the setup wizard: on the terminal (even when this script was piped into bash), else agent mode
if [ -z "$AGENT" ] && { true </dev/tty; } 2>/dev/null; then
  exec "$WRAPPER" setup ${ARGS[@]+"${ARGS[@]}"} </dev/tty
fi
[ -z "$AGENT" ] && ARGS+=("--agent")
exec "$WRAPPER" setup ${ARGS[@]+"${ARGS[@]}"}
