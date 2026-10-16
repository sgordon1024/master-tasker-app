# Master Tasker, for AI assistants

This file is for an AI assistant that a person asked to install Master Tasker, connect it to an AI assistant (you or another app), or fix it. If you were asked to change Master Tasker's code, read [CONTRIBUTING.md](CONTRIBUTING.md) first and follow it.

Master Tasker is a task app that runs on the person's own Mac. It's a Node server (Node 24 or newer) that runs as a per-user LaunchAgent on `http://127.0.0.1:4820`. Their tasks live in `~/Library/Application Support/MasterTasker/`, not in this folder.

The person may be new to Terminal. Say what each step does in plain words before you run it, and tell them what they'll see.

## Install it

1. **Check the folder.** Master Tasker can't run from Desktop, Documents, Downloads or iCloud Drive, because macOS keeps background apps out of them. If this folder is in one of them, ask the person to double-click **Install Master Tasker.command** and answer yes when it offers to move the folder to `~/master-tasker`. Or they can move it in Finder: select the folder, press Command-C, choose Go > Home, then press Command-Option-V. Then continue from the new place.
2. **Check Node.** Run `node --version`. It needs `v24` or higher. If it's missing or older, ask the person which they'd like: a private copy just for Master Tasker (`./scripts/service.sh get-node`, about 50 MB into `.node` in this folder, no password), or Node.js for the whole Mac from https://nodejs.org/en/download (they press **macOS Installer (.pkg)**, not the commands). Don't install Homebrew or nvm for them unless they ask.
3. **Install.** In this folder, run `./scripts/service.sh install`. It takes a few minutes. It checks the Mac first, then installs, builds and starts the app, and sets it to start at login. If it stops, its message says why and what to do. [docs/OPERATIONS.md](docs/OPERATIONS.md) ("When install stops") has more.
4. **Open it.** Run `./scripts/service.sh open`.

`service.sh` asks a question in a few places, such as before it moves the service to this folder. Your command runner can't answer it, so it stops there. Either ask the person to run that step in Terminal themselves and answer `y`, or, once they've said yes to you, run it with `--yes` (for example `./scripts/service.sh install --yes`). Don't add `--yes` without asking.

If another app uses port 4820, install stops. Double-clicking **Install Master Tasker.command** offers the next free port. From Terminal, `./scripts/service.sh free-port` prints a free one, and `MT_PORT=4830 ./scripts/service.sh install` installs on that port (use the number it printed).

Install it this way only. `npm run dev` uses a throwaway database, and `npm start` stops when Terminal closes, so the person would lose their tasks or the app.

## Connect an AI assistant

The best way is in the app: **Settings > AI assistants**. Ask the person which app they use, then ask them to pick it there. The apps listed are Claude, Codex (ChatGPT), GitHub Copilot (VS Code), Cursor, Gemini CLI, Windsurf (Devin Desktop) and Other app. Each one gets its own access, and the person chooses what it may see and do.

For every app except Claude, Master Tasker then shows the settings to paste, with this Mac's paths filled in, and says where they go. If the person asks you to paste them for them, back up that app's settings file first, add only the `master-tasker` entry, and keep every other entry. The settings name a token file (`MASTER_TASKER_TOKEN_FILE`). Never swap that for the token itself. To do it all by hand, follow [docs/MCP.md](docs/MCP.md).

To work a task, the app needs a connection with **Let it work on tasks** on. [docs/AI-ASSISTANTS.md](docs/AI-ASSISTANTS.md) says how to start work in each app.

### Claude

In **Settings > AI assistants**, the person picks **Claude**. Ask them to press **Set up Claude Code**, and **Add to Claude Desktop** if they use Claude chats. Each button says what it changes and can be undone.

From Terminal, `./scripts/install-skill.sh` does the same as Set up Claude Code. Run it from this folder while the app is running.

For Claude Desktop, use the app's button rather than editing `claude_desktop_config.json`. If you must edit it by hand, back it up first, add only the `master-tasker` entry inside `mcpServers`, and keep every other entry. Then the person must quit Claude fully (Command-Q) and open it again.

The Claude extras need the Claude desktop app or Claude Code, and both need a paid Claude plan. The rest of Master Tasker works without them.

## Never do these

- Don't edit or delete the database, or anything in `~/Library/Application Support/MasterTasker/`. Use the app, `npm run cli`, or a backup. Only delete that folder if the person asks to delete their tasks for good.
- Don't show, paste, log or commit tokens: the `token` files in the data folder, `claude/skills/master-tasker/.local.env`, or the `MASTER_TASKER_TOKEN` in any app's settings. Never put one in a URL.
- Don't use `sudo`. Nothing here needs it.
- Don't set `MT_ALLOW_NETWORK` or change `MT_HOST`. Master Tasker must only listen on this Mac.
- Don't work around a refusal from `service.sh` or `install-skill.sh`, such as "Another Master Tasker folder owns the service" or "another copy of the skill". Explain it to the person and let them choose.
- Don't check off Needs you items, accept or reject suggestions in For you, or give, change or remove an assistant's access in Settings > AI assistants for the person. Those are theirs.
- Don't run `./scripts/service.sh logs` and wait. It follows the logs until Control-C. Read them with `tail -n 50` instead (paths below).

## Check that it works

- `./scripts/service.sh status` shows `state = running` and a `health:` line with JSON.
- `curl -s http://127.0.0.1:4820/api/health` returns JSON with `"db":"ok"`.
- `./scripts/install-skill.sh` ends with "✓ Checked: the skill reaches Master Tasker."
- In any connected app, ask it to call the Master Tasker `whoami` tool. It answers with the connection's name, the areas it can see and what it may do. If the app has no Master Tasker tools, it hasn't loaded the server: check the paths in its settings, then quit the app and open it again.
- For Claude, the status card in Settings > AI assistants shows each piece as set up, added or installed. In Claude Code, `/master-tasker` is a command. If you added the MCP server, `/mcp` lists `master-tasker` as connected.

## When something is wrong

- **Logs:** `~/Library/Logs/MasterTasker/launchd.err.log` (startup errors), `server.log` (the app), `install.log` (the last install or update).
- **Restart:** `./scripts/service.sh restart`.
- **"isn't running":** `./scripts/service.sh start`, then check status.
- **Moved the folder:** install again from the new place. It asks before it moves the service there, so ask the person to run `./scripts/service.sh install` in Terminal and answer `y`, or run `./scripts/service.sh install --yes` once they've said yes. Then, in Settings > AI assistants, press Set up again for Claude, if it was set up. For other apps, press **Show settings** on the app's row and paste them into the app again, since the folder's path is in them.
- **An assistant says its connection was removed or deleted:** for Claude, press Set up again in Settings > AI assistants, or run `./scripts/install-skill.sh` again. For other apps, ask the person to connect the app again there, then paste the new settings.
- **Uninstall:** the person can double-click **Uninstall Master Tasker.command**, or you can run `./scripts/service.sh uninstall`. While the app is running it undoes the Claude setups first, if any (the Claude Code skill and the Claude Desktop entry), then removes the service. It keeps the tasks and lists what's left. Other apps keep their `master-tasker` entry until it's removed from their settings. Don't delete the data folder unless the person asks.
