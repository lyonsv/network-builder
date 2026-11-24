#!/bin/bash
# network-builder installer for macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/lyonsv/network-builder/main/install.sh | bash
#
# Sets up everything, and is safe to run again (it skips or repairs what's already done):
#   1. Node.js           a private copy in ~/.network-builder/runtime (your own Node is never touched)
#   2. Claude Code       installs it if missing and makes sure you're logged in (all AI runs on your Claude plan)
#   3. network-builder   the CLI, the `network-builder` command, and its MCP server registered with Claude Code
#   4. Claude skill      ~/.claude/skills/network-builder, so Claude Code knows how to use your network
#   5. Desktop app       Network Builder.app in Applications and the Dock (Apple silicon)
#   6. Chrome            the LinkedIn connections exporter (+ optional profile capture extension)
#   7. Your connections  exported from LinkedIn and imported
#   8. Ahoy              checks your Ahoy CRM is connected to Claude Code
#
# Options:
#   --agent          non-interactive: do the automatic steps, then print what the human still has to do
#                    (used when Claude Code runs this for you; also the default when there's no terminal)
#   --status         only report what's installed and what's missing
#   --import <csv>   import a connections CSV (after setup)
#   --help
#
# Environment (mostly for testing): NETWORK_BUILDER_HOME, NB_ASSET_BASE (where release files come from),
# NB_BIN_DIR, NB_APPS_DIR, NB_SKILLS_DIR, NB_SKIP="mcp app dock skill extensions claude rc open".

set -u
set -o pipefail

REPO="lyonsv/network-builder"
EXPORTER_REPO="lyonsv/chrome-linkedin-connections-exporter"
NODE_LINE="latest-v24.x"
MIN_NODE="22.13.0"

NB_HOME="${NETWORK_BUILDER_HOME:-$HOME/.network-builder}"
ASSET_BASE="${NB_ASSET_BASE:-https://github.com/$REPO/releases/latest/download}"
BIN_DIR="${NB_BIN_DIR:-$HOME/.local/bin}"
APPS_DIR="${NB_APPS_DIR:-/Applications}"
SKILLS_DIR="${NB_SKILLS_DIR:-$HOME/.claude/skills}"
SKIP=" ${NB_SKIP:-} "

RUNTIME_DIR="$NB_HOME/runtime"
NODE_DIR="$RUNTIME_DIR/node"
NODE="$NODE_DIR/bin/node"
NPM="$NODE_DIR/bin/npm"
APP_DIR="$NB_HOME/app"
EXT_DIR="$NB_HOME/extensions"
EXPORTER_DIR="$EXT_DIR/linkedin-connections-exporter"
CAPTURE_DIR="$EXT_DIR/network-builder"
WRAPPER="$BIN_DIR/network-builder"
STATE="$NB_HOME/setup-state"
APP_NAME="Network Builder.app"
CONNECTIONS_URL="https://www.linkedin.com/mynetwork/invite-connect/connections/"
FIRST_PROMPT="Give me a quick tour of my network with the network-builder skill, then suggest three useful things to do with it."

MODE="interactive"
IMPORT_CSV=""
while [ $# -gt 0 ]; do
  case "$1" in
    --agent) MODE="agent" ;;
    --status) MODE="status" ;;
    --import) IMPORT_CSV="${2:-}"; MODE="import"; shift ;;
    -h|--help) sed -n '2,27p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)"; exit 2 ;;
  esac
  shift
done

# No usable terminal (piped into a tool, or Claude Code's shell) → agent mode.
if [ "$MODE" = "interactive" ] && ! { true </dev/tty; } 2>/dev/null; then MODE="agent"; fi

# ---------------------------------------------------------------------------------------------------------------- ui
if [ -t 1 ]; then
  B=$'\033[1m'; D=$'\033[2m'; R=$'\033[0m'; G=$'\033[32m'; Y=$'\033[33m'; RED=$'\033[31m'; C=$'\033[36m'; M=$'\033[35m'
else
  B=""; D=""; R=""; G=""; Y=""; RED=""; C=""; M=""
fi
STEP=0
TOTAL=8
step() { STEP=$((STEP + 1)); printf '\n%s[%d/%d]%s %s%s%s\n' "$M" "$STEP" "$TOTAL" "$R" "$B" "$1" "$R"; }
ok() { printf '  %s✓%s %s\n' "$G" "$R" "$1"; }
info() { printf '  %s%s%s\n' "$D" "$1" "$R"; }
say() { printf '  %s\n' "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$R" "$1"; }
fail() { printf '\n  %s✗ %s%s\n' "$RED" "$1" "$R"; }
miss() { printf '  %s✗%s %s\n' "$RED" "$R" "$1"; }
die() { fail "$1"; [ -n "${2:-}" ] && say "$2"; say "Fix that and run the same command again — it picks up where it left off."; exit 1; }
skipped() { case "$SKIP" in *" $1 "*) return 0 ;; esac; return 1; }

# Ask a yes/no question on the terminal. ask "Question" Y|N
ask() {
  local def="$2" ans hint="[Y/n]"
  [ "$def" = "N" ] && hint="[y/N]"
  if [ "$MODE" != "interactive" ]; then [ "$def" = "Y" ]; return; fi
  printf '  %s?%s %s %s%s%s ' "$C" "$R" "$1" "$D" "$hint" "$R"
  read -r ans </dev/tty || ans=""
  ans="$(printf '%s' "$ans" | tr '[:upper:]' '[:lower:]')"
  [ -z "$ans" ] && ans="$(printf '%s' "$def" | tr '[:upper:]' '[:lower:]')"
  [ "$ans" = "y" ] || [ "$ans" = "yes" ]
}
pause() { [ "$MODE" = "interactive" ] || return 0; printf '  %s↵%s %s' "$C" "$R" "${1:-Press Enter to continue}"; read -r _ </dev/tty || true; }
copy() { printf '%s' "$1" | pbcopy 2>/dev/null; }
open_chrome() { skipped open && return 0; open -a "Google Chrome" "$1" 2>/dev/null || open "$1" 2>/dev/null || true; }

state_get() { [ -f "$STATE" ] && grep -E "^$1=" "$STATE" | tail -1 | cut -d= -f2- ; }
state_set() { mkdir -p "$NB_HOME"; { [ -f "$STATE" ] && grep -vE "^$1=" "$STATE"; echo "$1=$2"; } >"$STATE.tmp"; mv "$STATE.tmp" "$STATE"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/nb-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# Download a URL to a file; quiet unless it fails.
fetch() { curl -fsSL --retry 3 --connect-timeout 20 -o "$2" "$1"; }

ARCH="$(uname -m)"
case "$ARCH" in arm64) NODE_ARCH="arm64" ;; x86_64) NODE_ARCH="x64" ;; *) NODE_ARCH="$ARCH" ;; esac

version_ge() { # version_ge 22.14.0 22.13.0
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" = "$2" ]
}

find_claude() {
  local c
  for c in "$(command -v claude 2>/dev/null)" "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

cli_entry() { # the CLI's bin.js, wherever it was installed
  local f
  for f in "$APP_DIR/node_modules/network-builder/dist/bin.js" "$APP_DIR/src/dist/bin.js"; do
    [ -f "$f" ] && { echo "$f"; return 0; }
  done
  return 1
}
pkg_root() { local e; e="$(cli_entry)" || return 1; dirname "$(dirname "$e")"; }

chrome_has_extension() { # is an unpacked extension loaded from this folder, in any Chrome profile?
  local f
  for f in "$HOME/Library/Application Support/Google/Chrome/"*/"Secure Preferences" "$HOME/Library/Application Support/Google/Chrome/"*/Preferences; do
    [ -f "$f" ] && grep -qF "\"$1\"" "$f" 2>/dev/null && return 0
  done
  return 1
}

people_count() { # people in the database, or empty
  [ -x "$WRAPPER" ] || return 1
  "$WRAPPER" db 2>/dev/null | sed -n 's/^[^a-z]*people  *\([0-9][0-9,]*\).*/\1/p' | head -1 | tr -dc '0-9'
}

ahoy_connected() { local c; c="$(find_claude)" || return 1; "$c" mcp list 2>/dev/null | grep -i 'ahoy' | grep -q 'Connected'; }

# ------------------------------------------------------------------------------------------------------- 1. Node.js
install_node() {
  step "Node.js (private copy for network-builder)"
  if [ -x "$NODE" ] && version_ge "$("$NODE" -p 'process.versions.node' 2>/dev/null || echo 0)" "$MIN_NODE"; then
    ok "Node $("$NODE" --version) in ${NODE_DIR/#$HOME/~}"
    return
  fi
  info "Downloading Node.js ($NODE_LINE, $NODE_ARCH)…"
  local base="https://nodejs.org/dist/$NODE_LINE" sums file
  fetch "$base/SHASUMS256.txt" "$TMP/SHASUMS256.txt" || die "Couldn't reach nodejs.org." "Check your internet connection."
  file="$(grep -Eo "node-v[0-9.]+-darwin-$NODE_ARCH\.tar\.gz" "$TMP/SHASUMS256.txt" | head -1)"
  [ -n "$file" ] || die "No Node.js build found for this Mac ($ARCH)."
  fetch "$base/$file" "$TMP/$file" || die "Node.js download failed."
  sums="$(grep " $file\$" "$TMP/SHASUMS256.txt" | awk '{print $1}')"
  [ "$(shasum -a 256 "$TMP/$file" | awk '{print $1}')" = "$sums" ] || die "Node.js download was corrupted (checksum mismatch)." "Run the command again."
  mkdir -p "$RUNTIME_DIR"
  tar -xzf "$TMP/$file" -C "$RUNTIME_DIR" || die "Couldn't unpack Node.js."
  rm -rf "$NODE_DIR"
  mv "$RUNTIME_DIR/${file%.tar.gz}" "$NODE_DIR"
  ok "Node $("$NODE" --version) in ${NODE_DIR/#$HOME/~}"
}

# --------------------------------------------------------------------------------------------------- 2. Claude Code
ensure_path_line() { # make sure BIN_DIR is on PATH in future terminals
  local rc line="export PATH=\"$BIN_DIR:\$PATH\""
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) export PATH="$BIN_DIR:$PATH" ;; esac
  skipped rc && return
  for rc in "$HOME/.zshrc" "$HOME/.bash_profile"; do
    [ "$rc" = "$HOME/.bash_profile" ] && [ ! -f "$rc" ] && continue
    grep -qF "$BIN_DIR" "$rc" 2>/dev/null && continue
    printf '\n# added by network-builder\n%s\n' "$line" >>"$rc"
  done
}

install_claude() {
  step "Claude Code"
  if skipped claude; then info "skipped"; return; fi
  local c
  if ! c="$(find_claude)"; then
    if [ "$MODE" != "interactive" ]; then
      die "Claude Code isn't installed." "Install it: curl -fsSL https://claude.ai/install.sh | bash"
    fi
    say "network-builder uses Claude Code for all its AI, on your own Claude plan (no API key)."
    info "Installing Claude Code…"
    curl -fsSL https://claude.ai/install.sh | bash </dev/null || die "Claude Code install failed." "See https://docs.claude.com/en/docs/claude-code/setup"
    c="$(find_claude)" || die "Claude Code installed, but I can't find the \`claude\` command."
  fi
  ensure_path_line
  ok "Claude Code $("$c" --version 2>/dev/null | head -1)"
  if "$c" auth status >/dev/null 2>&1; then
    ok "Logged in"
  elif [ "$MODE" = "interactive" ]; then
    say "Log in with your Claude account (a browser window opens)."
    "$c" auth login </dev/tty || true
    "$c" auth status >/dev/null 2>&1 || die "Not logged in to Claude Code." "Run: claude auth login"
    ok "Logged in"
  else
    warn "Claude Code isn't logged in. Run: claude auth login"
  fi
}

# ----------------------------------------------------------------------------------------------- 3. network-builder
install_cli() {
  step "network-builder"
  mkdir -p "$APP_DIR" "$BIN_DIR"
  local old="" new
  old="$(cat "$(pkg_root 2>/dev/null)/package.json" 2>/dev/null | grep -m1 '"version"' | tr -dc '0-9.')"
  info "Downloading the latest release…"
  export PATH="$NODE_DIR/bin:$PATH"
  if fetch "$ASSET_BASE/network-builder.tgz" "$TMP/network-builder.tgz"; then
    rm -rf "$APP_DIR/src"
    [ -f "$APP_DIR/package.json" ] || echo '{"name":"network-builder-install","private":true}' >"$APP_DIR/package.json"
    "$NPM" install --prefix "$APP_DIR" --omit=dev --no-audit --no-fund --loglevel=error "$TMP/network-builder.tgz" >"$TMP/npm.log" 2>&1 \
      || { cat "$TMP/npm.log"; die "Installing network-builder failed (npm)."; }
  else
    warn "No prebuilt release found; building from source (a couple of minutes)…"
    fetch "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" "$TMP/src.tgz" || die "Couldn't download network-builder from GitHub."
    rm -rf "$APP_DIR/src" && mkdir -p "$APP_DIR/src"
    tar -xzf "$TMP/src.tgz" -C "$APP_DIR/src" --strip-components 1 || die "Couldn't unpack the source."
    (cd "$APP_DIR/src" && "$NPM" install --no-audit --no-fund --loglevel=error >"$TMP/npm.log" 2>&1 && "$NPM" run build >>"$TMP/npm.log" 2>&1) \
      || { tail -30 "$TMP/npm.log"; die "Building network-builder failed."; }
  fi
  local entry claude_dir
  entry="$(cli_entry)" || die "network-builder installed, but its entry point is missing."
  claude_dir="$(dirname "$(find_claude 2>/dev/null || echo "$BIN_DIR/claude")")"
  local home_line=""
  [ -n "${NETWORK_BUILDER_HOME:-}" ] && home_line="export NETWORK_BUILDER_HOME=\"$NETWORK_BUILDER_HOME\""
  cat >"$WRAPPER" <<EOF
#!/bin/bash
# network-builder launcher (written by install.sh): pinned to its own Node so it keeps working when yours changes.
export PATH="$claude_dir:$BIN_DIR:\$PATH"
$home_line
exec "$NODE" "$entry" "\$@"
EOF
  chmod +x "$WRAPPER"
  new="$("$WRAPPER" --version 2>/dev/null)" || die "The network-builder command doesn't run." "Try: $WRAPPER --version"
  ensure_path_line
  if [ -n "$old" ] && [ "$old" != "$new" ]; then ok "Updated network-builder $old → $new"; else ok "network-builder $new"; fi
  info "Command: network-builder  ·  Data: ${NB_HOME/#$HOME/~}"

  # MCP server: lets Claude Code search and curate your network
  if skipped mcp; then info "MCP: skipped"; return; fi
  local c
  if c="$(find_claude)"; then
    "$c" mcp remove -s user network-builder >/dev/null 2>&1 || true
    if "$c" mcp add -s user network-builder -- "$WRAPPER" mcp >/dev/null 2>&1; then
      ok "Connected to Claude Code (MCP server \"network-builder\", all projects)"
    else
      warn "Couldn't register the MCP server. Run: claude mcp add -s user network-builder -- $WRAPPER mcp"
    fi
  fi
}

# --------------------------------------------------------------------------------------------------- 4. the skill
install_skill() {
  step "Claude Code skill"
  if skipped skill; then info "skipped"; return; fi
  local src
  src="$(pkg_root)/skills/network-builder"
  [ -f "$src/SKILL.md" ] || { warn "This release has no skill folder; skipping."; return; }
  mkdir -p "$SKILLS_DIR"
  rm -rf "$SKILLS_DIR/network-builder"
  cp -R "$src" "$SKILLS_DIR/network-builder"
  ok "Installed ${SKILLS_DIR/#$HOME/~}/network-builder"
  info "Claude Code now knows how to find people, build target lists and fill your Ahoy pipeline."
}

# ------------------------------------------------------------------------------------------------- 5. desktop app
install_app() {
  step "Desktop app"
  if skipped app; then info "skipped"; return; fi
  if [ "$ARCH" != "arm64" ]; then
    warn "The desktop app is built for Apple silicon only. On this Mac, run \`network-builder\` to open the explorer in your browser."
    return
  fi
  local dest="$APPS_DIR/$APP_NAME"
  [ "$APPS_DIR" = "/Applications" ] || mkdir -p "$APPS_DIR"
  # standard (non-admin) users can't write /Applications: use ~/Applications instead
  [ -w "$APPS_DIR" ] || { APPS_DIR="$HOME/Applications"; mkdir -p "$APPS_DIR"; dest="$APPS_DIR/$APP_NAME"; }
  info "Downloading Network Builder.app…"
  if ! fetch "$ASSET_BASE/Network-Builder-mac-arm64.zip" "$TMP/app.zip"; then
    warn "Couldn't download the desktop app; skipping. The explorer still works: run \`network-builder\`."
    return
  fi
  mkdir -p "$TMP/app" && ditto -x -k "$TMP/app.zip" "$TMP/app" || { warn "Couldn't unpack the app; skipping."; return; }
  [ -d "$TMP/app/$APP_NAME" ] || { warn "The download didn't contain $APP_NAME; skipping."; return; }
  if pgrep -f "$APP_NAME/Contents/MacOS/Network Builder\$" >/dev/null 2>&1; then
    osascript -e 'tell application "Network Builder" to quit' >/dev/null 2>&1 || true
    local i=0; while [ $i -lt 60 ] && pgrep -f "$APP_NAME/Contents/MacOS/Network Builder\$" >/dev/null 2>&1; do sleep 0.5; i=$((i + 1)); done
  fi
  rm -rf "$dest"
  ditto "$TMP/app/$APP_NAME" "$dest" || { warn "Couldn't copy the app to $APPS_DIR."; return; }
  xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
  ok "Installed ${dest/#$HOME/~}"
  if ! skipped dock; then
    local dock
    dock="$(defaults read com.apple.dock persistent-apps 2>/dev/null || true)"
    case "$dock" in
      *Network%20Builder.app*|*"Network Builder.app"*) ok "In your Dock" ;;
      *)
        defaults write com.apple.dock persistent-apps -array-add "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>file://$(printf '%s' "$dest" | sed 's/ /%20/g')/</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>" \
          && killall Dock 2>/dev/null && ok "Added to your Dock"
        ;;
    esac
  fi
}

# ---------------------------------------------------------------------------------------------- 6. Chrome extensions
download_extensions() {
  mkdir -p "$EXT_DIR"
  if fetch "https://codeload.github.com/$EXPORTER_REPO/tar.gz/refs/heads/main" "$TMP/exporter.tgz"; then
    mkdir -p "$TMP/exporter" && tar -xzf "$TMP/exporter.tgz" -C "$TMP/exporter" --strip-components 1 \
      && mkdir -p "$EXPORTER_DIR" && rsync -a --delete "$TMP/exporter/" "$EXPORTER_DIR/" \
      || warn "Couldn't unpack the connections exporter."
  elif [ ! -f "$EXPORTER_DIR/manifest.json" ]; then
    warn "Couldn't download the connections exporter from GitHub."
  fi
  local src
  src="$(pkg_root)/extension"
  if [ -f "$src/manifest.json" ]; then mkdir -p "$CAPTURE_DIR" && rsync -a --delete "$src/" "$CAPTURE_DIR/"; fi
}

# Walk someone through Load unpacked for one folder; waits until Chrome has it.
load_unpacked() { # load_unpacked <folder> <name shown in Chrome>
  local dir="$1" name="$2"
  if chrome_has_extension "$dir"; then ok "$name is loaded in Chrome"; return 0; fi
  copy "$dir"
  open_chrome "chrome://extensions"
  say ""
  say "${B}Add \"$name\" to Chrome${R}  (Chrome just opened its Extensions page)"
  say "  1. Turn on ${B}Developer mode${R} (switch at the top right)."
  say "  2. Click ${B}Load unpacked${R}."
  say "  3. In the window that opens, press ${B}⌘ Shift G${R}, then ${B}⌘ V${R} to paste the folder (already copied), then ${B}Enter${R} and ${B}Select${R}."
  info "     Folder: $dir"
  info "     (If the Extensions page didn't open, type chrome://extensions in Chrome's address bar.)"
  printf '  %s…%s waiting for Chrome to load it %s(Enter to skip)%s ' "$D" "$R" "$D" "$R"
  local n=0
  while [ $n -lt 600 ]; do
    if chrome_has_extension "$dir"; then printf '\n'; ok "$name is loaded"; return 0; fi
    if read -r -t 2 _ </dev/tty 2>/dev/null; then
      printf '\n'
      if chrome_has_extension "$dir"; then ok "$name is loaded"; return 0; fi
      warn "Couldn't confirm it's loaded (that's fine if you see it on chrome://extensions)."
      return 1
    fi
    n=$((n + 1))
  done
  printf '\n'; warn "Still not seeing it; carrying on. You can load it later from: $dir"
  return 1
}

install_extensions() {
  step "Chrome extensions"
  if skipped extensions; then info "skipped"; return; fi
  download_extensions
  ok "Downloaded to ${EXT_DIR/#$HOME/~}"
  [ "$MODE" = "interactive" ] || return 0
  if [ ! -d "/Applications/Google Chrome.app" ] && [ ! -d "$HOME/Applications/Google Chrome.app" ]; then
    warn "Google Chrome isn't installed. Install it from https://www.google.com/chrome/ and run this again."
    return
  fi
  say "The connections exporter reads your LinkedIn connections page and saves a CSV. It sends nothing anywhere."
  load_unpacked "$EXPORTER_DIR" "LinkedIn Connections Exporter" || true
  if chrome_has_extension "$CAPTURE_DIR"; then
    ok "Network Builder for LinkedIn is loaded in Chrome"
    info "After an update, click ↻ on its card in chrome://extensions."
  elif [ "$(state_get capture_ext)" != "no" ]; then
    say ""
    say "Optional: ${B}Network Builder for LinkedIn${R} adds a button to LinkedIn profiles that files people (even non-connections)"
    say "under a target company in Network Builder, and can map a company's whole marketing team."
    if ask "Add it now? (you can do this later)" N; then
      load_unpacked "$CAPTURE_DIR" "Network Builder for LinkedIn" || true
      info "Pair it later: open Network Builder → Accounts → 🧩 Chrome extension… → Copy pairing code → paste in the extension."
    else
      state_set capture_ext no
      info "Skipped. It's in ${CAPTURE_DIR/#$HOME/~} whenever you want it."
    fi
  fi
}

# --------------------------------------------------------------------------------------------- 7. your connections
latest_csv() { # newest likely connections CSV in Downloads, newer than $1 (epoch) if given
  local f best="" bestm=0 m
  for f in "$HOME/Downloads"/linkedin-connections-*.csv "$HOME/Downloads"/Connections*.csv; do
    [ -f "$f" ] || continue
    m="$(stat -f %m "$f" 2>/dev/null || echo 0)"
    [ "$m" -gt "${1:-0}" ] && [ "$m" -gt "$bestm" ] && { best="$f"; bestm="$m"; }
  done
  [ -n "$best" ] && echo "$best"
}

do_import() {
  local csv="$1"
  [ -f "$csv" ] || die "No such file: $csv"
  say "Importing ${B}$(basename "$csv")${R} and reading everyone's headline with Claude (role, seniority, industry)."
  info "This uses your Claude plan: roughly \$0.20 per 1,000 people (API-equivalent), a few minutes for a few thousand."
  "$WRAPPER" import "$csv" --no-serve || die "The import didn't finish." "Run it again: network-builder import \"$csv\" --no-serve (finished work is saved)"
  state_set imported "$csv"
}

connections() {
  step "Your LinkedIn connections"
  local n
  n="$(people_count)"
  if [ -n "$n" ] && [ "$n" -gt 0 ]; then
    ok "$n people already in your network"
    [ "$MODE" = "interactive" ] || return 0
    ask "Import a fresh export too? (adds new connections, refreshes titles)" N || return 0
  fi
  [ "$MODE" = "interactive" ] || return 0

  local csv since
  since="$(date +%s)"
  csv="$(latest_csv "$(( since - 3 * 86400 ))")"
  if [ -n "$csv" ] && ask "Found $(basename "$csv") in Downloads. Import that?" Y; then
    do_import "$csv"; return
  fi
  say ""
  say "${B}Export your connections${R}  (LinkedIn just opened in Chrome)"
  say "  1. Make sure you're logged in to LinkedIn and on the ${B}Connections${R} page."
  say "  2. Click the 🧩 puzzle icon in Chrome's toolbar → ${B}LinkedIn Connections Exporter${R} → ${B}Start export${R}."
  say "  3. ${B}Keep that tab in front${R} while it scrolls (about a minute per 500 connections)."
  say "     It downloads ${B}linkedin-connections-<date>.csv${R} when it's done."
  info "     If it stalls around 1,900 connections, choose \"Pause 60s & retry\"."
  open_chrome "$CONNECTIONS_URL"
  printf '  %s…%s watching Downloads for the file %s(or drag a CSV here and press Enter)%s\n  ' "$D" "$R" "$D" "$R"
  local typed=""
  while :; do
    csv="$(latest_csv "$((since - 5))")"
    if [ -n "$csv" ]; then
      sleep 2 # let the download finish writing
      printf '\n'; ok "Got $(basename "$csv")"; do_import "$csv"; return
    fi
    if read -r -t 3 typed </dev/tty 2>/dev/null; then
      typed="$(printf '%s' "$typed" | sed -e "s/^[[:space:]'\"]*//" -e "s/[[:space:]'\"]*\$//" -e 's/\\ / /g')"
      if [ -z "$typed" ]; then
        if ask "Skip importing for now?" N; then warn "Skipped. Later: network-builder import ~/Downloads/<file>.csv"; return; fi
      elif [ -f "$typed" ]; then do_import "$typed"; return
      else warn "No file at: $typed"; fi
      printf '  '
    fi
  done
}

# ----------------------------------------------------------------------------------------------------------- 8. Ahoy
check_ahoy() {
  step "Ahoy CRM"
  if skipped claude; then info "skipped"; return; fi
  info "Checking Claude Code's connections…"
  if ahoy_connected; then ok "Ahoy is connected to Claude Code"; return; fi
  if [ "$MODE" != "interactive" ]; then warn "Ahoy isn't connected to Claude Code yet."; return; fi
  say "Ahoy isn't connected to Claude Code yet. Pick one:"
  say "  ${B}a${R}) In Claude (claude.ai): Settings → Connectors → ${B}Ahoy${R} → Connect. Use the same Claude account as Claude Code."
  say "     Opening that page now."
  say "  ${B}b${R}) Ahoy gave you an MCP link (https://api.ahoy.ai/…/mcp/): paste it here."
  open "https://claude.ai/settings/connectors" 2>/dev/null || true
  local ans c
  c="$(find_claude)" || return
  while :; do
    printf '  %s?%s Press Enter to check again, paste an Ahoy MCP link, or type s to skip: ' "$C" "$R"
    read -r ans </dev/tty || ans="s"
    case "$ans" in
      s|S|skip) warn "Skipped. Connect Ahoy later and Claude Code will pick it up."; return ;;
      http*)
        "$c" mcp remove -s user ahoy >/dev/null 2>&1 || true
        if "$c" mcp add -s user --transport http ahoy "$ans" >/dev/null 2>&1; then
          ok "Added. Finish signing in: in Claude Code type /mcp, choose ahoy, then Authenticate."
          state_set ahoy_auth pending
          return
        fi
        warn "That didn't work: claude mcp add -s user --transport http ahoy <link>"
        ;;
    esac
    info "Checking…"
    if ahoy_connected; then ok "Ahoy is connected to Claude Code"; return; fi
    warn "Not connected yet. (claude.ai connectors can take a minute to show up.)"
  done
}

# ---------------------------------------------------------------------------------------------------------- status
status() {
  local c n e
  printf '%snetwork-builder setup%s\n' "$B" "$R"
  if [ -x "$NODE" ]; then ok "Node $("$NODE" --version)"; else miss "Node runtime missing ($NODE)"; fi
  if c="$(find_claude)"; then
    ok "Claude Code $("$c" --version 2>/dev/null | head -1)"
    if "$c" auth status >/dev/null 2>&1; then ok "Claude Code logged in"; else miss "Claude Code not logged in (claude auth login)"; fi
    if "$c" mcp get network-builder >/dev/null 2>&1; then ok "MCP server registered"; else miss "MCP server not registered"; fi
    if ahoy_connected; then ok "Ahoy connected"; else miss "Ahoy not connected (claude.ai → Settings → Connectors → Ahoy)"; fi
  else
    miss "Claude Code not installed"
  fi
  if [ -x "$WRAPPER" ] && "$WRAPPER" --version >/dev/null 2>&1; then ok "network-builder $("$WRAPPER" --version) ($WRAPPER)"; else miss "network-builder command missing"; fi
  if [ -f "$SKILLS_DIR/network-builder/SKILL.md" ]; then ok "Skill installed"; else miss "Skill missing"; fi
  if [ -d "$APPS_DIR/$APP_NAME" ] || [ -d "$HOME/Applications/$APP_NAME" ]; then ok "Desktop app installed"; else miss "Desktop app missing"; fi
  for e in "$EXPORTER_DIR:LinkedIn Connections Exporter" "$CAPTURE_DIR:Network Builder for LinkedIn (optional)"; do
    if chrome_has_extension "${e%%:*}"; then ok "Chrome: ${e#*:} loaded"; else miss "Chrome: ${e#*:} not loaded (Load unpacked: ${e%%:*})"; fi
  done
  n="$(people_count)"
  if [ -n "$n" ] && [ "$n" -gt 0 ]; then ok "$n people imported"; else miss "No connections imported yet"; fi
}

# ------------------------------------------------------------------------------------------------------------ main
if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer is for macOS. On Linux: install Node 22.13+ and Claude Code, then run: npx github:$REPO"
  exit 1
fi

case "$MODE" in
  status) status; exit 0 ;;
  import) [ -x "$WRAPPER" ] || die "network-builder isn't installed yet. Run the installer first."; do_import "$IMPORT_CSV"; exit 0 ;;
esac

printf '\n%s network-builder %s  %sYour LinkedIn network → target lists → your Ahoy pipeline%s\n' "$B$M" "$R" "$D" "$R"
if [ "$MODE" = "interactive" ]; then
  say ""
  say "This sets up everything, in about 10 minutes:"
  say "  • the ${B}network-builder${R} command, the ${B}desktop app${R}, and a ${B}Claude Code skill${R}"
  say "  • a Chrome extension to ${B}export your LinkedIn connections${R}, which we then import"
  say "  • a check that ${B}Ahoy${R} is connected, so Claude can build your pipeline"
  info "Your network stays on this Mac (${NB_HOME/#$HOME/~}). AI runs on your own Claude plan. Safe to run again."
  pause "Press Enter to start (Ctrl-C to cancel) "
fi

install_node
install_claude
install_cli
install_skill
install_app
install_extensions
connections
check_ahoy

if [ "$MODE" = "agent" ]; then
  printf '\n%sAutomatic steps done.%s\n' "$B" "$R"
  cat <<EOF

NEXT STEPS FOR THE HUMAN (an agent should walk them through these, one at a time):
$(chrome_has_extension "$EXPORTER_DIR" && echo "  - [done] Connections exporter loaded in Chrome" || echo "  - Load the connections exporter in Chrome: chrome://extensions → Developer mode → Load unpacked → $EXPORTER_DIR")
$(n="$(people_count)"; [ -n "$n" ] && [ "$n" -gt 0 ] && echo "  - [done] $n people imported" || echo "  - Export connections: open $CONNECTIONS_URL, click the exporter → Start export, keep the tab in front; then run: $WRAPPER import ~/Downloads/linkedin-connections-<date>.csv --no-serve")
$(ahoy_connected && echo "  - [done] Ahoy connected" || echo "  - Connect Ahoy: claude.ai → Settings → Connectors → Ahoy (same Claude account), or: claude mcp add -s user --transport http ahoy <their Ahoy MCP link>")
  - Restart Claude Code so it loads the new network-builder MCP server and skill.
Check progress any time: bash <(curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh) --status
EOF
  exit 0
fi

# finish
printf '\n%s%s✓ All set.%s\n\n' "$B" "$G" "$R"
say "${B}Open Claude Code${R} (type ${C}claude${R} in a terminal) and ask, for example:"
say "  ${C}\"Find the marketing leaders in my network based in Ireland and build an Ahoy pipeline${R}"
say "  ${C} of the target companies and the people to reach out to.\"${R}"
say "  ${C}\"Who in my network could introduce me to someone at Stripe?\"${R}"
say "  ${C}\"Which of my connections are angel investors?\"${R}"
say ""
say "Browse and curate your network in the ${B}Network Builder${R} app (Dock), or run ${C}network-builder${R}."
[ "$(state_get ahoy_auth)" = "pending" ] && say "Remember: in Claude Code, type ${C}/mcp${R} → ahoy → Authenticate."
say ""
if [ -d "$APPS_DIR/$APP_NAME" ] && [ -n "$(people_count)" ] && ask "Open the Network Builder app now?" Y; then open "$APPS_DIR/$APP_NAME" 2>/dev/null || true; fi
if c="$(find_claude)" && ask "Start Claude Code now with a tour of your network?" Y; then
  cd "$HOME" && exec "$c" "$FIRST_PROMPT" </dev/tty
fi
