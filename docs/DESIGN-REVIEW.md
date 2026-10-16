# Master Tasker through a new designer's eyes

Method: dual-agent critique (A: design review, B: detector and browser measurements), plus a separate review of setup and connecting Claude. October 14, 2026.

**What was tested:** a fresh copy of this repo with only its sample data and Claude Code switched off, which is what a new person sees before they connect anything. Desktop at 1440×900 and phone at 375×812, in dark and light. Numbers below were measured in the browser or read from the code. File references are to this repo.

**The person:** Riley, a product designer one to two years into their career. Lives in Figma, has opinions about type and color, uses a Mac, has tried Claude a little, gets nervous in Terminal. They want their design work organized, Claude helping with it, and to know where they stand at a glance.

---

## The short version

Riley probably wouldn't get it running. If they did, their first Claude action would fail and the app would tell them it worked.

- **Setup.** About 60 to 90 minutes, with three or four points where they'd quit. The goal in REBUILD.md is under 10 minutes.
  - The README never says how to get the code or Node.
  - The main Claude feature, the skill, points at a folder that only exists on the original owner's Mac.
- **First look.** The bones are good: deep keyboard support, Undo on delete, a Trash, and a calm Focus mode. But the first screen is a dark Kanban full of "Sample:" cards. Two columns are off-screen, and nothing answers "what do I do now?"
- **Reward.** Finishing a task gives no feedback; the row just disappears. Deleting a task gets a toast with Undo. Finishing one gets nothing.
- **Where I stand.** The app lands on the Board, which hides overdue and due-today work. The clearest status summary in the whole app is inside the Wizard.
- **Type and color.** There is no type system in practice.
  - 14 font sizes on the five main screens, 18 across the app, and 10 weights.
  - Everything is `system-ui`, and none of the type tokens are used.
  - Labels are 11px monospace capitals everywhere.
  - The Needs-you red fails contrast in dark mode.
  - In light mode, cards barely separate from their columns.
- **Score.** 20 of 40 on Nielsen's heuristics, the bottom of "acceptable". Cognitive load is high: 6 of 8 checks fail.

What to keep: Focus mode is the best thing in the product. It has a point of view the rest doesn't. Build outward from it.

### Fix these ten first

| # | Fix | Why |
|---|---|---|
| 1 | Make the skill, the Sources prompt and the docs use the real install path, not `$HOME/development/Master Tasker` | The headline Claude feature fails on its first command for everyone but the original owner |
| 2 | Write install steps a beginner can follow: get the code, get Node, open Terminal, run one command. Or ship a double-click installer | There's no way in today |
| 3 | Add a "Connect Claude" screen in Settings that detects what's installed and sets it up with one button | Today it takes a token, a hidden JSON file and two absolute paths |
| 4 | When Claude isn't set up, swap Claude buttons for "Set up Claude" | "Start in Claude" says it worked when nothing happened |
| 5 | Fix the task detail header | Close is off-screen at 1440 wide, and on a phone there's no way out of a task |
| 6 | Give feedback when a task is finished: a short animation, "Done · 3 today", and Undo | The most important moment is silent |
| 7 | Make Today the home screen, with one summary line: overdue, due today, needs you, done today | It answers "where do I stand?" |
| 8 | Adopt a real type scale: 7 sizes, 3 weights, a 12px minimum, sentence-case labels | To a designer it reads as unconsidered |
| 9 | Fix the Needs-you red in dark mode, stop using red for five meanings, add depth to light mode | Contrast fails and color loses its meaning |
| 10 | Autosave notes, and stop Esc from throwing them away | People lose what they wrote |

---

## 1. Getting it running

What Riley actually goes through:

| Time | Step | What happens | Quit here? |
|---|---|---|---|
| 0:00 to 0:05 | Reads the README | The first line is "Work in progress… see REBUILD.md", which is an internal plan. There's no screenshot. The feature list is dense ("slow shimmer… turning rainbow dot"). "LaunchAgent" shows up under Requirements. Nothing says what connecting Claude gets them, or that it needs a paid plan. | Some leave |
| 0:05 to 0:25 | Gets the code | README:29 says "From this folder:". There's no `git clone`, no repo link and no Download ZIP. On a fresh Mac, typing `git` starts the 5 to 20 minute Command Line Tools install. A ZIP lands in Downloads. | **Yes** |
| 0:10 to 0:25 | Gets Node 24 | "Node.js 24 or newer" (README:25), with no link and no steps. The nodejs.org installer works. Homebrew adds 10 to 20 minutes. | Many |
| 0:25 to 0:30 | Runs `./scripts/service.sh install` | 1 to 3 minutes of silence, because build output goes to `/dev/null`. macOS pops "Background Items Added" for "node". If the folder is in Desktop, Documents, Downloads or iCloud, the background service probably can't read it. They get "✗ Started but not healthy yet". `logs` then tails an empty file forever. | **Yes**, in those folders |
| 0:30 to 0:35 | Opens 127.0.0.1:4820 | A live board with labeled samples. No welcome, no "Connect Claude". A mystery "Wizard" sits in the main nav. | No |
| 0:35 to 1:15 | Connects Claude | Eight Claude-related README sections and no "do this first". The MCP route means making a token, then hand-editing a hidden JSON file whose example paths are wrong for them. The skill route is one command, but the skill itself points at the owner's folder. | **Yes** |
| later | Daily review | There are no setup steps at all. | Certainly |

Even a developer with Node already set up needs about 25 minutes.

### P0: they give up

- **The skill and the Sources prompt point at the owner's folder.**
  - The hard-coded paths:
    - `claude/skills/master-tasker/SKILL.md:14` sets `T="$HOME/development/Master Tasker/automation/ticket.ts"`.
    - `server/sources.ts:103` writes the same path into the user's own routines. The "is this paused?" check therefore fails, and a Paused routine probably keeps reading Gmail.
    - `docs/MCP.md:55-74` and `docs/REVIEW.md:33` assume it too.
  - GitHub repo names can't contain spaces, so no clone will ever be at that path.
  - `check-public` missed it because it looks for literal home folder paths, not `$HOME/...`.
  - **Fix:**
    - Have `install-skill.sh` write the real path, for example a small `ticket` wrapper in the data folder, or ship the skill as a Claude Code plugin using `${CLAUDE_PLUGIN_ROOT}`.
    - Build server-side paths from `import.meta.dirname`.
    - Add `development/Master Tasker` to `check-public`.
- **No way in.** README:22-35 skips getting the code (clone or ZIP), git and the Command Line Tools, a Node link, `node --version`, and opening Terminal in the folder. **Fix:** numbered, copy-paste steps for each. Say "put the folder in your home folder". Offer an `Install Master Tasker.command` you can double-click.
- **Folder location, plus logs you can't see.**
  - LaunchAgent processes generally can't read Desktop, Documents or Downloads (macOS privacy protection). This is likely; confirm it on a clean Mac.
  - When node dies before it starts logging, the error goes to `launchd.err.log`, but `service.sh logs` only tails `server.log` (service.sh:164).
  - **Fix:** install warns or refuses when the folder is under Desktop, Documents, Downloads or iCloud Drive. When a start isn't healthy, print the last lines of `launchd.err.log`. Make `logs` show both files.
- **Connecting Claude Desktop means hand-editing JSON.**
  - The JSON needs two absolute paths and a token (docs/MCP.md:55-75).
  - The example uses `/opt/homebrew/bin/node`, which doesn't exist after a nodejs.org install, so the server never starts and Claude only reports a failure.
  - MCP.md:10 says this route is untested.
  - Nothing says to fully quit Claude, where its logs are, or how to merge with an existing config.
  - **Fix:** see section 2.

### P1: wrong result, or a hard trap

- **AGENTS.md and CLAUDE.md talk to the owner and to contributors**, not users: "Don't use port 4820…", "Run this copy with `npm run dev`", "Work through REBUILD.md in order". Riley's most natural move is "Claude, install this for me". Claude would then set up a throwaway dev copy whose data is gone when Terminal closes, or start working the rebuild plan. **Fix:** move contributor rules to CONTRIBUTING.md. AGENTS.md should explain how to install and connect it for a user.
- **The paid plan is never mentioned.** README:7 says "Normal use costs nothing to run." But Start in Claude, the skill, Ask and routines all need Claude Code, which needs a paid Claude plan or API billing. **Fix:** say so under Requirements.
- **Install errors are hidden or cryptic.**
  - `npm ci >/dev/null` and `npm run build >/dev/null` (service.sh:141-142) hide all progress.
  - With no Node installed, the only message is "command not found: npm".
  - The Node version check (service.sh:44-45) runs only after install and build.
  - A busy port only shows "not healthy yet".
  - **Fix:** check Node, its version, the port and the folder first, then print progress lines.
- **No way to update.** The server runs from source but the UI runs from `dist/`, so after a `git pull` without a rebuild the two drift apart. **Fix:** add `service.sh update` (pull, `npm ci`, build, restart) and a README section.
- **Moving or renaming the folder traps you.** The guard (service.sh:120-135) blocks everything except status, logs and health, including `uninstall`. Meanwhile launchd keeps retrying the dead path every 10 seconds. **Fix:** always allow `uninstall`, and offer to take over when the old path is gone.

### P2 and P3

- **Finding it tomorrow.** It's only a URL with a port. **Fix:** add `service.sh open`, plus a tip to use Safari's File › Add to Dock so it becomes a real app icon.
- **Login Items.** macOS Login Items show "node" and "zsh", not Master Tasker. Switching them off silently stops it.
- **Uninstall leaves things behind.** It removes only the LaunchAgents. Data, logs, the skill link, token files, Claude configs holding the token, and lines written into routines all stay. **Fix:** list what's left, and offer to remove each.
- **The README promises things that aren't true or don't apply.**
  - "Your phone" (README:16, 18), but the app is localhost only.
  - "Sequence" (README:97), which is the owner's tool.
  - A stale "Publishing… private GitHub repository" section (README:141-143).
  - The WIP banner, and no screenshot.
- **Transcript reading is on by default.** Thread linking reads all of `~/.claude/projects` without asking (OPERATIONS.md:123). A stranger should be asked first.
- **Small fixes:**
  - OPERATIONS.md:61 quotes `"~/Library/…"`, so the `~` never expands.
  - `service.sh:159` uses `sed 's/^\s*/'`, which macOS sed ignores.
  - The docs mix `./scripts/service.sh` and `zsh scripts/install-skill.sh`.
  - `logs` has no "press Control-C to stop" hint.
  - Install runs a full typecheck, which is one more way for an end-user install to fail.

---

## 2. Connecting Claude and other agents

| Path | What it gives | Steps today | Works for a stranger today? |
|---|---|---|---|
| Skill + "Start in Claude" | The headline feature: Claude fills out, plans and works the task while the card updates live | 1 command + 1 click | **No** (SKILL.md:14 path) |
| "Copy for Claude" into Claude Code | Same skill, pasted in | Same | **No**, same path, and the button's label is hidden at 1280 wide |
| MCP in the Claude Code CLI | Read and write tasks | Token + one `claude mcp add` | Only if they rewrite the doc's paths |
| MCP in Claude Desktop chat | Read and write tasks in chat | Token, hand-edited JSON, restart | Unlikely; untested |
| Ask | A one-off answer on a Needs-you item | None | Only if `claude` is in one of 4 fixed places (config.ts:56); nvm and npm-global installs are missed |
| Daily review, Sources | Suggestions from mail, chat and folders | Undocumented | **No** |
| claude.ai web or mobile | Nothing | n/a | Not supported; the docs say so |

**Recommendation: give beginners exactly one path.**

1. Install the Claude desktop app (paid plan).
2. In Master Tasker, open Settings › Connect Claude and press **Connect**. One button sets up the skill and the MCP connection for Claude Code and Claude Desktop, with the right paths and no token pasting.
   - Paths come from the server's own `process.execPath` and the repo root.
   - Show a status card with Claude app, Claude Code and Skill, each marked found, missing, or connected.
3. Then: "Press **Start in Claude** on the task called *Plan my week with Claude*." That is the payoff moment. Claude asks one question, writes a plan, and the card fills in live. Today that moment sits four setup layers deep.

Also ship a Claude Desktop extension (`.mcpb`) that asks for the token itself. Let `mcp/server.ts` read the token from a file when the environment variable isn't set.

**Daily review.**
- REVIEW.md:8-9 talks about a scheduled task and a token as if they already exist.
- The error at `review.ts:35` says to run `npm run cli -- token create …`, but nothing says to save it to `review/token` with `chmod 600`.
- devscan scans `~/development` (devscan.ts:21), which a designer won't have.
- **Fix:** add a `review:setup` command or a Settings button that writes the token and prints routine text with the right paths. Label it optional and developer-oriented.

**The connection screen in Settings:**
- **Jargon.** The copy reads "Paste it into the assistant's MCP config as MASTER_TASKER_TOKEN. See docs/MCP.md." (Views.tsx:657), and the doc reference isn't a link. **Fix:** tabs for Claude Code, Claude Desktop, Cursor, Codex and VS Code, each with a filled-in snippet and a Copy button. Never show env var names or repo paths in the UI.
- **No "All areas" option.** Only the command line can do `*` (cli.ts:107). If Riley ticks all six areas, any area made later is silently invisible to Claude. **Fix:** default to all areas, with a note: "New areas are included".
- **"Create" is disabled with no reason given** (Views.tsx:643).
- **Permissions can't be edited later**, only paused or revoked.
- **No Accept all.** The default permission is Read + Propose, so "add these 20 tasks" means 20 separate Accept clicks.
- **`install-skill.sh` problems.** It keeps a revoked token: "Token already set up" (install-skill.sh:31-32), even though the README says to revoke tokens in Settings. A failed `curl` exits silently (line 37).
- **A non-default port breaks things silently.** Changing `MT_PORT` breaks the skill, review, install-skill and MCP, which all assume 4820.
- **A stream of permission prompts.** The skill runs every step through Bash. **Fix:** add `allowed-tools` to the skill, or move the steps to MCP tools.

**Other AI agents.**
- **What should work.** `mcp/server.ts` is plain stdio, so Cursor, Windsurf, VS Code agent mode, Codex CLI, Gemini CLI, Zed, Cline and Goose should all work for basic reads and writes. The docs name none of them (MCP.md:10).
- **Their configs differ:**
  - VS Code uses `servers` with `"type": "stdio"`.
  - Codex uses TOML (`[mcp_servers.master-tasker]`).
  - Cursor uses `~/.cursor/mcp.json`.
- **What won't work.** ChatGPT and claude.ai on the web only take remote servers, so they can't connect. Say so.
- **Everything beyond read and write is Claude-only today.** That includes thread linking, the "Now on / Done / Needs you" lines (parsed from Claude Code transcripts), the skill, Ask, Sources and the daily review. MCP also has no start, needs-you or plan tools.
- **Fix:**
  - Add `start_task`, `flag_needs_you` and `plan_subtasks` MCP tools.
  - Publish the ticket workflow as an MCP prompt so any client gets it.
  - Add config snippets for the main clients.
  - Allow named agents beyond "Claude" and "Other".

---

## 3. First run

- **P1: The samples teach keyboard moves, not the product.**
  - All 9 samples are about keys: "press ] to move me right". That copy shows on phones too.
  - None shows Needs you, a task Claude is working on, a suggestion to review, or Focus. Riley never sees why the app exists.
  - **Fix:** 6 samples, one per idea:
    - an overdue task;
    - a Needs-you task with a reason;
    - an In-progress task with 3 subtasks and a "Now" line;
    - a Waiting task;
    - a task Claude finished;
    - a task that suggests Focus.
  - Drop the "Sample:" prefix and keep the chip.
- **P1: There's no first-run guidance and no Claude setup state.** The server knows whether Claude is installed (`config.ts:56`) but never tells the UI. **Fix:** report `claude: {installed, connected}` from `/api/health`. On first run, show a three-step card at the top of the home screen: Clear samples · Connect Claude · Try Focus. This lines up with REBUILD step 3.
- **P2: "Clear samples" is buried** at the very bottom of Settings (Views.tsx:412-423). **Fix:** while samples exist, show a dismissible "These are sample tasks. [Clear samples]" banner.
- **P2: The start screen changes with state.** It opens to Review if anything is pending, otherwise to the Board (App.tsx:197-203). That breaks Riley's sense of where things live. **Fix:** always open to one home.

## 4. Where do I stand?

This is the question the app should answer best, and today it answers it worst.

- **P1: Home is the Board, which hides "overdue" and "today".** Overdue shows only as an 11.5px chip, or as a group inside the Today view. **Fix:** make Today the home. Put one line under the title, with each part a link: "Wed, Oct 14 · 1 overdue · 1 due today · 1 needs you · 2 done today".
- **P2: The counts disagree.** The sidebar Today count includes tasks due today. The Board's Today column doesn't (App.tsx:112 vs 135-143). Riley sees "2" and then an empty column. **Fix:** show due-today tasks in the column as faded cards, or split the badge.
- **P2: There's no "done this week".** **Fix:** put "This week: 6 done" on the Done view with a 7-bar sparkline (Mon to Sun). Group Activity by day.
- **P2: The best summary is hidden in the Wizard.** The Spell Ledger tiles (In progress, Needs you, Waiting, Queued, Untriaged) are the clearest overview in the app. **Fix:** move those tiles to the top of Today, renamed to the app's own status names.
- **P2: Nothing shows what Claude is doing.** "Live" in the sidebar (Chrome.tsx:407) means the connection to the local server, but reads as "Claude is connected". **Fix:** rename it "Synced". Add a separate line: "Claude: not set up / idle / working on 2".

## 5. Is it rewarding?

The emotional arc today, in order:

1. **Opening it** is flat. It looks like a demo.
2. **Capturing a task** is fast and mildly good.
3. **The first finished task** is a void: no toast, no Undo, no count.
4. **Opening a task** overwhelms: 11 sections, and Close is off-screen.
5. **Trying Claude**, the reason they installed it, is the low point. "Start in Claude" says "Opening Claude. Press Enter there…" and nothing happens. Ask says "This takes about a minute", then fails in italics.
6. **Focus mode** is the high point. Big balanced type, one button, "Something else pulling at you? Park it here." and "Done. Take a breath."
7. **The Wizard** delights, then jars, because it looks like another app.
8. **Settings** brings anxiety: 16 fun swatches, then SQLite, "schema 9", a raw folder path and tokens.
9. **The end of the day** is weak. No "you finished 4 today". Activity is a raw log.

Fixes:

- **P1: Finishing a task.**
  - The check fills in 160ms with a quick 1 → 1.15 → 1 pop.
  - The row stays, struck through, for 700ms, then collapses over 240ms.
  - A toast says "Done · 3 today" with Undo for 5 to 10 seconds.
  - The sidebar shows "2/5" for Today.
  - Evidence: `store.ts:461-465` has no toast, while delete's toast with Undo is at `store.ts:546`.
- **P2: Focus mode's "Done." screen has no stats and no next step.** **Fix:** show "3 steps · 12 min focused", plus a "Start next: [top Today task]" button and "Back to Today".
- **P2: Restoring from Trash is silent** (Views.tsx:361). **Fix:** toast "Restored to Inbox · Open".
- **P2: An end-of-day moment.** Once a day, when the last Today task is done, show a quiet "That's today. 5 done." with tomorrow's top three. Peak-end matters: people remember the end.
- **P3: The delete toast cuts mid-phrase** ("…or press ] to" into Trash), because it slices at 40 characters (store.ts:546). **Fix:** cut on a word and add "…".

## 6. Navigation and structure

- **P1: Inbox is hidden by default.** It sits under a collapsed "Board" (Chrome.tsx:108), while In progress, which is just a column of the Board, sits at the top level. **Fix:** one flat top group: Today, Inbox, Needs you, In progress, Board. Next, Waiting and Done stay as board columns.
- **P1: About 20 sidebar rows, and the footer is an unlabeled junk drawer.**
  - The footer mixes a toy (Wizard), system pages (Sources, Activity) and utilities (Trash, Settings).
  - **Fix:** put Activity, Trash and Settings under one "More". Move Wizard and Sources into Settings › Labs until they're in use. Aim for 7 top rows or fewer, plus areas.
- **P1: Areas can't be renamed, recolored, archived, deleted or reordered.**
  - Area rows only expand, open, or add a project (Chrome.tsx:308-369).
  - The README promises "Rename or delete any of them" (README:11).
  - Riley can't even rename "Work".
  - **Fix:** a "⋯" menu on each area (Rename, Color, Work or Personal, Archive), plus double-click to rename.
- **P2: New areas made in "Both" mode silently become Personal** (Chrome.tsx:249). Switching to Work then hides them and drops you back on the Board. **Fix:** a Work/Personal toggle on the add row, and a toast with "Change".
- **P2: The Work / Personal / Both switch has the most valuable spot in the sidebar** for something people set once. **Fix:** a small "Showing: Both ▾" control in the toolbar, hidden until areas exist on both sides.
- **P2: "Review queue" is the wrong name.** It holds Needs you, Claude finished, and suggestions, and its badge adds all three into one number (App.tsx:118). **Fix:** call it "For you" with three labeled sections, and use the Needs-you count for the badge.
- **P3: The nav says "Sources" but the page title says "Routines"** (Sources.tsx:37, 40). Pick one.

## 7. Board and list

- **P1: The board doesn't fit a 1440 screen.**
  - Six columns at 296px plus gaps need about 1836px, and there's about 1144px to work with (`--col-w: 296px`, app.css:9).
  - Waiting and Done are off-screen. Opening a task leaves about two and a half columns visible.
  - **Fix:**
    - `--col-w: clamp(232px, 18vw, 280px)`;
    - collapse Done to a 56px rail with a count;
    - hide In progress when it's empty, with a slim "Nothing in progress · press S" row in its place.
- **P2: An empty area shows six dashed boxes saying "Drop tasks here to mark them Inbox".** That's ungrammatical, and there's nothing on screen to drop. The proper empty state, "Nothing in [area] yet", only renders in List (App.tsx:471). **Fix:** use the area empty state on the Board too, and make the column copy "Nothing here yet".
- **P2: Card metadata piles up.** An In-progress card stacks "UP NEXT · …", "▷ Claude isn't on it · Start", "0/2" and "Unfiled" under a seven-line title. **Fix:**
  - clamp titles to 3 lines;
  - allow one meta row at most;
  - hide "Unfiled" and the area chip inside an area's own board;
  - show Claude status only when Claude is set up.
- **P3: The row status menu is invisible until you hover** (app.css:278-279). **Fix:** show a small status label at rest that becomes the menu on hover or focus.
- **P3: The group header repeats the page title** (an "Inbox" heading, then "INBOX 3"). **Fix:** hide it when a view has only one group.

## 8. Task detail

- **P0: Close, Trash and "Copy for Claude" are off-screen on desktop.**
  - The header holds about 632px of buttons in a 440px panel and doesn't wrap (`.detail-head`, app.css:478; TaskDetail.tsx:36-68).
  - Measured at 1440 wide: the Close button's right edge is at x=1661.
  - Focusing a field then scrolls the whole page sideways, cutting off the sidebar.
  - **Fix:** keep only Mark done, Start/Stop and Close in the header, with Close pinned last (`margin-left: auto; flex-shrink: 0`). Put Focus, Start in Claude, Copy for Claude and Trash in a "⋯" menu. Add `overflow: hidden` to the header.
- **P0: On a phone there's no way out of a task.**
  - The task opens as a full-screen sheet (app.css:708), and Close sits off-screen at x=412 to 456 on a 375px screen.
  - There's no Esc on a phone, and `history.replaceState` (App.tsx:80) means Back leaves the app.
  - **Fix:** a 44×44 "‹ Back" button at the left of the sheet header. Use `pushState` when opening a task so Back closes it.
- **P1: Notes are lost on refresh and on Esc.** Notes only save when the field loses focus (TaskDetail.tsx:187-188), and Esc throws the draft away (191-196). This was confirmed: notes typed, page reloaded, notes gone. **Fix:** save 800ms after typing stops and on `pagehide`. Make Esc save, not discard, in multi-line fields.
- **P1: All 11 sections show all the time.**
  - "Waiting on" shows even when the task isn't Waiting.
  - A free-text "Needs you" field shows even while the Needs-you panel above it is active. Its placeholder is cut to "It stays loud until y".
  - **Fix:**
    - The default view is Title, a status/priority/due row, Next action, Subtasks and Notes.
    - "Waiting on" shows only when the task is Waiting.
    - "+ Add" chips for a link, a Needs-you flag, and an area or project.
    - Claude threads and History go behind a "Details" disclosure.
- **P2: Two filled primary buttons side by side** (Mark done and Start in Claude). **Fix:** make Start in Claude secondary.
- **P2: "rev 1" in History** (TaskDetail.tsx:655) is developer data. Remove it.
- **P2: Stop and Reopen send tasks to the wrong place.** Stop goes to Today and Reopen goes to Next, instead of where the task came from (store.ts:466-484). **Fix:** remember the previous status and restore it.

## 9. Claude inside the app

- **P0: Claude being missing is invisible, and the app claims success anyway.**
  - `startInClaude` hands off a `claude://` link and always toasts success (claude.ts:14-19).
  - The button shows on every saved task (TaskDetail.tsx:53).
  - Riley's first Claude action silently fails, and they'll blame themselves.
  - **Fix:** when Claude isn't installed, every Claude button becomes "Set up Claude", which opens the Connect screen from section 2. Hide "Claude isn't on it · Start" on cards (TaskItem.tsx:152-161).
- **P1: Ask runs even though it knows it will fail.** It shows "This takes about a minute" (NeedsYou.tsx:237), then: "Couldn't answer: Claude Code is not installed on this Mac, so there is nothing to ask." There's no next step. **Fix:** check first, and show "Needs Claude Code · Set up" inline.
- **P2: "Send" on a reply doesn't send anything.** It adds the reply to the notes and silently overwrites your clipboard (NeedsYou.tsx:302-311). **Fix:** call it "Save reply", and make "Copy for Claude" its own explicit button.
- **P2: There are too many Claude verbs.**
  - Actions: "Start in Claude", "Copy for Claude", "Fill out with Claude" and "Tell Claude to keep going".
  - States: "Claude's turn", "Up next" and "Hand back".
  - **Fix:** one primary verb ("Work on this with Claude") and one secondary ("Copy prompt").
- **P2: "Copy for Claude" loses its label** at the default width. It measured 0px of label at 1280 wide, yet the README tells people to press it. Its toast says to paste into a new Claude thread, where `/master-tasker` does nothing in a normal chat.

## 10. Typography

**What's there:**
- **Families.** `system-ui` for everything, plus `ui-monospace` (seed.css:7-9). There's no type decision at all.
- **Sizes.** 14 distinct sizes on the five main screens, 18 across the app: 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 16, 17, 18, 19, 20, 21 and 24px. Most are half-pixel steps apart, which nobody can see. The difference between 11.5 and 12 is noise, not hierarchy.
- **Weights.** 10 of them: 400, 500, 550, 600, 620, 650, 680, 700, 750 and 800.
- **Line heights.** 9 different ratios, plus `normal`.
- **Tokens.** The type tokens exist in `baseline/typography.css:14-24`, and `app.css` never uses them.
- **Small text.** On the Board, 49 of 94 visible text elements are under 12px. In the task detail it's 65 of 133.
- **Hierarchy.** The view title is 24px/680. The headings below it are 17, 18 and 19px, so nothing is clearly second level.

**Issues:**
- **P1: No scale.** **Fix:** use the tokens, and limit the app to seven steps and three weights.

  | Use | Size / weight | Line height |
  |---|---|---|
  | Labels | 12 / 500 | 16 |
  | Meta (dates, counts) | 13 / 400 | 18 |
  | Body, task titles | 14 / 400 | 20 |
  | Capture input | 16 / 400 | 24 |
  | Detail title | 20 / 600 | 26 |
  | View title | 28 / 600, tracking −0.02em | 32 |
  | Focus title | 40 / 600 | 46 |

  Weights 400, 500 and 600 only.
- **P1: Text under 12px everywhere.**
  - The "SAMPLE" chip is 10px mono capitals (app.css:251).
  - The "Needs you" label is 10.5px at weight 800 (app.css:350, 813).
  - The "Now" label (app.css:398), subtask tags (386), the subtask lock (845) and Focus's done line (929) are all 10.5px.
  - Mobile tab labels are 11px, and the tab count badges are 10px.
  - **Fix:** a 12px minimum. 11px only for numerals in badges.
- **P2: Every label is an 11px monospace capital** with 0.08em tracking (app.css:29-36). That includes column heads, field labels and section heads. It's the 2023 developer-tool look (Linear, Vercel, Raycast), it reads as "console", and it gives labels the same weight as content. **Fix:** sentence-case 12px/600 sans in the secondary text color. Keep mono only for counts and IDs, with `tabular-nums`.
- **P2: Pick a typeface.** For a local app there's no CDN cost to self-hosting. Some options:
  - Inter for body and Inter Display at 20px and up, with Geist Mono for numbers;
  - or a warmer humanist sans that fits Focus mode's calm, such as Source Sans 3.

  The point is to commit to one face.
- **P3: Titles in Focus use `text-wrap: balance`** and look great. Use `balance` for view titles too, and `pretty` for notes.

## 11. Color

**What's there:**
- **Base tokens.** A vendored generic token kit, seeded with all defaults: `#2F5BEA` blue, near-pure gray neutrals (chroma 0.006) and an 8px radius (seed.css:3-9).
- **Colors outside the tokens.** Three features bring their own hard-coded colors:
  - `--you: #E11D48` (app.css:330);
  - a `--rainbow` hex list (app.css:297);
  - the Wizard's plum, teal, amber and Courier New (wizard.css:3-19).
- **Themes.** 16 accent themes (theme.ts:17-34).

**Contrast failures (WCAG AA), measured:**

| Element | Mode | Ratio | Needs |
|---|---|---|---|
| "Needs you" list title, `#e11d48` on page (17px/750) | Dark | 4.22 | 4.5 |
| Needs-you red as text on cards | Dark | 3.56 | 4.5 |
| "High" priority chip, `#f75d59` on `#3d2829` (11.5px) | Dark | 4.37 | 4.5 |
| Search, select and capture box borders | Both | 1.40 to 1.43 | 3.0 |
| Card border vs column | Both | 1.18 to 1.19 | 3.0 if it's the only edge |
| Column vs page | Both | 1.15 to 1.18 | n/a, but it's why light mode looks flat |
| Focus mode's remaining-step dots (white at 7%) | Dark | about 1.1 | 3.0 |

Body text is strong: 15.96:1 in dark and 19.56:1 in light. Secondary text is 7.25:1 and 5.43:1. Focus rings pass everywhere.

**Issues:**
- **P1: The Needs-you red fails in dark mode.** **Fix:** use a lighter red for text in dark mode, `--you-text: oklch(0.72 0.19 15)`, which clears 4.5:1. Keep `#E11D48` only as a fill behind white text (4.70:1). Move `--you` and the rainbow into the token files, with light and dark values.
- **P2: Red means five things:** Needs you, Overdue, High priority, Delete, and three of the accent themes (Cherry, Coral, Bubblegum). If everything urgent is red, nothing is. **Fix:**
  - Keep red for Overdue and Needs you only.
  - Show High priority as an ↑ icon with normal text.
  - Show Low priority as secondary text with no chip. Its info blue also collides with the blue "Today" chip.
- **P2: Area colors are 8 fixed hex values, with no picker and no change between modes** (service.ts:152). Pets and Hobbies both render orange. **Fix:** 8 swatches spaced around the hue wheel in oklch, defined per mode (about L 0.55 light, L 0.72 dark, C 0.14), and let people pick.
- **P2: Input borders are nearly invisible** (1.4:1). **Fix:** `--border-strong` for input outlines, or a filled field with a clear focus state.
- **P3: 16 themes, and no other personality.** It looks like generosity, but it reads as indecision. **Fix:** cut to 6 chosen themes, shown as one row of dots rather than 16 preview cards, and spend the effort on type.

## 12. Layout and spacing

- **P2: Two toolbar rows come before any content.** Search, filters and layout, then capture, take about 150px on desktop. On a phone it's about 520 of 812px. **Fix:** put capture in the toolbar row on desktop. On a phone, hide filters behind one Filter button and default to List.
- **P2: Pages cap at 820px and lists at 920px** (app.css:460, 517), so on 1440 the right 40% is empty. **Fix:** center the column (`margin-inline: auto`), or let lists go to 1080px with a right-hand meta column.
- **P3: Raw pixel paddings** (6, 10, 11, 14px) sit next to space tokens. **Fix:** snap them to `--space-*`.
- **P3: The text field in the task detail title** has 4px of vertical padding around 19px text (app.css:481), which looks cramped.

## 13. Icons and motion

- **P2: One icon, two meanings.** Sparkles means both "Review queue" and "Claude" (Chrome.tsx:41, TaskDetail.tsx:55). Zap means both In progress and the Start button. **Fix:** a Claude mark for Claude actions, an inbox-check icon for Review, and Play for Start.
- **P2: Up to four endless shimmers at once.** They run on the card, the nav item, the "Now" label and the current subtask (app.css:137, 316, 401, 418), plus a spinning rainbow dot. It's busy, and in light mode the In-progress card looks like a selected nav item. **Fix:** one shimmer, on the card only. The nav gets a still dot.
- **P3: Two designs live in one file.** The "Needs you, calmer" block (app.css:808-835) overrides the older loud version (331-386, with pulse animations) instead of replacing it. **Fix:** delete the overridden rules.
- **P3: The spring easing overshoots** (`--ease-spring`, used at app.css:306 and 451). The detector flags it. The token itself is marked "playful only", so it's a deliberate choice, but on a task app it feels toy-like next to Focus mode's calm. **Fix:** use the standard ease-out for arrival, and keep the spring only on the check pop.
- **P3: The logo is a generic check in a rounded square** (Chrome.tsx:178-181). It's fine for now, but it's the first thing a designer judges.

## 14. Words

- **P2: "Task" and "ticket" are used interchangeably** ("Search tasks", "Focus on this ticket", "7 open tickets"). Use "task" everywhere.
- **P2: Status names fork.** The mobile tab bar says "Doing" where everywhere else says "In progress" (App.tsx:526). The Wizard says "Queued" and "Untriaged" where everywhere else says "Next" and "Inbox" (WizardView.tsx:51-58). Use one set of names.
- **P2: The page intros are defensive and written for the builder.**
  - Review: "nothing is ever marked done just because it disappeared from a source" (Views.tsx:126).
  - Activity: "Assistant names come from their connection token…" (Views.tsx:295).
  - Data: "SQLite… migration" (Views.tsx:718).
  - About: "schema 9" (Views.tsx:758).
  - **Fix:** write for the user. For Review: "Things that need a decision from you, and what Claude finished."
- **P3: Empty states have no button.** For example, Review says "connected assistants put suggestions here" but offers no Connect button. Give each empty state one action.
- **What's good:** the voice is plain and calm, with sentence case and no exclamation marks. Keep that.

## 15. Accessibility

What's already good:
- column-aware keyboard drag with spoken announcements (TaskGroups.tsx:56-133);
- roving-tabindex radios and a skip link;
- every control has a name;
- one h1 per view, and landmarks;
- reduced-motion is honored;
- body text passes everywhere.

- **P1: Focus mode doesn't trap focus.** After 6 Tabs, focus lands on the hidden sidebar. **Fix:** set `inert` on the app shell while Focus is open (Focus.tsx:88).
- **P1: You can't Tab to the completion check** (`tabIndex={-1}`, TaskItem.tsx:86). Finishing a task needs you to know the X shortcut. **Fix:** `tabIndex={0}`.
- **P1: Thirty Tabs from a fresh load never leave the sidebar.** The skip link helps, but only if you know it's there. **Fix:** make area rows one Tab stop each, with arrow keys inside them.
- **P2: Toasts vanish fast.** Undo toasts last 7 seconds and others 4.5 (store.ts:146). **Fix:** pause them on hover or focus, and give actionable toasts 10 seconds.
- **P2: The capture input has `outline: none`.** Its only focus cue is a thin 1px border plus a faint wash.
- **P2: Tap targets are small.** The completion check is 18×18 on desktop and 24×24 on a phone, and the sidebar disclosures are 22×30. **Fix:** 24×24 minimum on desktop and 44×44 on a phone, with padding around the visual.
- **P3: Destructive confirmations use the browser's `confirm()`** (Views.tsx:339, 523, 694). Use the app's own dialog.

## 16. Phone

- **P0: There's no way out of a task** (see section 8).
- **P2: The board opens on a full-width, empty In progress column.** **Fix:** default phones to List, or skip empty columns.
- **P2: On the Review screen, "Not mine" spills out of its card at 375px** (`.you-action-btns`, app.css:370). **Fix:** `flex-wrap: wrap`.
- **P2: Badges are inconsistent.** The Review tab badge is accent blue on a phone but red on desktop (App.tsx:527). The Inbox and Today counts are bare numbers. **Fix:** the same pill badge everywhere, red when something needs you.
- **P2: About two-thirds of the first screen is toolbar** before any task shows (see section 12).
- **What works:** no sideways scrolling of the page, long titles wrap, and there's a bottom tab bar.

## 17. Light vs dark

Light mode is a real token map, not a simple inversion: the status colors are retuned per mode (baseline/colors.css:36-39 vs 107-110). But it's undercooked.

- **P1: Light mode has almost no depth.** Card vs column is 1.03:1, column vs page is 1.03:1, and borders are 1.18:1. Cards are white on white. **Fix:**
  - Columns on `--neutral-100`.
  - Cards on the page color with `--shadow-sm`.
  - A card border of neutral at 12%.
  - Aim for each surface step to be at least 1.08:1.
- **P2: In light mode the In-progress nav item looks selected.** **Fix:** an accent wash plus a 3px accent left edge, so it reads as "active work", not "you are here".
- **P2: Some colors don't change between modes:** the Needs-you red, the rainbow, the area colors and the whole Wizard.

---

## What's working (keep these)

1. **Focus mode** (Focus.tsx, app.css:902-943). It's the one part with a real point of view:
   - large titles (`clamp(26px, 4.2vw, 40px)`) with balanced wrapping;
   - a single pill button with an Enter hint;
   - "Park it here", which drops a stray thought into Inbox;
   - a quiet minute counter, and toasts silenced while you focus;
   - "Last thing: mark the ticket complete."
2. **Keyboard depth.**
   - g-chords, [ and ] to move, Alt+↑↓, F for Focus;
   - keyboard drag with spoken announcements;
   - shortcut help.
3. **Data safety, written humanely.**
   - Deletes go to Trash with Undo.
   - "Two edits collided… Nothing has been overwritten. Choose what to keep."
   - "This changed somewhere else while you were typing."
   - Moving a task to Waiting asks "What are you waiting on?"
4. **Security.**
   - Localhost only, and it refuses anything else.
   - Host and origin checks.
   - Per-area tokens, shown once.
   - A pause-all switch, daily limits, and destructive actions kept inside the app.
   - The honest line "No connections yet. Nothing outside this app can read or change your tasks."
   - The app's content security policy even blocked the design detector's injected script.
5. **The Today view's structure:** In progress, Overdue, Due today, Planned. It's the right "where do I stand" skeleton. It just isn't home.
6. **The Done / Needs you line protocol** between Claude threads and the app. It's clever and doesn't depend on tokens.

---

## Scores

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | Finishing a task gives no feedback; "Start in Claude" reports success when Claude isn't there; "Live" reads as "Claude connected" |
| 2 | Match with the real world | 2 | rev 1, SQLite, schema 9, MCP config, MASTER_TASKER_TOKEN, Routines, Untriaged, Queued; "task" vs "ticket" |
| 3 | User control and freedom | 2 | Delete has Undo, but finishing doesn't; Esc throws away notes; no close on phone; areas can't be renamed |
| 4 | Consistency and standards | 1 | Doing vs In progress, Queued vs Next; red vs blue badges; two primary buttons; In progress outside Board |
| 5 | Error prevention | 2 | New areas silently become Personal and silently invisible to Claude; Ask runs knowing it will fail |
| 6 | Recognition over recall | 2 | Copy relies on remembered keys; subtask actions only on hover; header icons lose their labels |
| 7 | Flexibility and efficiency | 3 | Strong keyboard model; no bulk actions, no ⌘K, no "tomorrow !high" parsing; P means two things |
| 8 | Aesthetic and minimalist design | 2 | Up to 5 chip rows per card, 11 detail sections, 14 to 18 font sizes; Focus mode is the exception |
| 9 | Error recovery | 2 | Clear messages, but no next step ("nothing to ask"); the conflict dialog is excellent |
| 10 | Help and documentation | 2 | Every page has an intro and there's shortcut help, but no onboarding and no Claude setup |
| | **Total** | **20 / 40** | **Acceptable, bottom of the band** |

**Cognitive load: 6 of 8 checks fail, 2 partial (high).**
- **Fail:**
  - single focus;
  - chunking (about 20 sidebar rows, 11 detail sections, 6 columns);
  - visual hierarchy;
  - one thing at a time;
  - four or fewer choices per decision;
  - working memory (counts disagree; three sets of status names).
- **Partial:** grouping, and progressive disclosure.
- **Decisions with more than 4 visible options:**
  - detail header (7 buttons);
  - status menu (6);
  - sidebar top level (13 or more);
  - color theme (16);
  - shortcut help (18 flat rows);
  - connection permissions (6);
  - Wizard filters (6);
  - Settings (8 unsectioned blocks).

---

## How it fails each kind of person

- **Jordan, first-timer.**
  - Lands on "Sample:" cards and an empty In-progress column.
  - Can't find Inbox.
  - "Review queue", "Sources" and "Wizard" mean nothing yet.
  - Opens a task and can't find Close.
  - Presses Start in Claude, sees "Opening Claude", and nothing happens.
  - Can't rename "Work".
- **Sam, keyboard and screen reader, low vision.**
  - Can't Tab to the completion check.
  - Tab escapes Focus mode into hidden UI.
  - 30 Tabs stay in the sidebar.
  - Lots of 10 to 11px uppercase mono.
  - Dark-mode red text at 3.56:1, and light-mode card edges at 1.18:1.
  - Undo toasts disappear in 7 seconds.
- **Alex, power user.**
  - P means priority, but g P means In progress.
  - g R, g A, g S and g Z work but aren't listed (Chrome.tsx:41-46 vs 560).
  - No bulk select, no ⌘K, no date parsing in capture.
  - Has to scroll sideways to reach Done.
  - X finishes a task with no Undo.
- **Riley, junior designer.**
  - Reads the type as unconsidered.
  - Light mode looks washed out, and area colors can't be picked.
  - The Claude half of the promise dead-ends at "MCP config / MASTER_TASKER_TOKEN / docs/MCP.md".
  - Nothing feels good about finishing work.
  - Loves Focus mode and the Wizard, but they feel like two other apps.

---

## Detector results

**Command-line scan** (`detect.mjs` over `web/src`): 2 findings, both `bounce-easing`, at `app.css:306` and the token itself at `baseline/motion.css:10`. It's real but intentional (see section 13).

**In-page scan.**
- The app's content security policy blocked injection in the built-in browser, which is a good sign.
- It was rerun through Playwright with CSP bypassed, on 5 views in both modes. Up to 17 findings per view in dark and 13 in light.
- **Real:**
  - undersized text (the 10px SAMPLE chip, the 10.5px Needs-you label);
  - low contrast on the dark Needs-you title (4.2:1);
  - the cramped detail title field;
  - a heavy 88px dialog shadow on a 1px border in dark mode (`--shadow-xl`).
- **False positives:**
  - "cramped padding" on segmented controls (a standard 2px inset);
  - the thick bottom border on `kbd` (the keycap convention);
  - "clipped overflow" on layout shells;
  - "edge-flush cards";
  - "line length" on a folder path;
  - "text occlusion" behind the detail panel.

---

## Questions worth asking

1. Focus mode is the only surface with a point of view. Why isn't the whole app designed outward from it, with Today as home and the Board as a planning tool?
2. Is "In progress" yours or Claude's? "Up next", "Claude's turn" and "Claude isn't on it · Start" say it's Claude's. If Claude isn't set up, should that column exist at all?
3. Needs you lives in five places (card banner, detail panel, a detail field, the Review list, subtask tags) with four verbs (Done, Not mine, Hand back, Reply). What if it were one queue with one verb?
4. Why 16 color themes and no typeface? What would one face and one color, chosen with conviction, look like?
5. The Wizard's Spell Ledger is the clearest status summary in the product. Why is the most useful dashboard behind the silliest label?

---

## Where this fits in REBUILD.md

- **Before anything else (new):** fix the owner paths in the skill, sources.ts, MCP.md and REVIEW.md, and teach `check-public` to catch `development/Master Tasker`.
- **Step 3, first-run setup:** add better samples, the three-step start card, "Clear samples" up front, and Today as home.
- **Step 4, making Claude optional:**
  - add `claude: {installed, connected}` to health;
  - swap Claude buttons for "Set up Claude";
  - add the Connect Claude screen;
  - add MCP tools for start, needs-you and plan.
- **Step 6, the README:** install steps for a beginner, the paid plan, a screenshot, one recommended Claude path, other agents, update and uninstall.
- **Step 8, cleanup:** move the Wizard and Sources into Labs, delete the superseded Needs-you CSS, and remove "rev 1", "schema 9" and the defensive intros.
- **New step, design pass:**
  - type scale and typeface;
  - red reserved for Overdue and Needs you;
  - light-mode depth;
  - area color picker;
  - the board fitting 1440;
  - the detail header and the phone sheet;
  - finish feedback;
  - the IA cleanup in section 6.
