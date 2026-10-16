# Connecting AI assistants (MCP)

Master Tasker comes with a small MCP server, so AI assistants can read and update your tasks. It speaks MCP over **stdio**: the assistant's app starts it on your Mac as a child process, and it talks only to Master Tasker on `127.0.0.1`. Nothing on the network can reach it.

## The easy way: Settings > AI assistants

Open Master Tasker and go to **Settings > AI assistants**, then pick the app you use. It fills in this Mac's paths and makes the connection for you.

- **Claude Code:** press **Set up Claude Code**. This adds the `/master-tasker` command, which is how **Work on this with Claude** works. It doesn't need the MCP server.
- **Claude Desktop chats:** press **Add to Claude Desktop**. It adds Master Tasker to Claude's settings file, after backing the file up, and leaves Claude's other entries as they are. Then quit Claude fully (Command-Q) and open it again. If it later says **Needs update** (the folder or port changed, or its entry is from an older version), press **Update**.
- **Codex, GitHub Copilot, Cursor, Gemini CLI, Windsurf, Claude Code's MCP tools, or any other app:** pick the app, choose what it may do, and make the connection. Copy the settings it shows and paste them where it says. **Show settings** on the app's row under **Assistants with access** shows them again later.

The token goes in a file only you can read, `tokens/<connection id>` in Master Tasker's data folder. Claude Desktop's entry and the settings to paste name that file (`MASTER_TASKER_TOKEN_FILE`), so the token never sits in an app's settings file or your Terminal history. **Show token** shows the token itself, once, for an app that needs it. Removing an assistant's access deletes its file.

The rest of this page is for doing it by hand.

## Which apps work

| App | Works? |
| --- | --- |
| Claude | Yes. Claude Code is tested on every run of `tests/mcp.test.ts`, which drives the server with the official MCP client over stdio. For Claude Desktop, Settings > AI assistants sets it up, and the same entry works in chats and in threads in the Code tab. |
| Codex (ChatGPT) | Should work for reading and writing tasks. The ChatGPT desktop app, Codex CLI and the Codex IDE extension share one settings file. |
| GitHub Copilot (VS Code) | Should work for reading and writing tasks, through VS Code's MCP servers. |
| Cursor | Should work for reading and writing tasks. |
| Gemini CLI | Should work for reading and writing tasks. |
| Windsurf (Devin Desktop) | Should work for reading and writing tasks. Windsurf is now called Devin Desktop. |
| Other app | Any app that starts local stdio MCP servers should work. |

Each of these starts local stdio servers the same way. Only the settings format differs. Assistants on the web, such as chatgpt.com and claude.ai, and phone apps can't connect. They only reach servers on the internet, and Master Tasker runs only on your Mac.

Thread linking, the `/master-tasker` command, Ask and the daily review are Claude only. Every app gets the same task workflow through the `work_task` prompt below.

## 1. Make a connection

Each AI assistant gets its own connection, with its own token, limited to the areas and actions you choose. Picking the app in Settings > AI assistants, as above, makes one for you.

For a script, or anything else: **Settings > AI assistants > Assistants with access**, then **Advanced > Add access for a script**. Pick:

- **Areas it can see.** All areas (new ones are included), or only some. You can also allow unfiled Inbox items.
- **What it can do:**
  - Read
  - Create tasks
  - Edit and add notes
  - Complete and reopen
  - Propose changes (suggestions wait in For you until you accept or reject them)
  - Move tasks into In progress

A good start for a new assistant is **Read** and **Propose changes**. Add more once you trust it. You can change this later.

Then it shows the settings for each app, ready to paste. They name the connection's token file, `~/Library/Application Support/MasterTasker/tokens/<connection id>`. Copy them before you press **I saved it**. The token itself is under **Show token**, shown only this once.

Or from Terminal, in the Master Tasker folder. If you use the private copy of Node.js (in `.node`), run `export PATH="$PWD/.node/bin:$PATH"` first, so `npm` is found.

```bash
npm run cli -- token create --name "Cursor" --kind other --areas "*" --unfiled --perms read,propose
```

That prints the token instead of saving a file. Save it to a file yourself, as in [Keeping the token in a file](#keeping-the-token-in-a-file). `npm run cli -- token list` lists connections, and `npm run cli -- token revoke <id>` removes one's access.

## 2. Find the two paths

Every app needs the full path to Node and the full path to `mcp/server.ts`. In Terminal, in the Master Tasker folder, run:

```bash
command -v node
```

```bash
echo "$PWD/mcp/server.ts"
```

If you chose the private copy of Node.js when you installed, your Node is `.node/bin/node` in the Master Tasker folder. Run `echo "$PWD/.node/bin/node"` instead of `command -v node`.

Use what they print in place of `/path/to/node` and `/path/to/master-tasker/mcp/server.ts` below. Use your token file in place of `/Users/you/Library/Application Support/MasterTasker/tokens/c_your_connection_id`. The settings the app shows in step 1 have its real path, and `npm run cli -- token list` lists connection ids.

The Node from nodejs.org is at `/usr/local/bin/node`, and Homebrew's is at `/opt/homebrew/bin/node`. If you use nvm, the path changes when you switch Node versions, so update the app's settings after you do.

## 3. Add it to your assistant's app

The server reads these settings from its environment:

| Setting | Meaning |
| --- | --- |
| `MASTER_TASKER_TOKEN_FILE` | The path to the file that holds only the token, from step 1. The file must be readable only by you (`chmod 600`), or the server refuses it. |
| `MASTER_TASKER_TOKEN` | Or the token itself. It then sits in the app's settings in plain text, so use the file when you can. Used first when both are set. |
| `MASTER_TASKER_URL` | Optional. Defaults to `http://127.0.0.1:4820`. Only `127.0.0.1`, `localhost` and `::1` are accepted. Set it if you changed `MT_PORT`. |

### Claude

#### Claude Code

In Terminal, in the Master Tasker folder:

```bash
claude mcp add master-tasker --scope user -e MASTER_TASKER_TOKEN_FILE="$HOME/Library/Application Support/MasterTasker/tokens/c_your_connection_id" -- "$(command -v node)" "$PWD/mcp/server.ts"
```

Put your connection's id in place of `c_your_connection_id`, or use the whole path of your own token file. The shell fills in the rest when you press Return: `$HOME` becomes your home folder, `$(command -v node)` becomes the full path to your Node, and `$PWD` becomes the Master Tasker folder. Claude Code saves those full paths, because it may start the server without your Terminal's settings. `--scope user` makes it available in every folder. With the private copy of Node.js, put `"$PWD/.node/bin/node"` in place of `"$(command -v node)"`.

In Claude Code, `/mcp` should list `master-tasker` as connected.

#### Claude Desktop

**Add to Claude Desktop** in Settings > AI assistants does this for you. By hand:

1. In Claude, open **Settings > Developer > Edit Config**. That shows `claude_desktop_config.json` in Finder. It lives in `~/Library/Application Support/Claude/`.
2. Open it in TextEdit. If it's empty, paste this:

   ```json
   {
     "mcpServers": {
       "master-tasker": {
         "command": "/path/to/node",
         "args": ["/path/to/master-tasker/mcp/server.ts"],
         "env": { "MASTER_TASKER_TOKEN_FILE": "/Users/you/Library/Application Support/MasterTasker/tokens/c_your_connection_id" }
       }
     }
   }
   ```

   If it already has an `"mcpServers"` section, add only the `"master-tasker": { … }` part inside it, with a comma after the server before it. Keep everything else as it is.
3. Quit Claude fully with Command-Q (closing the window isn't enough), then open it again.
4. In a new chat, ask "What's in my Master Tasker inbox?"

Threads in the Claude app's Code tab load this entry too, so you don't need to add Master Tasker there separately.

If it doesn't connect, the logs are in `~/Library/Logs/Claude/`: `mcp.log`, and `mcp-server-master-tasker.log` for this server. A typo in the file stops every server in it from loading, so paste the file into a JSON checker if you're unsure.

### Codex (ChatGPT)

In Terminal, in the Master Tasker folder:

```bash
codex mcp add master-tasker --env MASTER_TASKER_TOKEN_FILE="$HOME/Library/Application Support/MasterTasker/tokens/c_your_connection_id" -- "$(command -v node)" "$PWD/mcp/server.ts"
```

As for Claude Code, put your connection's id in place of `c_your_connection_id`, and with the private copy of Node.js use `"$PWD/.node/bin/node"` in place of `"$(command -v node)"`. Codex saves it in `~/.codex/config.toml`. The ChatGPT desktop app, Codex CLI and the Codex IDE extension share that file. In Codex, `/mcp` lists your servers.

Or add these lines to the end of `~/.codex/config.toml` yourself. Add them only once: if the file has two `[mcp_servers.master-tasker]` sections, Codex stops with an error and won't start. To change one, edit the lines that are there.

```toml
[mcp_servers.master-tasker]
command = "/path/to/node"
args = ["/path/to/master-tasker/mcp/server.ts"]
env = { MASTER_TASKER_TOKEN_FILE = "/Users/you/Library/Application Support/MasterTasker/tokens/c_your_connection_id" }
```

### GitHub Copilot (VS Code)

GitHub Copilot uses the MCP servers in VS Code's own settings. In VS Code, run **MCP: Open User Configuration** from the Command Palette. VS Code uses `servers` and needs `"type": "stdio"`:

```json
{
  "servers": {
    "master-tasker": {
      "type": "stdio",
      "command": "/path/to/node",
      "args": ["/path/to/master-tasker/mcp/server.ts"],
      "env": { "MASTER_TASKER_TOKEN_FILE": "/Users/you/Library/Application Support/MasterTasker/tokens/c_your_connection_id" }
    }
  }
}
```

**MCP: List Servers**, in the Command Palette, lists `master-tasker` and can start or stop it.

### Cursor

Cursor reads its servers for every folder from `~/.cursor/mcp.json` in your home folder. If that file doesn't exist, make it with this:

```json
{
  "mcpServers": {
    "master-tasker": {
      "type": "stdio",
      "command": "/path/to/node",
      "args": ["/path/to/master-tasker/mcp/server.ts"],
      "env": { "MASTER_TASKER_TOKEN_FILE": "/Users/you/Library/Application Support/MasterTasker/tokens/c_your_connection_id" }
    }
  }
}
```

If it already has servers, add only the `"master-tasker": { … }` part inside `"mcpServers"`, after the last one, with a comma after the one before it. Cursor then lists master-tasker under **Customize** in its sidebar, where you can switch it on and off.

### Gemini CLI

Gemini CLI reads its servers for every folder from `~/.gemini/settings.json` in your home folder. If that file doesn't exist, make it with this:

```json
{
  "mcpServers": {
    "master-tasker": {
      "command": "/path/to/node",
      "args": ["/path/to/master-tasker/mcp/server.ts"],
      "env": { "MASTER_TASKER_TOKEN_FILE": "/Users/you/Library/Application Support/MasterTasker/tokens/c_your_connection_id" }
    }
  }
}
```

If it already has other settings, keep them. Add only the `"master-tasker": { … }` part inside `"mcpServers"`, after the last server, with a comma after the one before it. If there's no `"mcpServers"` yet, add it inside the outer braces, with a comma between it and the settings next to it. In Gemini CLI, `/mcp` should list `master-tasker` as connected.

### Windsurf (Devin Desktop)

Windsurf is now called Devin Desktop. Its docs put the servers for every folder in `~/.config/devin/mcp_config.json` in your home folder. If that file doesn't exist, make it with this:

```json
{
  "mcpServers": {
    "master-tasker": {
      "command": "/path/to/node",
      "args": ["/path/to/master-tasker/mcp/server.ts"],
      "env": { "MASTER_TASKER_TOKEN_FILE": "/Users/you/Library/Application Support/MasterTasker/tokens/c_your_connection_id" }
    }
  }
}
```

If it already has servers, add only the `"master-tasker": { … }` part inside `"mcpServers"`, after the last one, with a comma after the one before it.

### Other app

Any app that starts local stdio MCP servers can use it. Give it:

- **command:** the full path to Node
- **args:** one item, the full path to `mcp/server.ts`
- **env:** `MASTER_TASKER_TOKEN_FILE`, or `MASTER_TASKER_TOKEN`

### Keeping the token in a file

A connection made in the app already has its token file. For a token you copied (from `npm run cli -- token create`, or from **Show token**), save it to a private file yourself. Copy the token, then in Terminal:

```bash
mkdir -p ~/.config/master-tasker && chmod 700 ~/.config/master-tasker
(umask 077 && pbpaste > ~/.config/master-tasker/cursor-token)
```

Then use `"MASTER_TASKER_TOKEN_FILE": "/Users/you/.config/master-tasker/cursor-token"`, with your own home folder (`echo $HOME` prints it).

With `MASTER_TASKER_TOKEN` instead, the token sits in the app's settings file in plain text, readable by your user account. Treat it like a password. If it leaks, remove its access in Settings > AI assistants, which takes effect at once.

## Tools

Every tool is narrow and about tasks. There is no shell access, no file access and no general web access. Lists return at most 50 tasks.

| Tool | What it does | Needs |
| --- | --- | --- |
| `whoami` | This connection's areas, permissions, limits and pause state, and your name (`user_name`, empty if you didn't give one) | read |
| `list_areas` | Visible areas and projects | read |
| `list_tasks` | Tasks by status, area or project | read |
| `search_tasks` | Searches titles, notes, next actions and waiting on | read |
| `get_task` | One task with its notes, subtasks, Needs you flags and `rev` | read |
| `create_task` | Creates a task, in Inbox unless you say otherwise. Takes an optional `idempotency_key` | create |
| `update_task` | Changes fields. Needs `base_rev`. Setting the status to done follows the same rules as `complete_task` | update, and complete for done |
| `add_note` | Adds a dated note without replacing the notes already there | update |
| `add_subtask`, `set_subtask_done` | Manage the checklist. A Needs you subtask can only be checked off by you | update |
| `plan_subtasks` | Adds the plan's steps in order, flags the ones that need you, and can lock the order | update |
| `flag_needs_you` | Flags a subtask, or the whole task, as something only you can do, with why | update |
| `start_task` | Moves a task into In progress | start, or update |
| `complete_task`, `reopen_task` | Marks done (refused while subtasks are open), or reopens | complete |
| `propose_change` | Suggests a create, edit, complete, reopen or note for you to review | propose |
| `ask_question` | Asks you a short question instead of guessing. Your answer comes back through `list_my_proposals` | propose |
| `list_my_proposals` | What this connection suggested and what happened to it | read |

Areas and projects can be named ("Work") or given by id. Task ids (`t_…`) are stable and never reused.

## The `work_task` prompt

The server also offers a prompt called `work_task`, with a `task_id` and optional `context`. It gives every app the same steps as Claude's `/master-tasker` command: read the task, fill it out if it's empty, plan the subtasks, start it, work through them, flag what needs you, and finish it only when everything is done. Its steps use only the tools above, so a connection that can only read and propose gets as far as its permissions allow. If you gave your name at setup or in Settings, the prompt includes it, so the app calls you by it.

How to run it in each app, and a plain prompt for apps that don't show MCP prompts, are in [AI-ASSISTANTS.md](AI-ASSISTANTS.md#start-work-on-a-task).

## Rules the server enforces

- **Scope.** Tasks outside the connection's areas are invisible: they read as "not found". It can't create tasks in other areas, or move tasks into them.
- **No silent overwrites.** `update_task` needs the `rev` it last read. If you changed the same field in the app since, the app gets a conflict and must read the task again.
- **No duplicates.** Retrying with the same `idempotency_key` returns the first result. Without one, the same title from the same connection in the same area within 10 minutes counts as a duplicate.
- **You stay in charge.** Only you can check off a Needs you item. A task can't be completed while subtasks are open.
- **Identity.** The activity history names the connection from its token, for example "Cursor" or "Claude Desktop". The name an app reports about itself is shown separately, marked unverified.
- **Pause and limits.** Settings > Pause assistants pauses every connection at once, and each one can be paused on its own. By default each connection gets 200 writes and 100 suggestions a day. Paused or over-limit calls get a clear error, and reading still works.
- **App only.** Deleting tasks, managing connections, backups, restore, export and import are never available to a token.
- **No outside effects.** Changing a task never sends email, changes a calendar, buys anything or touches any outside account.

## Troubleshooting

- **"Master Tasker is not reachable".** The app is stopped, or the Mac was asleep. Run `./scripts/service.sh status` in the Master Tasker folder.
- **"This connection was removed or deleted".** Connect the app again in Settings > AI assistants and paste its new settings into the app. For Claude Desktop, press **Add again** there.
- **"MASTER_TASKER_TOKEN_FILE points at …, and there is no file there".** Removing an assistant's access deletes its token file. Connect it again and paste its settings again. For Claude Desktop, press **Add again** in Settings > AI assistants.
- **"readable by other users".** The token file is too open. Run the `chmod 600` command in the message.
- **Claude Desktop says Needs update.** Its entry points at an old folder or port, or holds the token itself. Press **Update** in Settings > AI assistants. It backs up Claude's settings file first. Then quit Claude fully and open it again.
- **"This connection is not allowed in that area".** Change its access in Settings > AI assistants, or use another connection.
- **Nothing happens at all.** The path to Node or to `mcp/server.ts` is probably wrong. Check both with step 2, and look at the app's MCP logs. The server writes its messages to stderr, which most apps show in those logs.
