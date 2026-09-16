# Remote runtimes

A remote runtime lets the agent's tools — reading and writing files, running Shell commands, and interactive terminals — execute on another machine or inside a container, while Kimi Code CLI itself, all model requests, and your credentials stay on your machine. Use it when the code lives on a remote server, or when you want tool execution isolated in a Docker-compatible container.

> Remote runtimes are experimental. Enable them with `KIMI_CODE_EXPERIMENTAL_REMOTE_RUNTIME=1` before starting Kimi Code, or write `remote_runtime = true` under `[experimental]` in `config.toml`. The master switch `KIMI_CODE_EXPERIMENTAL_FLAG=1` enables them too.

## How remote runtimes work

Kimi Code keeps the agent loop, model requests, credentials, approvals, and session state on your machine. The target environment only executes three groups of OS primitives: filesystem, process, and terminal. A small executor process (`kimi exec-server`) runs on the target and serves those primitives over a single connection; everything else — including every LLM request — stays local.

The security boundaries are fixed:

- **API keys never leave your machine**: LLM API keys and OAuth tokens are never sent to the target, and the executor never makes model requests.
- **Web tools stay local**: `WebSearch` and `FetchURL` always run from your machine, even in a remote session.
- **Hooks and MCP servers stay local**: lifecycle hooks and stdio MCP servers keep running on your machine — see [Limitations](#limitations).
- **SSH uses the system `ssh`**: the SSH launcher spawns the system `ssh` binary, so `~/.ssh/config` (users, ports, keys, `ProxyJump`, `ControlMaster`) and your ssh-agent apply as usual.

Only POSIX targets are supported; Windows targets are not.

::: info Remote runtimes vs. Remote Control
[Remote Control](./remote-control.md) is the opposite direction: it lets another device (like your phone) watch and steer sessions that run on **this** machine. A remote runtime does the reverse — this machine's CLI drives tool execution on **another** machine or container.
:::

## Declaring runtimes

Runtimes are declared in the `[runtimes]` section of `config.toml` (user level), or in a project's `.kimi-code/runtimes.toml` (project level). Three kinds of entries are available: SSH hosts, Docker-compatible containers, and custom launcher commands for anything else (OrbStack machines, `kubectl exec`, Apple Container, managed sandboxes, and so on).

```toml
[runtimes]
default = "dev-box"          # optional; new sessions start bound to this runtime

[runtimes.dev-box]
type = "ssh"
host = "dev-box"             # resolved by ~/.ssh/config: user, port, key, ProxyJump
defaultCwd = "/home/me/projects"

[runtimes.dev-container]
type = "docker"
container = "myapp-dev"
# context = "orbstack"       # optional docker context
defaultCwd = "/workspace"

[runtimes.gym]
command = "agi"              # executable name or absolute path
args = ["sandbox", "ssh", "i-1234567890", "--",
        "/home/me/.kimi-code/bin/kimi", "exec-server", "--listen", "stdio"]
env = { AGI_TOKEN = "..." }  # optional: environment for the launcher process only
defaultCwd = "/home/me/kimi-code"
```

Key rules:

- `type` and `command` are mutually exclusive within one entry: `type = "ssh"` and `type = "docker"` are built-in launchers, while `command` + `args` is the generic form (same shape as stdio entries in `.mcp.json`). `env` sets the launcher process's environment on your machine; it is **not** propagated into commands the agent runs on the target.
- `defaultCwd` prefills the working-directory prompt when you bind a session to the runtime. It is not validated locally and no path mapping is applied — it must be a valid path on the target.
- The optional top-level `default` names the runtime new sessions bind to initially; the entry it points at must set `defaultCwd`. Without a `default`, new sessions start on the `local` runtime.
- The runtime id is the entry's key: at most 64 characters, no leading or trailing whitespace; `local` and `default` are reserved words.

Declarations are picked up live: adding, editing, or removing an entry registers, replaces, or unregisters the runtime without a restart. A removed runtime drains rather than vanishing from under a session that still uses it — the session keeps its connection until in-flight work releases it (bounded to a few seconds), new tool calls fail with `runtime.not_found`, and nothing silently falls back to `local`.

For the full field reference, see [`runtimes`](../configuration/config-files.md#runtimes).

### Project-declared runtimes and trust

A project can ship its own declarations in `<project-root>/.kimi-code/runtimes.toml`, using the same schema plus an optional `default`. This covers the "code lives on a remote host" workflow: keep a local checkout (or an empty directory) as the declaration carrier, and let every session created in it bind to the remote runtime.

Project declarations are only loaded for trusted workspaces. On first launch in a folder, Kimi Code shows the workspace trust prompt; trusting the folder enables its declared runtimes (alongside any project MCP servers), and the prompt lists each declared runtime with its full launch command line so you can review exactly what will be executed. An untrusted workspace's `runtimes.toml` is ignored entirely.

A project entry with the same id overrides the user-level entry. When both levels set `default`, the project default wins; without any `default`, new sessions start on `local`. Project declarations are always read from the **local** workspace root — reading them from a remote disk would require a connection first.

## Switching runtimes in a session

The runtime binding is per session: it records which runtime the session's tools execute on, plus the working directory on that runtime. Different sessions in the same workspace may bind different runtimes, and subagents inherit their parent agent's binding.

### The `/runtime` dialog

The `/runtime` slash command opens the runtime manager, modeled after the provider manager:

- **List**: the `local` runtime plus every declared runtime, each row showing its id, type, connection status, and `defaultCwd`. Target OS/arch is not shown yet — it is only known after a connection handshake, so surfacing it in the list is a future enhancement.
- **Add**: create a new declaration from a minimal form — SSH entries can pick from hosts discovered in `~/.ssh/config`; other types or a custom command can be entered directly. The form writes the entry to `config.toml` and it takes effect immediately: the new runtime appears in the list and can be switched to without a restart.
- **Switch**: pick a runtime, then enter the working directory on the target (prefilled from the entry's `defaultCwd`). The directory is validated against the target's filesystem by the server; failures are reported inline, and a failed connection shows the exit code and a bounded slice of stderr.
- **Reconnect**: a runtime in the disconnected state offers an explicit reconnect action.

The footer shows the active runtime's identity (for example `ssh:dev-box`) before the working directory; `local` renders nothing. A disconnected runtime is shown in the error color with a banner, and the local git status slot is hidden for remote sessions. Approval prompts display the target environment next to the command or path, and `@` file completion is served by the server so candidates come from the target's filesystem.

Switching is refused while a turn is running or an approval is pending; the switch takes effect at the turn boundary.

### `kimi --runtime`

The hidden `--runtime <id>` flag binds a new session to a configured runtime directly — a one-shot override of the `[runtimes]` default, with the working directory taken from the entry's `defaultCwd`:

```sh
kimi -p --runtime dev-box "Run the test suite"
```

The flag is creation-only, like `--agent`: it cannot be combined with `--session`/`--continue`, because a resumed session restores its recorded binding automatically.

## Disconnects and reconnecting

A remote session depends on one connection per (workspace, runtime). When that connection drops — network loss, a stopped container, the executor exiting — every process the session started on the target is terminated. Terminal scrollback stays readable locally.

There is no automatic reconnect and **no silent fallback to the local runtime**: a command like `rm` or `git` that was meant for the remote machine must never land on yours. Instead, tool calls fail with a `runtime.unavailable` error, and you reconnect explicitly from the `/runtime` dialog. The same applies when resuming an old session: its binding is restored but not reconnected, so the first tool call errors until you reconnect.

SSH exit codes are shown as diagnostics when a connection dies — `255` indicates a network-level drop, `127` that the executor was not found on the target.

## The remote executor

The executor is a light build of Kimi Code itself, started as `kimi exec-server --listen stdio` on the target. It only serves filesystem, process, and terminal requests — it never touches model APIs, credentials, or session state.

The fixed install path is `~/.kimi-code/bin/kimi` on the target (override it per entry with `remoteBin` when the executor lives elsewhere, for example a preinstalled container image).

### Automatic installation

For `ssh` and `docker` entries, connecting to a target that has no executor triggers automatic installation: Kimi Code downloads the matching build for the target's OS and architecture, verifies it against a pinned SHA-256, and copies it over (`scp` for SSH, `docker cp` for containers). Container images can also preinstall the executor or mount it — point `remoteBin` at that absolute path.

`command` entries are never auto-installed; a missing executor fails with printed install guidance. When automatic installation is unavailable or fails, the error message includes the exact manual commands to run.

### Version compatibility

The connection handshake requires a minimum executor version and a POSIX target. An executor that is too old is rejected with upgrade guidance; reinstall it (or delete `~/.kimi-code/bin/kimi` on the target and reconnect) to pick up the current version.

## Limitations

Remote runtimes are experimental, and several behaviors are deliberately scoped. Each of the following is a known limitation:

- **Hooks run on the Kimi Code host**: `PreToolUse` and other lifecycle hooks always execute on the machine running Kimi Code, so in a remote session they observe local facts (local files, local processes), not the target's.
- **MCP servers stay local**: stdio MCP servers keep running on your machine even in remote sessions; they do not see the target's filesystem.
- **No hot reload on remote workspaces**: file watching is outside the remote abstraction, so changes to `AGENTS.md`, project skills, or MCP configuration on the target are not picked up live. The initial load when a session starts works normally; reconnect or restart the session to pick up later changes.
- **Tower mode unsupported**: tower multi-agent orchestration does not work on remote workspaces.
- **Git status slot hidden**: the CLI footer's git indicators (branch, status, PR) are local-only and hidden for remote sessions.
- **`/feedback` scanner unsupported**: the codebase scanner attached to `/feedback` scans the local disk and is unavailable for remote workspaces; a notice is shown instead.
- **Permission path patterns fail closed**: saved permission rules carry path patterns from the runtime they were approved on. After switching runtimes, old patterns silently stop matching — fail-closed, so you see more approval prompts, never fewer. Re-approve under the new runtime to save fresh rules.
- **Same path on two hosts shares one workspace entry**: workspaces are keyed by root path alone, so `/home/me/app` on two different hosts maps to a single workspace. A cosmetic side effect: the TUI's `~` abbreviation may render remote paths against your local home directory.
- **Local file paths in prompts are unreadable remotely**: a path like `/tmp/x.png` typed into a prompt resolves on the target's filesystem, so the agent cannot read your local files by path. Pasted images are unaffected — they travel as binary attachments, not paths.
- **Small-file latency adds up**: session startup reads many small files, and each read is a remote round trip; remote sessions start slower than local ones.
- **One connection per (workspace, runtime)**: there is no connection pooling — every workspace bound to the same runtime opens its own connection (SSH `ControlMaster` in `~/.ssh/config` mitigates this for SSH targets).

## Next steps

- [`runtimes` configuration reference](../configuration/config-files.md#runtimes) — every field of the `[runtimes]` section and `.kimi-code/runtimes.toml`
- [Remote Control](./remote-control.md) — the reverse direction: steer this machine's sessions from another device
