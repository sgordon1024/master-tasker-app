# Roadmap to the first public release

**Goal:** an open source Master Tasker you install yourself. Anyone can download it, run it on their own Mac with their own data, and connect their own AI assistant. It stays local-first: one person, one Mac, listening only on `127.0.0.1`, nothing in the cloud.

**Done when:** someone new to Terminal can follow the README on a clean Mac and get a working board with their own AI assistant connected, without help, and `npm run check:public` passes on the published repo. On a fresh clone, downloading the packages and building take about 15 seconds on a fast connection, plus the optional 50 MB Node.js download. With the macOS security prompts, first-run setup and connecting an assistant, it's about 10 minutes. A first try by someone new, on a clean Mac, is still to come.

## Done so far

- Sample areas and tasks are made up: Clients, Side projects, Pets, Home, Hobbies and Personal. Connection kinds are Claude and Other.
- First-run setup, once per install and before the tour: your name, starter areas (Work and Personal, the sample set, or none) and whether to add the sample tasks. Skip keeps the sample set. A database that already has your own tasks counts as set up, so updating never shows it.
- Two copies on one Mac can't take each other over: `scripts/service.sh` won't touch a background service another folder installed, and `scripts/install-skill.sh` won't relink a skill another folder owns.
- `npm run check:public` fails on anything personal, any home folder path, anything that looks like a secret, data files and a missing LICENSE.
- Paths come from the code's own folder (`import.meta.dirname`). The skill runs through `claude/skills/master-tasker/ticket`, which finds this folder from the skill link, and its `allowed-tools` lets Claude Code run it without a permission prompt. The command-line tools read `MASTER_TASKER_URL`, `MT_PORT` and `MT_DATA_DIR`.
- Setup for people new to Terminal (sections 1 and 2 of the [design review](DESIGN-REVIEW.md)):
  - `Install Master Tasker.command` to double-click. It offers to move the folder out of Downloads, Desktop, Documents or iCloud Drive, and the next free port if another app has Master Tasker's. It's safe to run again. `Uninstall Master Tasker.command` undoes it.
  - `service.sh` checks the folder, Node and the port before it changes anything. It offers a private copy of Node.js, checked against the checksums nodejs.org publishes, so nothing needs a password. It shows progress and startup errors, and has `open`, `update` and `demo`.
  - `uninstall` always works. While the app is running it undoes the Claude setups first, if any, and it lists what's left with the Finder steps to remove it.
  - `install-skill.sh` replaces revoked tokens and says plainly when the app isn't running.
- MIT license (`LICENSE`).

## Steps

The [design review](DESIGN-REVIEW.md) is a first-time-user design and setup review. Its last section maps its findings onto these step numbers.

1. ~~Pick a license.~~ Done: MIT.
2. ~~Baseline design tokens.~~ Done: cleared to publish, and they ship as they are.
3. ~~First-run setup.~~ Done: a first-run screen asks your name, starter areas (Work and Personal, the sample set, or none) and whether to add sample tasks, and saves them in settings. The name is used in Ask (`server/ask.ts`), the skill and the MCP `work_task` prompt, the daily review, and Today's sign-off. The "Needs you" label stays as it is.
4. **Make every Claude piece optional and say so.** The app must work with none of these installed, and each one should switch on cleanly when it is:
   - Claude Code (`claude` on PATH): Ask about a task, Work on this with Claude.
   - The Claude desktop app: thread linking and routines in Routines (Settings > Labs).
   - The `/master-tasker` skill (`scripts/install-skill.sh`).
   - The daily review routine ([REVIEW.md](REVIEW.md)). Done: `npm run review:setup` makes the connection, saves the token and prints the routine. Code folders are opt-in and empty by default.

   Add tests for the missing cases. Done for MCP: the `start_task`, `flag_needs_you` and `plan_subtasks` tools, the `work_task` prompt, and `MASTER_TASKER_TOKEN_FILE`, so other MCP apps get the ticket workflow.
5. **Mac only for v1, said plainly.** The README says so. Notifications use `osascript`, the service uses launchd, and data lives in `~/Library`. Linux (XDG paths, a systemd user unit) is a later step.
6. ~~Rewrite the README for someone new.~~ Done: beginner install steps, one place to connect any AI assistant (Settings > AI assistants), update, uninstall, data, backups and privacy. Working with an assistant is in [AI-ASSISTANTS.md](AI-ASSISTANTS.md), the Claude-only parts are in [CLAUDE-EXTRAS.md](CLAUDE-EXTRAS.md), and [AGENTS.md](../AGENTS.md) helps a user's assistant install it. Install step 1 links to the repo.
7. ~~Demo data for screenshots.~~ Done: `npm run demo` starts a throwaway copy on port 4870 with a junior product designer's made-up week, in a temp folder it deletes on Control-C. `npm run screenshots` uses it to write `docs/screenshot.png` and `docs/screenshot-dark.png`.
8. ~~Clean up leftovers.~~ Done: the Wizard's sky look lab (`?wizardlab=1`) is removed. None of its three skies was picked, and nobody saw them without the lab, so the Wizard keeps its plain dark backdrop.
9. ~~Security pass.~~ Done: assistants can't finish a task by editing its status or clear Needs you by deleting a subtask, thread ids and proof links are checked, data and logs are readable only by you, and `npm audit` is clean. What it protects against, and how to report a problem, is in [SECURITY.md](../SECURITY.md). Tests are in `tests/security.test.ts`.
10. **Repo basics.** ~~CI on GitHub Actions.~~ Done: `.github/workflows/ci.yml` runs typecheck, unit tests, build, `check:public` and the browser tests on a Mac for every push to `main` and every pull request. In CI the browser tests use Playwright's bundled Chromium, not Chrome. Its actions are pinned to commit SHAs. `package.json` has `repository`, `homepage` and `bugs`, and keeps `"private": true`: this isn't published to npm.
11. ~~Publish.~~ Done: public on [GitHub](https://github.com/sgordon1024/master-tasker-app). Its commits use the owner's GitHub noreply address.

## Rules while working on it

See [CONTRIBUTING.md](../CONTRIBUTING.md).
