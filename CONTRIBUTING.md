# Working on Master Tasker

Thanks for helping. This is for changing Master Tasker itself. To install and use it, see the [README](README.md).

What's left before the first public release is in [docs/REBUILD.md](docs/REBUILD.md). Pick any open step.

## Run it

```bash
npm install
npm run dev        # API on 4821 with a throwaway database in .data/dev, UI with hot reload on 5180
npm test           # API, durability, script and MCP tests (Vitest)
npm run test:e2e   # browser tests in desktop and phone sizes (Playwright, installed Chrome, port 4843 or MT_E2E_PORT)
npm run test:all   # typecheck, all of the above, and the production build
```

`npm run dev` never touches the database the installed service uses.

`./scripts/service.sh install` and `update` remove the development packages after they build, to keep the installed copy small. To develop in a folder you installed from, run `npm install` again first.

If you used `./scripts/service.sh get-node`, Node.js is in `.node/` in this folder (gitignored) rather than on your PATH. Put it first for npm commands: `export PATH="$PWD/.node/bin:$PATH"`.

## Don't touch an installed copy

Your Mac may also run an installed Master Tasker, with real data. Never point a development copy at it:

- Don't use port 4820, `~/Library/Application Support/MasterTasker`, `~/Library/Logs/MasterTasker`, the `local.master-tasker.*` LaunchAgents, or the `~/.claude/skills/master-tasker` link.
- Run your copy with `npm run dev`, or with `MT_PORT` and `MT_DATA_DIR` set to throwaway values.
- To try `scripts/service.sh` or `scripts/install-skill.sh`, point `HOME`, `MT_DATA_DIR`, `MT_LOG_DIR` and `MT_CLAUDE_SKILLS_DIR` at a scratch folder and run a throwaway server on another port. The tests do this, with a stand-in for `launchctl` (`tests/fixtures/fake-launchctl`).
- `scripts/service.sh` and `scripts/install-skill.sh` refuse when another folder owns the service or the skill. Don't work around that.

## Before every push

```bash
npm run test:all && npm run check:public
```

`check:public` must pass. It fails on anything personal, any real home folder path, the original owner's folder layout or tools, anything that looks like a secret, and data files. If it flags something, fix it. Don't loosen the check to get past it.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs those same checks on a Mac for every push to `main` and every pull request: typecheck, unit tests, build, `check:public` and the browser tests. It must pass before a pull request is merged.

- The browser tests use Playwright's own Chromium there (`CI` is set), not Chrome.
- When a browser test fails, the run keeps the `playwright-test-results` artifact. Unzip it and run `npx playwright show-trace` on a `trace.zip`.
- Each action is pinned to a full commit SHA, with its version in a comment. When you update one, look up the new SHA and change both.

## How it's built

```
web/         React + TypeScript UI (Vite). Baseline design tokens, Lucide icons, dnd-kit.
server/      Small Node HTTP server. SQLite via node:sqlite. Serves the built UI and the API.
mcp/         MCP server (stdio). A thin client of the HTTP API with a scoped token.
shared/      Zod schemas and types used by all three. One set of validation rules.
automation/  Command-line tools for Claude threads and routines: ticket.ts (the /master-tasker skill),
             review.ts and devscan.ts (the daily review), sources.ts (the source check).
claude/      The /master-tasker skill. Its `ticket` runner finds this folder from the skill link.
scripts/     LaunchAgent install, health check, the skill installer, dev runner, demo, check-public.
docs/        Guides for users. DESIGN-REVIEW.md is the first-time-user review.
```

- Node 24+ runs the TypeScript directly, with built-in SQLite (`node:sqlite`). No build step for the server.
- **One source of truth.** Only the server touches the database. The UI, the MCP server and the command-line tools all go through the same API and the same `shared/schema.ts` validation, so the rules can't drift.
- **Live updates.** Server-sent events. Every write bumps a change counter. On reconnect the client asks for everything since its last counter, so missed events are recovered without a full reload.
- **Optimistic updates.** The UI applies your change at once and keeps it in a pending queue. If the server rejects it, the change is dropped and the screen rolls back with a message. Network failures are retried with the same idempotency key.
- **Revision checks.** Each edit carries the revision it started from. If someone else changed the same field since, the server returns a conflict and the UI asks which version to keep. Edits to different fields merge cleanly.
- **Identity.** "You" means the browser UI on this Mac. Assistants are identified by their connection token, never by a name they supply.
- **The owner stays in charge.** Everything a connection does goes through scoped tokens. Assistants suggest, and only the owner clears "Needs you".
- **Migrations** live in `server/migrations.ts`. Add a new one. Never edit an old one.
- **Paths** are built from the code's own folder (`import.meta.dirname`), never from a home folder layout, since a copy can live anywhere.
- **Design.** Read [DESIGN.md](DESIGN.md) first. Base tokens come from the Baseline design system (`web/src/styles/baseline/`, don't edit it). The project seed is `web/src/styles/seed.css`, and the app's own roles (type sizes, surfaces, Needs you, In progress, area colors) are in `web/src/styles/tokens.css`. Components use tokens, never raw values. After a visual change, run `npm run screenshots` to refresh the README images.

## Keep these in step

- The task workflow is written twice: in `claude/skills/master-tasker/SKILL.md` for the `/master-tasker` skill, and as the `work_task` prompt in `mcp/server.ts` for other MCP apps. Change both together.
- Set up Claude Code in Settings > AI assistants (`server/integrations.ts`) and `scripts/install-skill.sh` set up the same skill, token file and `.local.env`. Change both together.
- The labels in the docs match the app. If you rename a button, search the docs for it.
- `Install Master Tasker.command` and `check_folder` in `scripts/service.sh` refuse the same folders. The `.command` also acts on the exit codes `service.sh` gives when there's no Node (3) and when the port is taken (4).

## Style

Plain words in the UI and docs. Short sentences. No em dashes. Match the surrounding code and its amount of comments.
