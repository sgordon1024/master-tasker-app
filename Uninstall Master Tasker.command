#!/bin/zsh
# Double-click this file in Finder to uninstall Master Tasker from this Mac.
# It runs ./scripts/service.sh uninstall: it undoes the Claude setups, if any, while Master Tasker is still running,
# then stops it and removes it from your login items. Your tasks stay on this Mac, and it lists what's left.
cd "$(dirname "$0")" || exit 1

print "This undoes the Claude setups, if any, stops Master Tasker, and stops it starting when you log in."
print "Your tasks stay on this Mac."
print ""
print -n -- "Uninstall Master Tasker? [y/N] "
reply=""
read -r reply || print ""
if [[ "$reply" != [yY]* ]]; then
  print "Nothing changed. You can close this window."
  exit 0
fi
print ""

if ! /bin/zsh ./scripts/service.sh uninstall; then
  print ""
  print "Master Tasker isn't uninstalled. The message above says why."
  exit 1
fi
print ""
print "To remove the app itself, drag this Master Tasker folder to the Trash. You can close this window."
