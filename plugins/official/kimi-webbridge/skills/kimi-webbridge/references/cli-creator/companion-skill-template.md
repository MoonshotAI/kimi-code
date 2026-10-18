# Companion Skill Template

Once the CLI works, write `skill/{platform}-cli/SKILL.md` in the CLI project from this template. It tells a future agent how to *use* the CLI — not how it was built.

Copy the block below into the new file, then fill in the blanks.

````markdown
---
name: {platform}-cli
description: Use when the user wants to [read/post/search/interact with] [Site Name]. Invoke when the user mentions "[site name]", asks to automate [site] tasks, or needs to [key action verbs].
---

# {Platform} CLI

Automates [Site Name] in the user's real, logged-in browser through the Kimi Browser Extension daemon (`kimi-webbridge`).

## Requirements

- The `kimi-webbridge` skill. If a command fails because the daemon is unreachable or the browser extension is not connected, recover the way that skill describes, then retry. If the daemon is not on its default address, pass `--daemon-url http://<host>:<port>`.
- The CLI at `<absolute path to the CLI>` — run it by that path unless it is on `PATH`
- For commands that need login: `{platform}-cli login-status`. If not logged in, ask the user to log in to [Site URL] in their browser, then retry.

## Commands

| Command | Args / Flags | Returns |
|---------|-------------|---------|
| `login-status` | — | `{logged_in, user}` |
| `search` | `<query> [--limit N]` | `[{id, text, author}]` |
| _(one row per command)_ | | |

Run `{platform}-cli <command> --help` for full flag documentation.

## Output format

Every command prints JSON on stdout:

```json
{"ok": true, "data": ...}
```

On error (non-zero exit):

```json
{"ok": false, "error": {"code": "error_code", "message": "human-readable message"}}
```

## Common workflows

```bash
# Search, then act on a result
{platform}-cli search "keyword" --limit 10
{platform}-cli like <id>
```

## Known limitations

- Login is done by the user in their browser; the CLI never automates it
- [Site-specific quirks found during development]
````

## Fill-in checklist

- [ ] Replace `{platform}` with the CLI's name
- [ ] Replace `[Site Name]` and `[Site URL]` with actual values
- [ ] Write the `description` from phrases the user would really say
- [ ] Fill in the CLI's absolute path, so an agent in a fresh conversation can run it
- [ ] Fill the Commands table from `{platform}-cli --help`
- [ ] Add 2–3 real workflows
- [ ] Record the limitations found during development
- [ ] If the site doesn't need login, drop the `login-status` row, the login requirement, and "logged-in" from the intro
