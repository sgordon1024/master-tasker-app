#!/bin/zsh
# Sets up the /master-tasker skill for your Claude Code threads. The app does the same thing from
# Settings > AI assistants > Set up Claude Code; this is the Terminal way.
#   ./scripts/install-skill.sh             set it up (safe to run again)
#   ./scripts/install-skill.sh uninstall   remove the link, the token file and the settings file
#
# What it does, and nothing more:
#   - creates a "Claude threads" connection in Master Tasker (read, update, complete, start; all areas)
#     and saves its token to <data folder>/claude/token, readable only by you. If a saved token has
#     stopped working (you revoked or deleted its connection), it makes a new one and says so.
#   - links ~/.claude/skills/master-tasker to the skill in this folder, so every Claude Code thread can use it
#   - writes claude/skills/master-tasker/.local.env: this copy's data folder, address and node,
#     so the skill reaches the right app
#   - turns on linking Claude threads to tasks, as the app's button does (Settings > AI assistants switches it off)
# It talks only to Master Tasker on 127.0.0.1. Remove its access any time in Settings > AI assistants.
#
# Env: MT_PORT and MT_DATA_DIR (default: what the installed service uses, else 4820 and
# ~/Library/Application Support/MasterTasker), MT_NODE (default: the Node the service runs with), and
# MT_CLAUDE_SKILLS_DIR (default ~/.claude/skills).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SKILL_DIR="$ROOT/claude/skills/master-tasker"
PLIST="$HOME/Library/LaunchAgents/local.master-tasker.server.plist"
# What you set, else what the installed service uses, else the default. The same as setting() in
# scripts/service.sh, so the skill reaches a service installed with its own MT_PORT or MT_DATA_DIR.
setting() {
  local v="${(P)1:-}"
  [[ -z "$v" && -f "$PLIST" ]] && v="$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$1" "$PLIST" 2>/dev/null || true)"
  print -r -- "${v:-$2}"
}
DATA_DIR="$(setting MT_DATA_DIR "$HOME/Library/Application Support/MasterTasker")"
DATA_DIR="${DATA_DIR:a}"
TOKEN_FILE="$DATA_DIR/claude/token"
SKILLS_DIR="${MT_CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
SKILL_LINK="$SKILLS_DIR/master-tasker"
LOCAL_ENV="$SKILL_DIR/.local.env"
BASE="http://127.0.0.1:$(setting MT_PORT 4820)"

say() { print -r -- "$@"; }
die() { print -ru2 -- "$@"; exit 1; }
# Single-quotes a value for .local.env, escaping any single quotes inside it.
sq() { local s=${1//\'/\'\\\'\'}; print -r -- "'$s'"; }

# The physical folder a link points at, or nothing if it points at something that's gone.
link_target() { (cd "$1" 2>/dev/null && pwd -P) || true; }

if [[ "${1:-}" == "uninstall" ]]; then
  # The token file is shared by every copy that uses this data folder. Leave it to the copy that owns the skill.
  if [[ -L "$SKILL_LINK" && -n "$(link_target "$SKILL_LINK")" && "$(link_target "$SKILL_LINK")" != "$SKILL_DIR" ]]; then
    die "The skill belongs to another Master Tasker folder ($(link_target "$SKILL_LINK")). Run ./scripts/install-skill.sh uninstall from there."
  fi
  if [[ -L "$SKILL_LINK" ]]; then rm "$SKILL_LINK" && say "Removed the skill link $SKILL_LINK"; fi
  if [[ -f "$TOKEN_FILE" ]]; then rm "$TOKEN_FILE" && say "Removed the token file $TOKEN_FILE"; fi
  if [[ -f "$LOCAL_ENV" ]]; then rm "$LOCAL_ENV" && say "Removed $LOCAL_ENV"; fi
  say "Last step: remove access for \"Claude threads\" in Master Tasker > Settings > AI assistants."
  exit 0
fi
[[ -z "${1:-}" ]] || die "Usage: ./scripts/install-skill.sh [uninstall]"

# Node 24 or newer: MT_NODE if you set it, else the one the service runs with, else the one
# ./scripts/service.sh get-node downloaded, else the stable links that survive upgrades.
NODE=""
if [[ -n "${MT_NODE:-}" ]]; then
  try=("$MT_NODE")
else
  try=("$([[ -f "$PLIST" ]] && /usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$PLIST" 2>/dev/null || true)" "$ROOT/.node/bin/node" /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null || true)")
fi
for c in "${try[@]}"; do
  [[ -n "$c" && -x "$c" ]] || continue
  if (( $("$c" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0) >= 24 )); then NODE="$c"; break; fi
done
if [[ -z "$NODE" && -n "${MT_NODE:-}" ]]; then
  die "MT_NODE is $MT_NODE, which isn't Node.js 24 or newer. Point it at another Node, or leave it out."
fi
[[ -n "$NODE" ]] || die "Master Tasker needs Node.js 24 or newer, and this Mac doesn't have it.
Run ./scripts/service.sh install, which offers to download a private copy just for Master Tasker, then run this again."

# Only one Master Tasker folder can own the skill. Don't take it over from another one, and don't reuse its token.
if [[ -L "$SKILL_LINK" ]]; then
  current="$(link_target "$SKILL_LINK")"
  if [[ -z "$current" ]]; then
    say "The old skill link pointed at $(readlink "$SKILL_LINK"), which no longer exists. Replacing it."
  elif [[ "$current" != "$SKILL_DIR" ]]; then
    die "$SKILL_LINK already points to $current, another copy of the skill, so I'm leaving it alone.
Run ./scripts/install-skill.sh uninstall from that folder first."
  fi
elif [[ -e "$SKILL_LINK" ]]; then
  die "$SKILL_LINK is a real folder, not a link, so I'm leaving it alone.
If you don't need it, move it somewhere else, then run this again."
fi

if ! curl -fsS --max-time 5 "$BASE/api/health" >/dev/null 2>&1; then
  die "Master Tasker isn't running at $BASE.
Start it with ./scripts/service.sh start (or install it first with ./scripts/service.sh install), then run this again."
fi

# Asks the app as you, the same way the Settings page does. Prints the body, then the HTTP status on the last line.
ask() {
  curl -sS --max-time 10 -w '\n%{http_code}' "$@" || die "Couldn't reach Master Tasker at $BASE. Is it still running? Check with ./scripts/service.sh status"
}

create_token() {
  local res code body token
  res="$(ask -X POST "$BASE/api/clients" \
    -H 'x-master-tasker: web' -H 'x-session-id: install-skill' -H "origin: $BASE" -H 'content-type: application/json' \
    -d '{"name":"Claude threads","kind":"claude","scopes":{"areas":"*","unfiled":true,"perms":["read","update","complete","start"]}}')"
  code="${res##*$'\n'}"
  body="${res%$'\n'*}"
  [[ "$code" == 200 ]] || die "Master Tasker didn't create the connection (HTTP $code): $body"
  token="$(print -r -- "$body" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token||""))')"
  [[ "$token" == mt_* ]] || die "Master Tasker answered, but without a token: $body"
  mkdir -p "$(dirname "$TOKEN_FILE")"
  chmod 700 "$(dirname "$TOKEN_FILE")"
  (umask 077 && print -rn -- "$token" > "$TOKEN_FILE.tmp")
  chmod 600 "$TOKEN_FILE.tmp"
  mv "$TOKEN_FILE.tmp" "$TOKEN_FILE"
}

if [[ -f "$TOKEN_FILE" ]]; then
  chmod 600 "$TOKEN_FILE"
  token="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  # The header goes to curl on stdin (print is built in), not on its command line, where anyone on this Mac could see it.
  res="$(print -r -- "authorization: Bearer $token" | ask -H @- "$BASE/api/whoami")"
  code="${res##*$'\n'}"
  if [[ "$code" == 200 ]]; then
    say "✓ The Claude threads connection already works. Kept its token at $TOKEN_FILE"
  elif [[ "$code" == 401 ]]; then
    create_token
    say "✓ Your old Claude threads token stopped working (its connection was revoked or deleted), so I made a new one."
    say "  Token saved to $TOKEN_FILE, readable only by you."
  else
    die "Master Tasker answered with HTTP $code when checking the saved token. Try again in a moment."
  fi
else
  create_token
  say "✓ Created the \"Claude threads\" connection. Token saved to $TOKEN_FILE, readable only by you."
fi

# Where the skill finds this copy of the app.
{
  say "# Written by scripts/install-skill.sh (or Settings > AI assistants). Safe to delete; run either again to rewrite it."
  say "MT_DATA_DIR=$(sq "$DATA_DIR")"
  say "MASTER_TASKER_URL=$(sq "$BASE")"
  say "MT_NODE=$(sq "$NODE")"
} > "$LOCAL_ENV.tmp"
mv "$LOCAL_ENV.tmp" "$LOCAL_ENV"
say "✓ Saved this copy's address, data folder and node in $LOCAL_ENV"

mkdir -p "$SKILLS_DIR"
ln -sfn "$SKILL_DIR" "$SKILL_LINK"
say "✓ Linked $SKILL_LINK to this folder's skill"

# Same as Set up Claude Code in the app: let the app link threads that mention a task to that task.
res="$(ask -X PATCH "$BASE/api/settings" -H 'x-master-tasker: web' -H 'x-session-id: install-skill' -H "origin: $BASE" -H 'content-type: application/json' -d '{"threadLinking":true}')"
if [[ "${res##*$'\n'}" == 200 ]]; then
  say "✓ Turned on linking Claude threads to tasks. Master Tasker reads Claude Code's thread history on this Mac"
  say "  only to find threads that mention a task. Switch it off in Settings > AI assistants."
fi

# Check the whole chain the way a Claude thread will use it: link, runner, settings, node and token.
# A made-up task id should come back "not found" from the app.
check="$("$SKILL_LINK/ticket" get t_00000000000000 2>&1 || true)"
if [[ "$check" == *"not found"* ]]; then
  say "✓ Checked: the skill reaches Master Tasker."
else
  die "The skill couldn't reach Master Tasker. It said: $check"
fi

say ""
say "Done. Open a task in Master Tasker and press Work on this with Claude, or type /master-tasker and a task id in Claude Code."
if ! command -v claude >/dev/null 2>&1 && [[ ! -d /Applications/Claude.app ]]; then
  say "Claude isn't on this Mac yet. The skill is ready for when it is: https://claude.ai/download"
fi
