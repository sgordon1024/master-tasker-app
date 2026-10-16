# Working with an AI assistant

Everything here is optional. Master Tasker works the same with no assistant connected. To connect one, open **Settings > AI assistants** in the app and pick the app you use (see the [README](../README.md#connect-an-ai-assistant)). The steps for each app by hand are in [MCP.md](MCP.md).

Master Tasker never calls an AI model by itself. You start the work in the assistant's own app.

What an assistant may do depends on its connection. Out of the box it can read your tasks and suggest changes. With **Let it work on tasks** on, it can also fill out and plan a task, move it into In progress, tick off its steps, and finish it. Change this any time under **Assistants with access** in Settings > AI assistants.

Claude has a few more things on top, such as **Work on this with Claude** and linking Claude threads to tasks. They're in [CLAUDE-EXTRAS.md](CLAUDE-EXTRAS.md).

## Start work on a task

Every app can start from this prompt, with your task's id and title in it:

> Use the Master Tasker tools to work on task t_abc123 ("Write the case study intro"): read it, plan it into steps, start it, tick steps off as you finish them, and flag anything only I can decide or do as Needs you.

Once an assistant other than Claude is connected, the task's **⋯** menu has **Copy prompt for your assistant**, which copies it for you. Paste it into the app's chat.

Master Tasker also offers the same steps as an MCP prompt called `work_task`. Some apps can run it as a command. In the others, paste the prompt:

| App | How to start |
| --- | --- |
| Claude | Press **Work on this with Claude** on the task (see [CLAUDE-EXTRAS.md](CLAUDE-EXTRAS.md)). With Master Tasker's MCP tools in Claude Code, `/mcp__master-tasker__work_task t_abc123` works too. |
| Codex (ChatGPT) | Paste the prompt. |
| GitHub Copilot (VS Code) | Type `/master-tasker.work_task` in the chat and give it the task id, or paste the prompt. |
| Cursor | Paste the prompt. |
| Gemini CLI | Type `/work_task t_abc123`, or paste the prompt. |
| Windsurf (Devin Desktop) | Paste the prompt. |
| Other app | If it shows MCP prompts, pick `work_task` and give it the task id. Otherwise paste the prompt. |

Task ids start with `t_`. The prompt from the **⋯** menu has the right one, or copy the id from the task.

## What working a task looks like

- **An empty task:** the assistant asks you about it, fills it out and files it in the right area.
- **Plans it:** writes and orders the subtasks, ending with a check of the task's "Done when" line. If the steps must happen in sequence, the list says **In order** and stays put until you press Unlock. Otherwise drag subtasks by their handle (or focus one, press Space and use the arrow keys) to reorder them.
- **Works it:** moves the task into In progress if the assistant can do the work, then goes through the subtasks one at a time, ticking each one off. Each tick shows on the card as it happens.
- **Flags you:** anything only you can do is marked **Needs you**. Only you can check those off.
- **Finishes it:** the assistant completes the task once every subtask is done and nothing waits on you. The server checks both.

## When something needs you

Anything only you can do shows in red: on the card, at the top of the task, and at the top of For you. Each item shows the assistant's note on why it needs you, and these buttons:

- **Done** checks it off. **Not mine** unflags a subtask and leaves it open.
- **Reply** saves your answer on the task and stops it waiting on you. Your assistant reads it the next time it reads the task.

When Claude Code is on this Mac, there's also **Ask**, and items raised by a Claude thread have **Open thread**. See [CLAUDE-EXTRAS.md](CLAUDE-EXTRAS.md#ask).

## When an assistant finishes a task

You get a Mac notification, "{Name} finished a task", with what got done. The name is the connection's, for example "Cursor". The task waits under **Finished for you** in For you until you press **Got it** or **Reopen**, and its card says **Finished by** and the name.

Turn the notification off in Settings > Notifications. The first one may ask you to allow notifications from Script Editor, which is what shows them.

## Suggestions and questions

An assistant that can read and suggest sends changes as suggestions: a new task, an edit, a note, completing or reopening a task. They wait under **Suggestions** in For you, with which assistant sent them and why. Press **Accept** or **Reject**. Nothing changes until you accept.

An assistant can also ask you a short question instead of guessing. Answer it in For you, and the answer goes back to the assistant.

## What an assistant can't do

- See areas its connection doesn't include.
- Clear Needs you, or tick off a step that needs you.
- Complete a task while subtasks are open or something waits on you.
- Delete tasks, change connections, or touch backups, restore, export or import.
- Send email, change a calendar, buy anything or act on any outside account through Master Tasker.

**Settings > Pause assistants** stops every assistant from changing or suggesting anything, at once. They can still read. Each connection can also be paused on its own.
