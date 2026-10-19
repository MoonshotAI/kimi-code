# Operations: running the kimi-webbridge daemon

Read this when the user asks about kimi-webbridge itself — install, start, stop, restart, upgrade, "is it running", "why isn't the extension connected", moving it to another port. Mid-task recovery (the daemon becomes unreachable while you are driving the browser) is covered in SKILL.md and needs nothing from here.

Installing the binary or the browser extension is done by the user from the help page — send them there rather than scripting it:

- English: https://www.kimi.com/en/products/kimi-browser-extension
- 中文: https://www.kimi.com/products/kimi-browser-extension

Everything below lives under `~/.kimi-webbridge/` (Windows: `%USERPROFILE%\.kimi-webbridge\`).

## What is on disk

- `bin/kimi-webbridge` (`bin\kimi-webbridge.exe`) — the binary. It is not on PATH, so call it by this path. `command not found` means it is not installed.
- `config.json` — optional. Exists only if someone moved the daemon off the default port (see below).
- `daemon.pid` / `daemon.addr` — the running daemon's PID and the address it actually bound; both removed on exit. `stop`/`status`/`start` find a live daemon through these, so they keep working after `config.json` has been edited to point elsewhere.
- `logs/daemon.log` — current run; `daemon.log.prev` — the run before. Read them with `logs`, not by hand.

## Subcommands

| Command | What it does | Notes |
|---|---|---|
| `start` | Starts the daemon in the background and prints the address it listens on | Idempotent: no-ops if already up. Safe to run without asking. `--addr host:port` overrides the address for this run only and is not saved |
| `status` | Prints the daemon's `/status` JSON (fields below) | Read-only. When nothing answers it prints `{"running":false,"addr":…}` with the address it probed |
| `logs` | Tails the daemon log | `-f` follow, `-n N` last N lines, `--prev` previous run |
| `stop` / `restart` | Stops (and restarts) the running daemon | Kills the user's live session — run only when the user asks for it |
| `upgrade [version]` | Downloads a release, stops the daemon, swaps the binary, restarts, refreshes installed skills to the same release | Without a version it targets the connected extension's version (the extension follows the browser store's pace), else latest. Run it when the user asks to upgrade; when `status` merely advertises one, tell the user |
| `install-skill [--version X] [-y]` | Installs this skill into detected agent runtimes | `upgrade` only refreshes skills that are already installed; use this to add a new runtime |
| `uninstall [-y]` | Stops the daemon and deletes `~/.kimi-webbridge/` — binary, config, logs, everything | Only when the user explicitly asks |

## Listen address

Default `127.0.0.1:10086`. Precedence: `start --addr` (this run only) > `addr` in `config.json` > default. `start`, `stop`, `status`, and `restart` all locate the daemon through the same config, so a moved daemon keeps every subcommand working. A malformed `config.json` makes all of them fail with an error naming the file — they never fall back to 10086 silently, so "status says not running" and "the file points elsewhere" can't be confused.

To move a **running** daemon: edit `addr` in `config.json`, then `kimi-webbridge restart` — `stop` still finds the old daemon through its own record, `start` binds the new address. (`start` alone on an edited config just reports the daemon is already running on the old address and points at `restart`.)

When another program holds the port, `start` fails with "did not come up … held by another program" and names the config file. Move the daemon:

1. Write `{"addr":"127.0.0.1:<port>"}` to `config.json`, any free port.
2. Run `start` — it prints the new address.
3. Ask the user to point the extension at it once: Kimi side panel → Settings → Local agent remote control → Connection address → `ws://127.0.0.1:<port>/ws`. The extension remembers it.

## `/status` fields

Always present:

- `running` (bool), `port` (int), `version` (daemon), `uptime_seconds`
- `extension_connected` (bool), `extension_id`, `extension_version` — empty strings when no extension is attached. Not connected means the extension isn't installed, the browser is closed, or — after a port move — the extension is still pointed at the old address (Settings → Local agent remote control → Connection address). The first two are for the user via the help page.
- `skills` — every place this skill is installed: `[{agent, path, version}]`

Present only when something needs doing — each carries a `command` that is the exact next step. Relay it to the user to run; don't run it yourself, since every one of them restarts the daemon:

- `version_mismatch` `{daemon, extension, message, command}` — daemon and extension differ in major.minor. `command` is the `upgrade <version>` that pairs them. While this is set, `update_available` is suppressed: pairing with the extension comes before chasing the newest release.
- `skill_mismatch` `{extension_version, outdated: [...], command}` — installed skill copies out of step with the extension; `command` reinstalls the matching version.
- `update_available` `{current, latest, command}` — a newer release exists and the extension's major.minor allows it; `command` is `kimi-webbridge upgrade`.

Anything else answering on the port (a bare 200, HTML, JSON without `running`) is not this daemon; the CLI reports `running:false` with a note saying so.
