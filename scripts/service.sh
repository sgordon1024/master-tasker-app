#!/bin/zsh
# Master Tasker service control (macOS, per-user LaunchAgent).
#   ./scripts/service.sh install     Check this Mac, build the app, install and start the LaunchAgents
#   ./scripts/service.sh open        Open Master Tasker in your browser
#   ./scripts/service.sh update      Get the latest version (git pull, if this is a git checkout), rebuild and restart
#   ./scripts/service.sh start|stop|restart|status|logs|health
#   ./scripts/service.sh uninstall   Undo the Claude setups, if any, then stop and remove the LaunchAgents (keeps your data, says what's left)
#   ./scripts/service.sh get-node    Download Node.js just for Master Tasker, into .node in this folder (no password needed)
#   ./scripts/service.sh demo        Open a throwaway copy with made-up tasks. It never touches yours
#   Add --yes to install or update to answer yes to its questions (moving the service here, downloading Node).
#
# What install does, and nothing more:
#   - writes two plists to ~/Library/LaunchAgents (no sudo, no system changes)
#   - the server listens on 127.0.0.1 only
#   - it does not touch sleep, battery, firewall or security settings
#   - only if you say yes: downloads Node.js from nodejs.org into .node in this folder, checked against nodejs.org's checksums
#
# Exit codes that Install Master Tasker.command acts on: 3 means Node.js is missing, 4 means something else has the port.
# free-port prints the next free port after this one, for Install Master Tasker.command.
set -euo pipefail

LABEL="local.master-tasker.server"
HC_LABEL="local.master-tasker.healthcheck"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
PLIST="$AGENTS/$LABEL.plist"
HC_PLIST="$AGENTS/$HC_LABEL.plist"
# MT_PORT, MT_DATA_DIR and MT_LOG_DIR: what you set, else what the installed service already uses, else
# the default. So update, and installing again, keep a port or folder picked at install.
# scripts/install-skill.sh and server/cli.ts do the same. Change them together.
setting() {
  local v="${(P)1:-}"
  [[ -z "$v" && -f "$PLIST" ]] && v="$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$1" "$PLIST" 2>/dev/null || true)"
  print -r -- "${v:-$2}"
}
LOG_DIR="$(setting MT_LOG_DIR "$HOME/Library/Logs/MasterTasker")"
DATA_DIR="$(setting MT_DATA_DIR "$HOME/Library/Application Support/MasterTasker")"
PORT="$(setting MT_PORT 4820)"
URL="http://127.0.0.1:$PORT"
DOMAIN="gui/$(id -u)"
# The Node.js download page, where the macOS Installer (.pkg) button is.
NODE_LINK="https://nodejs.org/en/download"
# What get-node downloads: a Node 24 LTS release, from nodejs.org unless MT_NODE_DIST names another copy of its dist folder.
NODE_VERSION="24.22.0"
NODE_DIST="${MT_NODE_DIST:-https://nodejs.org/dist}"
# The checksums nodejs.org publishes for that release (SHASUMS256.txt). A download from nodejs.org must match these,
# so a changed file on the server can't get in. Update them with NODE_VERSION.
NODE_SHA256_arm64="6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5"
NODE_SHA256_x64="495e3f273c645f3c4677d438304cdfc701729ea5dec5728f5c8e76a2dece4b91"
PRIVATE_NODE="$ROOT/.node/bin/node"

cmd="${1:-}"
YES=0
for a in "${@:2}"; do
  if [[ "$a" == --yes ]]; then YES=1; fi
done

say() { print -r -- "$@"; }
die() { print -ru2 -- "$@"; exit 1; }

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# Yes, unless they answer no. It only asks in Terminal, and --yes answers for you.
ask_yes() {
  (( YES )) && return 0
  [[ -t 0 ]] || return 1
  local reply=""
  print -n -- "$1 [Y/n] "
  read -r reply || return 1
  [[ -z "$reply" || "$reply" == [yY]* ]]
}

# Downloads Node.js into .node in this folder, for Master Tasker only. Nothing outside this folder changes,
# and the download is only used if it matches the checksum nodejs.org publishes for it.
get_node() {
  local arch
  case "$(uname -m)" in
    arm64) arch=arm64 ;;
    # A Terminal running under Rosetta says x86_64 on Apple silicon.
    x86_64) arch=x64; [[ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" == 1 ]] && arch=arm64 ;;
    *) print -ru2 -- "✗ Node.js has no download for this Mac's processor ($(uname -m))."; return 1 ;;
  esac
  local name="node-v$NODE_VERSION-darwin-$arch"
  local from="$NODE_DIST/v$NODE_VERSION"
  local tmp="$ROOT/.node-download"
  local -a progress=(-sS)
  [[ -t 1 ]] && progress=(--progress-bar)
  rm -rf "$tmp"
  mkdir -p "$tmp"
  say "→ Downloading Node.js $NODE_VERSION for Master Tasker (about 50 MB)"
  if ! curl -fL --retry 2 --connect-timeout 20 "${progress[@]}" -o "$tmp/$name.tar.gz" "$from/$name.tar.gz" \
    || ! curl -fsSL --retry 2 --connect-timeout 20 -o "$tmp/SHASUMS256.txt" "$from/SHASUMS256.txt"; then
    rm -rf "$tmp"
    print -ru2 -- "✗ The download didn't work. Check your internet connection, then try again."
    return 1
  fi
  local want got
  want="$(awk -v f="$name.tar.gz" '$2 == f { print $1 }' "$tmp/SHASUMS256.txt")"
  # From nodejs.org itself, it must also match the checksum pinned above. MT_NODE_DIST (a mirror, or the tests) skips that.
  if [[ -z "${MT_NODE_DIST:-}" ]]; then
    local pinned="NODE_SHA256_$arch"
    [[ "$want" == "${(P)pinned}" ]] || want="mismatch"
  fi
  got="$(shasum -a 256 "$tmp/$name.tar.gz" | awk '{ print $1 }')"
  if [[ -z "$want" || "$want" != "$got" ]]; then
    rm -rf "$tmp"
    print -ru2 -- "✗ The download doesn't match the checksum nodejs.org publishes for it, so it wasn't used. Nothing changed."
    return 1
  fi
  if ! tar -xzf "$tmp/$name.tar.gz" -C "$tmp" 2>/dev/null || [[ ! -x "$tmp/$name/bin/node" ]] || (( $(node_major "$tmp/$name/bin/node") < 24 )); then
    rm -rf "$tmp"
    print -ru2 -- "✗ The download didn't unpack into a working Node.js, so it wasn't used. Nothing changed."
    return 1
  fi
  rm -rf "$ROOT/.node"
  mv "$tmp/$name" "$ROOT/.node"
  rm -rf "$tmp"
  say "  ✓ Node $("$PRIVATE_NODE" --version), in $ROOT/.node. Only Master Tasker uses it."
}

# Node 24 or newer: the one get-node downloaded, then the stable links (Homebrew, the nodejs.org installer)
# so Node upgrades don't break the agent. MT_NODE picks one yourself. With "offer" (install and update),
# it offers to download one when there's none.
NODE=""
find_node() {
  [[ -n "$NODE" ]] && return 0
  local c old=""
  local -a try=("$PRIVATE_NODE" /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null || true)")
  [[ -n "${MT_NODE:-}" ]] && try=("$MT_NODE")
  for c in "${try[@]}"; do
    [[ -n "$c" && -x "$c" ]] || continue
    if (( $(node_major "$c") >= 24 )); then NODE="$c"; return 0; fi
    old="$("$c" --version 2>/dev/null || echo old)"
  done
  if [[ -n "$old" ]]; then
    print -ru2 -- "This Mac has Node $old, which is too old. Master Tasker needs Node.js 24 or newer."
  else
    print -ru2 -- "Master Tasker needs Node.js 24 or newer, and this Mac doesn't have it."
  fi
  if [[ "${1:-}" == offer && -z "${MT_NODE:-}" ]] && ask_yes "Master Tasker needs Node.js. Download a private copy just for Master Tasker (about 50 MB, no password needed)?"; then
    if get_node; then NODE="$PRIVATE_NODE"; return 0; fi
  fi
  # Exit code 3 means "get Node", so the double-click installer can open the download page.
  print -ru2 -- "
Get it one of these ways, then run this again:
  - A private copy just for Master Tasker (about 50 MB, no password needed): ./scripts/service.sh get-node
  - Or Node.js for the whole Mac: open $NODE_LINK and press macOS Installer (.pkg), not the commands.
    Then open the file it downloads and follow the steps."
  exit 3
}

# npm next to that node, so both match.
npm_run() {
  local npm="${NODE:h}/npm"
  [[ -x "$npm" ]] || npm="$(command -v npm 2>/dev/null || true)"
  [[ -n "$npm" ]] || die "npm is missing. It comes with Node.js: run ./scripts/service.sh get-node, or reinstall Node from $NODE_LINK."
  PATH="${NODE:h}:$PATH" "$npm" "$@"
}

# macOS keeps background apps out of these folders, so the service couldn't read its own files.
# Install Master Tasker.command checks the same folders, and offers to move this one. Change both together.
check_folder() {
  [[ "${MT_SKIP_FOLDER_CHECK:-}" == 1 ]] && return 0
  local real; real="$(cd "$ROOT" && pwd -P)"
  local home; home="$(cd "$HOME" && pwd -P)"
  local place=""
  case "$real/" in
    "$home/Desktop/"*) place="Desktop" ;;
    "$home/Documents/"*) place="Documents" ;;
    "$home/Downloads/"*) place="Downloads" ;;
    "$home/Library/Mobile Documents/"*) place="iCloud Drive" ;;
  esac
  [[ -z "$place" ]] && return 0
  die "This folder is inside your $place folder:
  $real
macOS keeps background apps out of Desktop, Documents, Downloads and iCloud Drive, so Master Tasker
couldn't start on its own when you log in. Double-click Install Master Tasker.command and it offers to
move the folder for you. Or move it yourself: in Finder, select the ${real:t} folder, press Command-C,
choose Go > Home, then press Command-Option-V. Then run this again from there."
}

port_in_use() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; }

# Exit code 4 means something else has the port, so the double-click installer can offer another one.
check_port() {
  port_in_use || return 0
  # The installed service is on it (this copy's, or one you just agreed to move here): install and update restart it.
  [[ -f "$PLIST" ]] && loaded "$LABEL" && ours && return 0
  if healthy; then
    print -ru2 -- "Another copy of Master Tasker is already running on port $PORT, outside the background service
(maybe 'npm start' in a Terminal window). Stop it, or pick another port, for example: MT_PORT=4830 ./scripts/service.sh install"
  else
    print -ru2 -- "Something else is already using port $PORT, so Master Tasker can't start there.
Quit that app, or pick another port, for example: MT_PORT=4830 ./scripts/service.sh install"
  fi
  exit 4
}

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<< "$1"; }

healthy() { curl -fsS --max-time 3 "$URL/api/health" >/dev/null 2>&1; }

# This service's server holds the port: the pid file it keeps in its data folder names the one process
# listening there. An answer on the port from another app, or another copy of Master Tasker, doesn't count.
ours() {
  [[ -f "$DATA_DIR/server.pid" ]] || return 1
  local pid; pid="$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$DATA_DIR/server.pid")"
  [[ -n "$pid" && "$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u)" == "$pid" ]]
}

wait_ours() {
  for _ in {1..60}; do ours && healthy && return 0; sleep 0.25; done
  return 1
}

# When it won't start, the reason is almost always in one of these. Node's warning that SQLite is
# experimental is never the reason, so it's left out.
show_errors() {
  local f n lines
  for f n in "$LOG_DIR/launchd.err.log" 12 "$LOG_DIR/server.log" 6; do
    [[ -s "$f" ]] || continue
    lines="$(grep -v -e 'ExperimentalWarning' -e 'node --trace-warnings' "$f" | tail -n "$n" || true)"
    [[ -n "$lines" ]] || continue
    say ""
    say "Last lines of $f:"
    print -r -- "$lines" | sed 's/^/  /'
  done
  say ""
  say "If it says \"Operation not permitted\", the folder is somewhere macOS protects: move it into your home folder."
  say "Watch the logs with: ./scripts/service.sh logs"
}

write_plists() {
  mkdir -p "$AGENTS" "$LOG_DIR" "$DATA_DIR"
  local r; r="$(xml_escape "$ROOT")"
  local l; l="$(xml_escape "$LOG_DIR")"
  local d; d="$(xml_escape "$DATA_DIR")"
  local n; n="$(xml_escape "$NODE")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$n</string>
    <!-- Node 24 warns that SQLite is experimental at every start. It isn't an error, so keep it out of launchd.err.log. -->
    <string>--no-warnings=ExperimentalWarning</string>
    <string>$r/server/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$r</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>MT_PORT</key><string>$PORT</string>
    <key>MT_HOST</key><string>127.0.0.1</string>
    <key>MT_DATA_DIR</key><string>$d</string>
    <key>MT_LOG_DIR</key><string>$l</string>
  </dict>
  <!-- Start at login. Restart if it crashes or is killed, but not after a clean stop. -->
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <!-- At most one restart every 10 seconds, so a crash loop cannot spin the CPU. -->
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>10</integer>
  <key>StandardOutPath</key><string>$l/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$l/launchd.err.log</string>
</dict>
</plist>
EOF
  cat > "$HC_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$HC_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$r/scripts/healthcheck.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MT_PORT</key><string>$PORT</string>
    <key>MT_DATA_DIR</key><string>$d</string>
    <key>MT_LOG_DIR</key><string>$l</string>
  </dict>
  <!-- Every 5 minutes while you are logged in and the Mac is awake. -->
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$l/healthcheck.log</string>
  <key>StandardErrorPath</key><string>$l/healthcheck.log</string>
</dict>
</plist>
EOF
  plutil -lint "$PLIST" "$HC_PLIST" >/dev/null
}

loaded() { launchctl print "$DOMAIN/$1" >/dev/null 2>&1; }
# Loaded from a plist in another home folder (only happens when HOME is borrowed, as in tests). Never touch that one.
foreign() {
  local p; p="$(launchctl print "$DOMAIN/$1" 2>/dev/null | sed -n 's/^[[:space:]]*path = //p' | head -n 1)"
  [[ -n "$p" && "$p" != "$AGENTS/$1.plist" ]]
}

start() {
  [[ -f "$PLIST" ]] || die "Not installed yet. Run: ./scripts/service.sh install"
  check_port
  loaded "$LABEL" || launchctl bootstrap "$DOMAIN" "$PLIST"
  loaded "$HC_LABEL" || launchctl bootstrap "$DOMAIN" "$HC_PLIST"
  launchctl kickstart "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  if wait_ours; then say "✓ Running at $URL"; else
    print -ru2 -- "✗ It started, but isn't answering at $URL yet."
    show_errors >&2
    exit 1
  fi
}

stop() {
  loaded "$HC_LABEL" && launchctl bootout "$DOMAIN/$HC_LABEL" 2>/dev/null || true
  loaded "$LABEL" && launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  for _ in {1..40}; do ours || break; sleep 0.25; done
  say "✓ Stopped. It will start again at next login unless you uninstall."
}

restart() {
  if loaded "$LABEL"; then
    launchctl kickstart -k "$DOMAIN/$LABEL"
    if wait_ours; then say "✓ Restarted. Running at $URL"; else
      print -ru2 -- "✗ Not answering after the restart."
      show_errors >&2
      exit 1
    fi
  else start; fi
}

# The folder the installed service runs from, or nothing.
installed_from() { [[ -f "$PLIST" ]] && /usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$PLIST" 2>/dev/null || true; }
owned_here() { [[ -f "$PLIST" ]] && grep -qF "<string>$(xml_escape "$ROOT")/server/main.ts</string>" "$PLIST"; }

# Builds the app the way an install needs it: the UI only, without the developer typecheck. Then it removes
# the packages only developers need (the build and test tools). update installs them again first.
build() {
  say "→ Installing what it needs. This takes a minute or two the first time."
  local log="$LOG_DIR/install.log"
  mkdir -p "$LOG_DIR"
  if ! (cd "$ROOT" && npm_run ci --include=dev --no-audit --no-fund --loglevel=error) > "$log" 2>&1; then
    print -ru2 -- "✗ Installing the packages failed. The end of the output:"
    tail -n 25 "$log" | sed 's/^/  /' >&2
    die "Check your internet connection and run this again. The full output is in $log"
  fi
  say "→ Building the app"
  if ! (cd "$ROOT" && npm_run run build:app) >> "$log" 2>&1; then
    print -ru2 -- "✗ The build failed. The end of the output:"
    tail -n 25 "$log" | sed 's/^/  /' >&2
    die "The full output is in $log"
  fi
  (cd "$ROOT" && npm_run prune --omit=dev --no-audit --no-fund --loglevel=error) >> "$log" 2>&1 || true
}

login_items_note() {
  say ""
  say "  macOS may show \"Background Items Added\" for \"node\". That's Master Tasker."
  say "  It's listed as \"node\" in System Settings > General > Login Items & Extensions (called Login Items"
  say "  before macOS 15). Switching it off there stops it starting when you log in. Turn it back on, or run"
  say "  ./scripts/service.sh start."
}

# Asks this copy's app, as you, the same way the Settings page does. Prints the body, then the HTTP status on the last line.
api() {
  curl -sS --max-time 10 -w '\n%{http_code}' -X "$1" "$URL$2" -H 'x-master-tasker: web' -H 'x-session-id: service-uninstall' -H "origin: $URL" 2>/dev/null || true
}
# One value from a JSON answer, for example integrations.skill.state.
json_get() { plutil -extract "$1" raw -o - - 2>/dev/null || true; }

# While this copy is still running, it undoes Set up Claude Code and Add to Claude Desktop itself, the way
# their Remove buttons do. Only this copy's own server is asked, never another app on the port.
disconnect_claude() {
  if ! { ours && healthy; }; then
    say "Master Tasker isn't running, so it couldn't undo the Claude setups, if any. What's left is listed below."
    return 0
  fi
  local res body skill desktop what route
  res="$(api GET /api/integrations)"
  if [[ "${res##*$'\n'}" != 200 ]]; then
    say "Master Tasker didn't say what's set up, so it couldn't undo the Claude setups, if any. What's left is listed below."
    return 0
  fi
  body="${res%$'\n'*}"
  skill="$(json_get integrations.skill.state <<< "$body")"
  desktop="$(json_get integrations.desktop.state <<< "$body")"
  for what route in "Claude Code" /api/integrations/claude-code "Claude Desktop" /api/integrations/claude-desktop; do
    if [[ "$what" == "Claude Code" ]]; then
      [[ "$skill" == linked ]] || continue
    else
      [[ "$desktop" == connected || "$desktop" == outdated ]] || continue
    fi
    res="$(api DELETE "$route")"
    body="${res%$'\n'*}"
    if [[ "${res##*$'\n'}" == 200 ]]; then
      say "✓ $(json_get message <<< "$body")"
    else
      say "✗ $what: Master Tasker couldn't remove it. $(json_get error.message <<< "$body")"
    fi
  done
}

# Lists what uninstall leaves on this Mac, and how to remove each.
leftovers() {
  local skill="${MT_CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}/master-tasker"
  say ""
  say "Still on this Mac, so nothing is lost:"
  say "  Your tasks and backups: $DATA_DIR"
  say "  Logs: $LOG_DIR"
  [[ -f "$DATA_DIR/claude/token" ]] && say "  The Claude threads token: $DATA_DIR/claude/token"
  [[ -f "$DATA_DIR/review/token" ]] && say "  The daily review token: $DATA_DIR/review/token"
  [[ -d "$DATA_DIR/tokens" ]] && say "  Tokens for your AI assistants: $DATA_DIR/tokens"
  [[ -L "$skill" ]] && say "  The /master-tasker skill link: $skill. Remove it with ./scripts/install-skill.sh uninstall"
  say "  If an AI assistant still lists \"master-tasker\" in its MCP settings, remove it there. That could be Claude, Codex,"
  say "  GitHub Copilot in VS Code, Cursor, Gemini CLI, Windsurf or another app."
  say "  If you switched off a source on a routine, its instructions have one line from Master Tasker. Delete that line in the routine."
  say ""
  say "To delete your tasks and logs for good: in Finder, choose Go > Go to Folder, paste this and press Return:"
  say "  $DATA_DIR"
  say "Then drag that folder to the Trash. Do the same for:"
  say "  $LOG_DIR"
}

# Only one copy of Master Tasker can own the service. If another folder installed it, leave it alone,
# unless that folder is gone: then this copy may take over, or uninstall it.
guard() {
  [[ -f "$PLIST" ]] || return 0
  owned_here && return 0
  local from; from="$(installed_from)"
  if [[ -n "$from" && -d "$from" ]]; then
    die "Another Master Tasker folder owns the service: $from
Run ./scripts/service.sh uninstall from that folder first, or use 'npm run dev' here."
  fi
  [[ "$1" == uninstall ]] && return 0
  say "The service was installed from ${from:-a folder} that no longer exists. It was probably moved or deleted."
  if [[ "$1" != install && "$1" != update ]]; then
    die "Run ./scripts/service.sh install here to move it to this folder, or ./scripts/service.sh uninstall to remove it."
  fi
  if (( YES )); then
    say "Moving it to this folder ($ROOT), as --yes says."
    return 0
  fi
  if [[ -t 0 ]]; then
    local reply=""
    read -r "reply?Move it to this folder ($ROOT)? [y/N] " || true
    [[ "$reply" == [yY]* ]] && return 0
  fi
  die "Nothing changed. Run ./scripts/service.sh install again in Terminal and answer y to move it here."
}

case "$cmd" in
  status|logs|health|open|get-node|free-port|demo|"") ;;
  *)
    if foreign "$LABEL"; then die "A Master Tasker service from another home folder is running. Leaving it alone."; fi
    guard "$cmd"
    ;;
esac

case "$cmd" in
  install)
    say "Checking this Mac"
    check_folder
    say "  ✓ Folder: $ROOT"
    find_node offer
    say "  ✓ Node $("$NODE" --version)"
    check_port
    say "  ✓ Port $PORT"
    build
    say "→ Starting it, and setting it to start when you log in"
    stop >/dev/null 2>&1 || true
    write_plists
    start
    say "  Your data: $DATA_DIR"
    say "  Logs: $LOG_DIR"
    login_items_note
    say ""
    say "Open it any time with ./scripts/service.sh open, or bookmark $URL"
    ;;
  update)
    find_node offer
    check_folder
    [[ -f "$PLIST" ]] || die "Not installed yet. Run: ./scripts/service.sh install"
    check_port
    if [[ -d "$ROOT/.git" ]] && command -v git >/dev/null 2>&1; then
      say "→ Getting the latest version"
      git -C "$ROOT" pull --ff-only || die "git pull didn't work, so nothing changed. If you edited files in this folder, put them aside with: git -C \"$ROOT\" stash"
    else
      say "→ This folder isn't a git checkout, so there's nothing to download here. To update a ZIP copy, download"
      say "  the new ZIP, rename this folder (for example to master-tasker-old), put the new folder in its place with"
      say "  the same name, and double-click Install Master Tasker.command in it. Rebuilding this copy for now."
    fi
    build
    # A new plist only takes effect after launchd unloads the old one.
    stop >/dev/null 2>&1 || true
    write_plists
    start
    ;;
  start) start ;;
  stop) stop ;;
  restart) restart ;;
  open)
    if ours && healthy; then
      open "$URL"
      say "✓ Opened $URL"
    elif healthy; then
      die "Something else is answering at $URL, not this Master Tasker, so it wasn't opened.
It may be another copy of Master Tasker (maybe 'npm start' in a Terminal window) or another app."
    else
      die "Master Tasker isn't running at $URL. Start it with: ./scripts/service.sh start"
    fi
    ;;
  status)
    from="$(installed_from)"
    if [[ -n "$from" ]]; then say "  installed from: $from"; else say "  not installed"; fi
    if loaded "$LABEL"; then
      launchctl print "$DOMAIN/$LABEL" | grep -E '^[[:space:]]+(state|pid|last exit code|runs) =' | sed 's/^[[:space:]]*/  /'
    else say "  not loaded"; fi
    if ours && healthy; then say "  health: $(curl -fsS --max-time 3 "$URL/api/health")"
    elif healthy; then say "  health: something else is answering at $URL, not this Master Tasker (another copy, or another app)"
    else say "  health: not responding at $URL"; fi
    ;;
  health) find_node && cd "$ROOT" && MT_PORT="$PORT" "$NODE" server/cli.ts health ;;
  logs)
    mkdir -p "$LOG_DIR"
    touch "$LOG_DIR/launchd.err.log" "$LOG_DIR/server.log"
    say "Showing both logs: startup errors (launchd.err.log) and the server log (server.log)."
    say "New lines appear as they're written. Press Control-C to stop."
    tail -n 30 -F "$LOG_DIR/launchd.err.log" "$LOG_DIR/server.log"
    ;;
  uninstall)
    disconnect_claude
    stop >/dev/null 2>&1 || true
    rm -f "$PLIST" "$HC_PLIST"
    say "✓ Removed the background service. Master Tasker won't start at login any more."
    leftovers
    ;;
  get-node)
    get_node || die "Or install Node.js for the whole Mac: open $NODE_LINK and press macOS Installer (.pkg), not the commands."
    ;;
  free-port)
    taken="$PORT"
    for (( p = taken + 1; p <= taken + 100 && p <= 65535; p++ )); do
      PORT="$p"
      if ! port_in_use; then say "$p"; exit 0; fi
    done
    exit 1
    ;;
  demo) find_node && cd "$ROOT" && PATH="${NODE:h}:$PATH" exec "$NODE" scripts/demo.mjs ;;
  *)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    [[ -z "$cmd" ]] && exit 0
    exit 1
    ;;
esac
