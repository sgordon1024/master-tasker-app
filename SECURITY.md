# Security

Master Tasker runs only on your Mac, for one person. This page says what it protects you from, what it doesn't, and how to report a problem.

## What it never does

- **No telemetry, no analytics, no accounts, no cloud.** Your tasks stay in a database on your Mac.
- **Localhost only.** The server listens on `127.0.0.1` and refuses any other address unless `MT_ALLOW_NETWORK=1`. That switch exists for development only and has no login, so don't set it.
- **No calls to the internet on its own.** The only network traffic is what you start:
  - Installing downloads Node.js from nodejs.org and checks it against a checksum saved in the script. Installing and updating also run `npm ci`, and updating runs `git pull`.
  - **Ask** on a Needs you item runs Claude Code once, when you press it.
  - The optional daily review asks GitHub for your recent pull requests through `gh`, if it's installed and signed in. `MT_DEVSCAN_GH=0` turns that off.
- **It never calls an AI model by itself.**

## What it protects against

**Web pages you visit.** A page can't read or change your tasks:

- Requests must name `127.0.0.1` or `localhost` in the `Host` header, which blocks DNS rebinding.
- Requests from other sites are refused (by `Origin` and `Sec-Fetch-Site`). Writes from the app need a header other sites can't send, and the server sends no CORS headers, so other sites can't read answers.
- Live updates follow the same rules and are only for the app itself.
- The app's pages carry a strict Content Security Policy and can't be shown inside another site.

**AI assistants with a connection token.** Each connection gets its own token and only what you allow:

- It sees only the areas you pick, can only do what you allow (read, create, update, complete, suggest), and has daily limits. You can pause it or remove its access in Settings > AI assistants.
- It can't clear Needs you, accept or reject its own suggestions, change any connection's access, delete or restore tasks, or read settings, exports or backups.
- When it finishes a task, the task can't have open subtasks or anything waiting on you, and it waits under **Finished for you** in For you until you look it over.
- Tokens are random, the database stores only a hash of each one, and token files are readable only by you. Tokens never go in URLs, logs or error messages.

**Task text.** Anything an assistant writes is shown as text, never run as code:

- The app never renders task text as HTML. Links only open if they are `http`, `https`, `mailto` or one of a few app links.
- Text that goes into a Mac notification is passed as arguments, never into the script. Commands the app copies for you to paste in Terminal only use plain thread ids, and quote anything else.

**Your files.** The database, backups and logs are readable only by you, and so are token files.

## What it doesn't protect against

- **Programs running as you.** Anything running under your macOS account can read the database and token files, and can call the app as you. That's the same line your account draws for all your files.
- **Other accounts on the same Mac.** While the app runs, other people with an account on your Mac can reach `127.0.0.1` too, and could use the app as you. They can't read your files. If you share a Mac with people you don't trust, quit the service while you're away (`./scripts/service.sh stop`).
- **An assistant that can run commands on your Mac.** Connection scopes limit what an assistant can do through Master Tasker. An assistant that can also run shell commands as you could read the database directly. Give that kind of access only to assistants you trust.
- **A paused connection** can still read. Pausing stops writes; to stop reads, remove its access.
- **What an assistant reads goes to its provider**, like anything else you type there. The daily review reads the code folders you name, your Claude Code threads, and whatever the routine is allowed to use (for example Gmail or Slack).
- **Network mode.** `MT_ALLOW_NETWORK=1` has no login and is not safe to use.

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and press **Report a vulnerability** ([direct link](https://github.com/sgordon1024/master-tasker-app/security/advisories/new)). Don't open a public issue for it.

Say what you found, how to reproduce it, and which commit you tested. Fixes go into the latest version on `main`.
