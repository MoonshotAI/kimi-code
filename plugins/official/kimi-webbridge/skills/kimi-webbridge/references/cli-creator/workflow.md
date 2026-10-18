# Build a CLI for a website

Read this when the user asks for a reusable CLI tool or script that automates a specific website. The CLI drives the user's real browser through the same daemon as the tools in SKILL.md, so it works with the sessions the user is already logged in to.

Work through the phases in order. `{platform}` below is a short name for the site — one lowercase word, no hyphens: it names the binary (`{platform}-cli`), the CLI's `session`, and in Go a package.

## Phase 1: Requirements

Ask the user, in one message, for whatever of these the request didn't already say, then wait for the reply:

1. **Target website URL**
2. **Language** — ask only if the request didn't say and the project you are working in doesn't settle it. With no signal either way, pick one whose toolchain is already on the user's machine.
3. **Does the site require login?** — Yes / No / Unknown
4. **The first 1–3 features**, for example:
   - Read: home feed, search, profile page, item detail
   - Write: create post, like, comment, bookmark
   - Account: login status, user info

Tell the user more features can be added later by repeating Phases 2–3 for each one.

## Phase 2: Site exploration

**Do not write business logic before exploration is complete.** For each planned feature, run the protocol in `references/cli-creator/site-exploration.md`. It yields how the feature's data is fetched — an API call or a DOM read — and an `evaluate` call proven to return that data inside the user's browser session.

Go to Phase 3 only when every planned feature has a working `evaluate` call.

## Phase 3: Implement

Build in this order:

1. **Project scaffold** — `references/cli-creator/go-layout.md` for Go. In any other language the daemon client is a single HTTP POST: the request body and reply envelope are the ones in SKILL.md's Call Format.
2. **`login-status` command** — if the site requires login; see `references/cli-creator/login-handling.md`
3. **Read commands** — no side effects
4. **Write commands** — after the reads work

Verify each command as soon as it is implemented, and fix it before starting the next one:

```bash
{platform}-cli {command} --help          # must work
{platform}-cli {command} [args]          # must print {"ok": true, "data": ...}
```

Check an error path too — an unreachable `--daemon-url`, and for write commands a wrong ID or missing flag: it must print `{"ok": false, ...}` and exit non-zero.

**CLI contract (every language):**

- `--help` / `-h` works on every command
- All output is `{"ok": true, "data": ...}` or `{"ok": false, "error": {"code": "...", "message": "..."}}`
- Non-zero exit code on error
- A `--daemon-url` flag on the root command, defaulting to `http://127.0.0.1:10086`. The daemon can listen elsewhere (see "If a tool call fails" in SKILL.md), so the caller must be able to say where.
- One fixed `session` name for the whole CLI, sent on every daemon request. A CLI outlives any single task, so the name is `{platform}`, not a task name.
- Each command reuses the CLI's tab, so runs don't pile up tabs: `find_tab` with the site's URL first, and `navigate` with `newTab: true` only when that fails. `find_tab` matches by host, so when a command needs a specific page, `navigate` the found tab there (without `newTab`).

## Phase 4: Companion skill

Once the CLI works, write a companion skill from `references/cli-creator/companion-skill-template.md` into the CLI project, at `skill/{platform}-cli/SKILL.md`, so it is versioned with the code and the directory name matches the skill's `name`. It tells a future agent how to *use* the CLI.

Then ask the user whether to install it into their agent. Installed, a new conversation can use the CLI from a plain request ("search X for …"); without it the CLI still works, but an agent won't know it exists. If they say yes, copy that directory to where your agent loads its skills from.
