# Operations

## Where things live

Your data is outside the Master Tasker folder, so you can move, replace or update that folder without losing anything.

| What | Where |
| --- | --- |
| Database | `~/Library/Application Support/MasterTasker/master-tasker.db` (SQLite, WAL mode) |
| Backups | `~/Library/Application Support/MasterTasker/backups/` |
| Source switches | `~/Library/Application Support/MasterTasker/sources.json` |
| Claude threads token | `~/Library/Application Support/MasterTasker/claude/token`, readable only by you. The `/master-tasker` command uses it |
| Connection tokens | `~/Library/Application Support/MasterTasker/tokens/`, one file per connection, readable only by you. Claude Desktop's entry, and the settings to paste that Settings > AI assistants shows for other apps, name these files (`MASTER_TASKER_TOKEN_FILE`), so the tokens stay out of app settings and Terminal history. Removing an assistant's access deletes its file |
| Daily review | `~/Library/Application Support/MasterTasker/review/` (its token, run files and `log.jsonl`) and `devscan/` (`folders.txt`, the code folders it watches, and `state.json`) |
| Server log | `~/Library/Logs/MasterTasker/server.log` (JSON lines, rotated at 2 MB, 5 kept) |
| Startup errors | `~/Library/Logs/MasterTasker/launchd.{out,err}.log` (rotated at startup) |
| Install log | `~/Library/Logs/MasterTasker/install.log` (the last install or update) |
| Health check log | `~/Library/Logs/MasterTasker/healthcheck.log` (trimmed at 256 KB) |
| LaunchAgents | `~/Library/LaunchAgents/local.master-tasker.server.plist` and `local.master-tasker.healthcheck.plist` |
| Private Node.js | `.node/` in the Master Tasker folder, if you chose the private copy. Only Master Tasker uses it, and git ignores it |
| Skill link | `~/.claude/skills/master-tasker`, a link to `claude/skills/master-tasker` in the Master Tasker folder |
| Skill settings | `claude/skills/master-tasker/.local.env` in the Master Tasker folder: the data folder, address and Node that the `/master-tasker` command uses. Written by Set up Claude Code or `./scripts/install-skill.sh`. Never committed |
| Claude Desktop entry | `~/Library/Application Support/Claude/claude_desktop_config.json`, the `master-tasker` entry. It names its token file, never the token. Add to Claude Desktop, and Update, back the file up next to it first |

## The background service

`./scripts/service.sh` runs Master Tasker as a per-user LaunchAgent. Run it in Terminal, in the Master Tasker folder.

| Command | What it does |
| --- | --- |
| `install` | Checks the folder, Node and the port first. With no Node.js 24, it offers to download a private copy. Then installs what it needs, builds the app, and starts it now and at every login. Safe to run again |
| `open` | Opens Master Tasker in your browser, if this copy's service is running. If something else answers on its port, it says so and doesn't open it |
| `update` | Runs `git pull` (in a git checkout), installs, builds and restarts. A ZIP copy is updated by hand: see [Update a ZIP copy](#update-a-zip-copy) |
| `get-node` | Downloads Node.js 24 into `.node` in this folder, just for Master Tasker, with no password. It checks the download against the checksums nodejs.org publishes and keeps nothing that doesn't match |
| `start`, `stop`, `restart` | `stop` lasts until you log in again |
| `status` | The folder it was installed from, what launchd says, and the health check. If something else answers on the port, it says so |
| `logs` | Shows the startup errors and the server log as they're written. Control-C stops it |
| `health` | The full health report |
| `demo` | A throwaway copy with made-up tasks at http://127.0.0.1:4870, the same as `npm run demo`. Control-C stops it and deletes it. Your tasks aren't touched |
| `free-port` | Prints the next free port after Master Tasker's. The double-click installer uses it |
| `uninstall` | While the app is running, it undoes the Claude setups first, if any: it removes the `/master-tasker` skill and the Claude Desktop entry, the same as the Remove buttons for Claude in Settings > AI assistants. Then it stops the app and removes the LaunchAgents. Keeps your data, and lists what's left on the Mac and how to remove each thing, including the `master-tasker` entry in other assistants' settings |

`Install Master Tasker.command` runs `install` and then `open`, for people who'd rather double-click. It offers to move the folder and to use the next free port when those stop the install. `Uninstall Master Tasker.command` asks first, then runs `uninstall`.

`install` and `update` ask before a few things, such as moving the service to this folder. With no Terminal to answer in, for example when an assistant runs them, they stop there. `--yes` answers yes: `./scripts/service.sh install --yes`.

`update`, and running `install` again, keep the `MT_PORT`, `MT_DATA_DIR` and `MT_LOG_DIR` the service was installed with. You only set them again to change them.

What install does, and nothing more: it writes the two LaunchAgents, with no sudo. The app listens on `127.0.0.1` only. It doesn't change sleep, battery, firewall or security settings.

Install and update build the app with `npm run build:app`, which runs Vite only. `npm run build` also typechecks, for development. Then they run `npm prune --omit=dev`, which removes the development packages (Vite, TypeScript and the test tools) to keep the folder small. To develop in that folder, run `npm install` first.

The LaunchAgent starts Node with `--no-warnings=ExperimentalWarning`, so the notice some Node versions print that SQLite is experimental doesn't fill `launchd.err.log`, and `service.sh` leaves it out when it shows startup errors.

If you use the private copy of Node.js, `npm` isn't on your PATH. Before the `npm run` commands on this page, run this once in the same Terminal window, in the Master Tasker folder:

```bash
export PATH="$PWD/.node/bin:$PATH"
```

### When install stops

It checks everything it can before it changes anything, and says what to do:

- **The folder is in Desktop, Documents, Downloads or iCloud Drive.** macOS keeps background apps out of those folders, so it couldn't start at login. The double-click installer offers to move it to `~/master-tasker`, unless a folder by that name is already there. Or move it yourself: in Finder, select the folder, press Command-C, choose Go > Home, then press Command-Option-V. `MT_SKIP_FOLDER_CHECK=1` skips this check, if you know your Mac allows it.
- **No Node, or Node older than 24.** It offers to download a private copy just for Master Tasker (about 50 MB, no password). Answer `y`, or run `./scripts/service.sh get-node`. Or install Node.js for the whole Mac from [nodejs.org/en/download](https://nodejs.org/en/download): press **macOS Installer (.pkg)**, not the commands. If you say no to the private copy, the double-click installer opens that page for you.
- **The port is in use.** It exits with code 4. The double-click installer then offers the next free port. In Terminal, quit whatever is using it, or pick another port: `./scripts/service.sh free-port` prints one, then run `MT_PORT=4830 ./scripts/service.sh install` with that number. Then open Settings > AI assistants. For Claude, press Set up again, and Update if Claude Desktop chat says Needs update. For other apps, press Show settings and paste them into the app again. That way each assistant uses the new port too.
- **The build failed.** It shows the end of `install.log`. Run install again. If it keeps failing, the full log says why.
- **It started but isn't healthy.** It prints the last lines of `launchd.err.log` and `server.log`. "Operation not permitted" means the folder is somewhere macOS protects.

### Login Items & Extensions

macOS lists Master Tasker as "node" in System Settings > General > Login Items & Extensions (called Login Items before macOS 15), and may show "Background Items Added" for "node" when you install. Switching it off there stops it starting at login. Turn it back on, or run `./scripts/service.sh start`.

### Moved or renamed the folder

The service remembers the folder it was installed from. If that folder is gone, run `./scripts/service.sh install` from the new place and answer `y` to move the service there, or run `./scripts/service.sh install --yes`. It keeps the port and folders it was installed with. Then open Settings > AI assistants. For Claude, press Set up again, and Update if Claude Desktop chat says Needs update. For other apps, press Show settings and paste them into the app again. `uninstall` always works.

If another Master Tasker folder that still exists owns the service, the script leaves it alone. Run uninstall from that folder first.

### Update a ZIP copy

`update` runs `git pull` only in a git checkout. In a copy from a ZIP, it rebuilds what's there. To get a new version:

1. Download the new ZIP.
2. Rename your Master Tasker folder, for example to `master-tasker-old`.
3. Put the new folder in its place, with the old folder's name.
4. Double-click **Install Master Tasker.command** in the new folder. It replaces the service, and offers Node.js again if the old folder had the private copy.

Your data isn't in that folder, so nothing is lost. If Settings > AI assistants says Set up again for Claude, press it. Then drag the old folder to the Trash.

## Configuration

### The app

`install` writes `MT_PORT`, `MT_DATA_DIR` and `MT_LOG_DIR` into the LaunchAgent, so set them when you run it, for example `MT_PORT=4830 ./scripts/service.sh install`. After that, `update` and `install` again read them from the LaunchAgent when you don't set them, and `install-skill.sh` and `npm run cli` read the port and data folder from there too. Set the others in the LaunchAgent's `EnvironmentVariables`, or in your shell for `npm start`. The defaults are fine for almost everyone.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MT_PORT` | `4820` | Port on 127.0.0.1 |
| `MT_HOST` | `127.0.0.1` | Bind address. Non-loopback addresses are refused unless `MT_ALLOW_NETWORK=1` |
| `MT_DATA_DIR` | see above | Database, backups and tokens |
| `MT_LOG_DIR` | see above | Logs |
| `MT_SEED` | `1` | Create labeled sample data on first run. `0` to start empty |
| `MT_FIRST_RUN` | `1` | Show the first-run setup screen on a new install. `0` marks setup done at startup, keeping the sample data as it is |
| `MT_BACKUP_INTERVAL_HOURS` | `24` | Automatic backup interval |
| `MT_BACKUP_KEEP` | `14` | Automatic backups kept. Safety backups (`pre-*`) are kept 90 days, and the 10 newest are always kept |
| `MT_CLAUDE_SKILLS_DIR` | `~/.claude/skills` | Where Set up Claude Code (and `install-skill.sh`) links the `/master-tasker` skill |
| `MT_CLAUDE_DESKTOP_CONFIG` | `~/Library/Application Support/Claude/claude_desktop_config.json` | The Claude Desktop settings file that Add to Claude Desktop changes |
| `MT_CLAUDE_APP_PATH` | `/Applications/Claude.app`, then `~/Applications/Claude.app` | Where to look for the Claude app. Only checked for, never opened or changed |
| `MT_CLAUDE_BIN` | found on its own | The `claude` command, for Ask. Empty means "not installed" |
| `MT_CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Claude Code's thread history, for linking threads to tasks |

### The scripts and command-line tools

`scripts/install-skill.sh`, `automation/*.ts` (the `/master-tasker` command, the daily review and the source check) and `mcp/server.ts` all find the app the same way.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MASTER_TASKER_URL` | `http://127.0.0.1:$MT_PORT` | Where the app is. Must be a loopback address |
| `MT_PORT` | `4820` | Used when `MASTER_TASKER_URL` isn't set. `install-skill.sh` uses the installed service's port when this isn't set |
| `MT_DATA_DIR` | `~/Library/Application Support/MasterTasker` | Where the tools keep their tokens. `install-skill.sh` uses the installed service's folder when this isn't set |
| `MT_NODE` | `.node/bin/node` in the Master Tasker folder, then `/opt/homebrew/bin/node`, `/usr/local/bin/node`, then `node` on your PATH. `install-skill.sh` tries the service's Node first | The Node that `service.sh`, `install-skill.sh` and the `/master-tasker` command run. If you set it, `service.sh` and `install-skill.sh` use only that one |
| `MT_NODE_DIST` | `https://nodejs.org/dist` | Where `get-node` downloads Node.js from, for a mirror or for tests. It needs the same layout and `SHASUMS256.txt` |
| `MT_CLAUDE_SKILLS_DIR` | `~/.claude/skills` | Where `install-skill.sh` links the skill |
| `MT_DEV_ROOTS` | none | Code folders for the daily review, separated by `:`. Overrides `devscan/folders.txt` |
| `MT_SKIP_FOLDER_CHECK` | unset | `1` lets `service.sh install` run from Desktop, Documents, Downloads or iCloud Drive |

The `/master-tasker` command reads `claude/skills/master-tasker/.local.env`, so it finds the right app even when Claude runs it from another folder. Set up Claude Code writes that file with the app's real data folder, address and Node.

## Health

```bash
./scripts/service.sh status
```

```bash
curl -s http://127.0.0.1:4820/api/health
```

`/api/health` reports the version, uptime, schema version, change counter, open live connections, last backup time, and a SQLite `quick_check` result.

Two layers keep it running:

1. **launchd** restarts the process if it crashes or is killed (`KeepAlive` with `SuccessfulExit = false`, `ThrottleInterval = 10` seconds). A clean `stop` is not restarted.
2. **The health check agent** runs every 5 minutes. If the server is up but fails health twice in a row (hung, not crashed), it restarts it.

Sleep: nothing runs while the Mac sleeps, and nothing is configured to wake it. On wake, the server carries on. Its backup timer checks every 10 minutes and catches up on a missed daily backup. Browser tabs notice the gap, reconnect and sync what changed.

## Backups

- **Automatic:** daily, checked every 10 minutes.
- **Safety backups:** before every schema migration (`pre-migration-…`), import (`pre-import`) and restore (`pre-restore`).
- **Manual:** Settings > Backups > Back up now, or `npm run cli -- backup` (safe while running).

Backups are made with SQLite `VACUUM INTO`, which writes a consistent copy even while the app is in use.

```bash
npm run cli -- backups
```

```bash
npm run cli -- verify "$HOME/Library/Application Support/MasterTasker/backups/<file>.db"
```

`verify` opens the file read-only, runs `PRAGMA integrity_check`, and confirms it is a Master Tasker database from this version or older.

## Restore (tested)

**From the app:** Settings > Backups, then press Restore on a backup. The current database is saved as a `pre-restore` backup first. The file is verified, swapped in, and every open tab is told to resync.

**From the terminal:** use this if the app will not start.

```bash
./scripts/service.sh stop
```

```bash
npm run cli -- restore "/path/to/backup.db" --yes
```

```bash
./scripts/service.sh start
```

The CLI refuses to restore while the server is running. It checks a PID lock file, not just whether the server answers, so a hung server cannot be restored underneath. It verifies the backup, saves the current database as `pre-restore`, then replaces it.

Both paths are covered by `tests/durability.test.ts`.

## Export and import

- **Export:** Settings > Backups > Export. This writes every area, project and task, including Trash and subtasks, as JSON. It does not include connection tokens.
- **Import:** Settings > Backups > Import. A `pre-import` backup is written first. Import only adds records that are missing (matched by id) and never overwrites existing ones, so importing the same file twice is harmless. Imported fields go through the same validation as every other write.

## Deleting is recoverable

- Deleting a task moves it to **Trash**. Restore puts it back exactly as it was.
- "Delete forever" in Trash is the only hard delete, and it asks first. Daily backups still contain the task until they age out.
- Areas and projects are archived, never deleted.
- Clearing sample data moves the samples to Trash.
- First-run setup swaps the sample areas and tasks for the ones you pick. It only does that while they're untouched and there's nothing of yours yet. Once there is, setup leaves everything as it is.

## Migrations

Schema versions live in `PRAGMA user_version`. Migrations are in `server/migrations.ts`, run in order at startup, one transaction each.

- An existing database is always backed up before any migration runs.
- A failing migration is rolled back and the app refuses to start. The error is in the log and launchd retries with throttling. The data is untouched.
- A database from a newer app version is refused, never opened.
- Never edit a shipped migration. Add a new one, and mark it `destructive: true` if it drops or rewrites data.

## Network exposure (not enabled)

The app listens on 127.0.0.1 only. There are no accounts or passwords, because the only way in is from this Mac. These protections are in place:

- Requests must use a localhost `Host` header, which blocks DNS-rebinding attacks from web pages.
- Browser writes must come from the app's own origin and carry a custom header that other sites cannot send.
- Assistants must use a token.

Any local process running as your user could still act as "you". It could read the database file directly anyway, so that is the same trust boundary as your user account. Other accounts on the same Mac can reach `127.0.0.1` too while the app runs, though they can't read your files: the data and log folders are readable only by you. An AI assistant that can run shell commands as you can go around its connection's scopes the same way. More in [SECURITY.md](../SECURITY.md).

Exposing the app to your network, or hosting it remotely, needs real authentication first: user login, HTTPS, and per-device tokens. That is a planned later phase. `MT_ALLOW_NETWORK=1` exists only so that work can be developed. Do not set it today.

## Claude threads

Linking Claude threads to tasks is off until you turn it on: the **Link Claude threads to tasks** switch in Settings > AI assistants, under Claude. Set up Claude Code, and `./scripts/install-skill.sh`, turn it on.

While it's on, the server reads `~/.claude/projects/*/*.jsonl` (override with `MT_CLAUDE_PROJECTS_DIR`) to link Claude Code threads to tasks by task id. It is read-only, local, and incremental: each file's read position is stored in `claude_threads.read_offset`, so only new lines are read. The first pass reads files changed since your oldest task, in the background, and takes a few seconds. Thread titles, folders and Claude's latest reply are stored in the database (and so in backups), never sent anywhere, and only shown to you, never to connections. Turn the switch off and it stops reading.
