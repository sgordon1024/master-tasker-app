#!/bin/zsh
# Double-click this file in Finder to install Master Tasker on this Mac, then open it.
# It runs ./scripts/service.sh install, and helps with what would stop it: it offers to move this folder out of
# Downloads, Desktop, Documents or iCloud Drive, and to use the next free port if another app has Master Tasker's.
# service.sh itself offers to download Node.js. Safe to run again: it updates the install in place.
cd "$(dirname "$0")" || exit 1

# Yes, unless they answer no.
yes_to() {
  local reply=""
  print -n -- "$1 [Y/n] "
  read -r reply || { print ""; return 1; }
  [[ -z "$reply" || "$reply" == [yY]* ]]
}

# macOS keeps background apps out of these folders. They're the ones check_folder in scripts/service.sh
# refuses. Change both together.
here="$(pwd -P)"
home="$(cd "$HOME" && pwd -P)"
place=""
case "$here/" in
  "$home/Desktop/"*) place="Desktop" ;;
  "$home/Documents/"*) place="Documents" ;;
  "$home/Downloads/"*) place="Downloads" ;;
  "$home/Library/Mobile Documents/"*) place="iCloud Drive" ;;
esac
if [[ -n "$place" && "${MT_SKIP_FOLDER_CHECK:-}" != 1 ]]; then
  target="$home/master-tasker"
  print "This Master Tasker folder is in your $place folder. macOS keeps background apps out of $place,"
  print "so Master Tasker couldn't start on its own when you log in. It needs to be in your home folder."
  print ""
  if [[ -e "$target" ]]; then
    print "Your home folder already has a folder called master-tasker, so nothing was moved."
    print "If it's an older Master Tasker, rename it (for example to master-tasker-old), then double-click"
    print "Install Master Tasker.command here again."
    exit 1
  fi
  if yes_to "Move Master Tasker to your home folder now?" && mv "$here" "$target"; then
    print "✓ Moved it to $target"
    print ""
    exec /bin/zsh "$target/${0:t}"
  fi
  print ""
  print "Nothing was moved. To move it yourself: in Finder, select the ${here:t} folder, press Command-C,"
  print "choose Go > Home, then press Command-Option-V. Then double-click Install Master Tasker.command there."
  exit 1
fi

print "Installing Master Tasker. This takes a few minutes. Leave this window open."
print ""
/bin/zsh ./scripts/service.sh install
code=$?

# Another app has the port: offer the next free one.
new_port=""
if (( code == 4 )); then
  port="$(/bin/zsh ./scripts/service.sh free-port)"
  print ""
  if [[ -z "$port" ]]; then
    print "There's no free port nearby either. Quit the app that's using it, then double-click Install Master Tasker again."
    exit 1
  fi
  if ! yes_to "Use port $port instead?"; then
    print ""
    print "Nothing changed. Quit the app that's using the port, then double-click Install Master Tasker again."
    exit 1
  fi
  print ""
  export MT_PORT="$port"
  /bin/zsh ./scripts/service.sh install
  code=$?
  new_port="$port"
fi

if (( code == 3 )); then
  print ""
  print "Opening the Node.js download page in your browser. Press macOS Installer (.pkg), not the commands,"
  print "then open the file it downloads and follow the steps. Then double-click Install Master Tasker again."
  open "https://nodejs.org/en/download"
  exit 1
elif (( code != 0 )); then
  print ""
  print "Master Tasker isn't installed yet. The message above says what to do."
  exit 1
fi

if [[ -n "$new_port" ]]; then
  print ""
  print "Master Tasker uses port $new_port, so its address is http://127.0.0.1:$new_port"
  print "If you connected an AI assistant before, open Settings > AI assistants."
  print "Claude: press Set up again. If Claude Desktop says Needs update there, press Update too."
  print "Other apps: press Show settings and paste them into the app again."
fi
print ""
if /bin/zsh ./scripts/service.sh open >/dev/null; then
  print "Master Tasker is open in your browser. You can close this window."
else
  print "Master Tasker is installed, but didn't open. The message above says why."
fi
