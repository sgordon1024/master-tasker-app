# Claude extras

These work only with Claude. Everything that works with any AI assistant, such as Needs you, finished tasks and suggestions, is in [AI-ASSISTANTS.md](AI-ASSISTANTS.md).

All of it is optional. To set Claude up, open **Settings > AI assistants** in the app and pick **Claude** (see the [README](../README.md#claude)).

The Claude extras need the Claude desktop app or Claude Code, and both need a paid Claude plan. Master Tasker never calls Claude by itself. Claude runs only when you start a thread, press Ask, or schedule a routine.

## Work on this with Claude

Open a task and press **Work on this with Claude**. A new thread opens in the Code tab of the Claude app with `/master-tasker <task id>` filled in. Press Enter there. The thread names itself after the task and links to it.

**Copy prompt**, in the task's **⋯** menu, copies the same command to paste yourself, into Claude Code in Terminal or the Code tab of the Claude app. A normal Claude chat doesn't know the command.

Hover a subtask and press its play button to start a thread on that subtask first.

Until Claude is set up, the task shows no Claude buttons.

## The `/master-tasker` command

The command works a task the same way as any assistant does (see [What working a task looks like](AI-ASSISTANTS.md#what-working-a-task-looks-like)). On top of that, it hands simple steps to cheaper models.

The command uses a connection called "Claude threads", which can read, edit, start and complete tasks in every area. Change its access, or remove it, under **Assistants with access** in Settings > AI assistants.

While the command runs, Claude Code lets it use its own tool (`ticket`, in the skill folder) without asking you. That lasts until you send your next message. After you reply in the thread, Claude Code may ask before it uses the tool again. Answer yes, or pick the option that stops it asking.

## Claude threads on a task

While **Link Claude threads to tasks** is on (Settings > AI assistants, under Claude), any Claude Code thread that mentions a task's id shows up under **Claude threads** on that task. One thread can cover several tasks. While a task is In progress, its card shows the subtask Claude says it's on ("Now on:"), and Claude's latest decision or reply in small text.

To do this, Master Tasker reads Claude Code's thread files in `~/.claude/projects` on this Mac, only what's new each time. It never changes them and sends nothing anywhere. Turn the switch off and it stops looking.

Chats on claude.ai aren't stored on your Mac, so for those, paste the chat link into the task's links.

## Ask

On a Needs you item, **Ask** gets you more information. Master Tasker runs Claude Code once, on a read-only copy of the thread that raised the item, and shows the answer under it. It can read files and nothing else, and leaves your thread untouched. It runs only when you press Ask, uses your Claude plan, and takes about a minute. Ask shows only when Claude Code is on this Mac.

**Open thread**, on an item a Claude thread raised, opens that thread in the Claude app. If the app doesn't have it, it copies a Terminal command instead.

When a Claude thread finishes a task, the Mac notification also says the thread is ready to archive.

## Claude chats in the Claude app

**Add to Claude Desktop** (Settings > AI assistants, under Claude) lets any chat in the Claude app read your tasks and suggest changes. Its connection, "Claude Desktop", can only read and suggest. Suggestions wait in **For you** until you accept or reject them. After adding it, quit Claude fully (Command-Q) and open it again. Threads in the Code tab load the same entry, so they get the Master Tasker tools too.

Its token goes in a file only you can read, `tokens/` in Master Tasker's data folder, and Claude's settings name that file (`MASTER_TASKER_TOKEN_FILE`), never the token. If you move the Master Tasker folder or change its port, or the entry is from an older version that kept the token in Claude's settings, the status says **Needs update**. Press **Update**: it backs up Claude's settings file, rewrites only its own entry, and keeps the same connection. Then quit Claude fully and open it again. **Remove from Claude Desktop** takes the entry out, removes the connection's access and deletes its token file.

## Claude Code in Terminal

The `/master-tasker` command is all most people need. To give every Claude Code thread the Master Tasker tools too, pick **Claude** in Settings > AI assistants, open **Claude Code in Terminal** at the bottom, and press **Connect Claude Code in Terminal**. It shows a `claude mcp add` command to paste into Terminal. The command names the connection's token file, so the token stays out of your Terminal history. See [MCP.md](MCP.md#claude-code) for doing it by hand.

## Routines

**Routines** (turn it on in Settings > Labs, then find it in the sidebar under More) lists every routine scheduled in the Claude app: when it runs, the tasks it's tied to, and what it reads (Gmail, Slack, code folders and so on, worked out from its instructions and allowed tools). Each source has a switch, and **On** pauses the whole routine. Master Tasker reads the Claude app's list of routines when you open Routines, and never changes their schedule.

Your switches are saved in `sources.json` in the data folder. The first time you switch something off on a routine, Master Tasker adds one line to that routine's instructions. The line tells it to run Master Tasker's `automation/sources.ts check` first and skip whatever is off. That's the only change it makes to a routine. If you uninstall Master Tasker, delete that line from the routine.

**Add a source** takes plain words, since a source can be anything. It saves a task and opens a Claude thread that works out the setup with you. Nothing gets connected until you say so in that thread.

## The daily review

A routine you can set up yourself that reads your code folders, Gmail and Slack twice a day and suggests task updates. It's aimed at developers. See [REVIEW.md](REVIEW.md).
