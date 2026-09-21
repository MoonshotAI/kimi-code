# Remote environments

A remote environment lets the agent's tools — reading and writing files, running Shell commands, and interactive terminals — execute on another machine or inside a container, while Kimi Code CLI itself, all model requests, and your credentials stay on your machine. Use it when the code lives on a remote server, or when you want tool execution isolated in a Docker-compatible container.

## How remote environments work

Kimi Code keeps the agent loop, model requests, credentials, approvals, and session state on your machine. The target environment only executes three groups of OS primitives: filesystem, process, and terminal. A small executor process (`kimi exec-server`) runs on the target and serves those primitives over a single connection; everything else — including every LLM request — stays local.

The security boundaries are fixed:

- **API keys never leave your machine**: LLM API keys and OAuth tokens are never sent to the target, and the executor never makes model requests.
- **Web tools stay local**: `WebSearch` and `FetchURL` always run from your machine, even in a remote session.
- **Hooks and MCP servers stay local**: lifecycle hooks and stdio MCP servers keep running on your machine — see [Limitations](#limitations).
- **SSH uses the system `ssh`**: the SSH launcher spawns the system `ssh` binary, so `~/.ssh/config` (users, ports, keys, `ProxyJump`, `ControlMaster`) and your ssh-agent apply as usual — see [SSH authentication](#ssh-authentication) for passwords, passphrases, and host keys.

Only POSIX targets are supported; Windows targets are not.

::: info Remote environments vs. Remote Control
[Remote Control](./remote-control.md) is the opposite direction: it lets another device (like your phone) watch and steer sessions that run on **this** machine. A remote environment does the reverse — this machine's CLI drives tool execution on **another** machine or container.
:::

## Declaring environments

Environments are declared in the `[environments]` section of `config.toml` (user level). Three kinds of entries are available: SSH hosts, Docker-compatible containers, and custom launcher commands for anything else (OrbStack machines, `kubectl exec`, Apple Container, managed sandboxes, and so on).

```toml
[environments]
default = "dev-box"          # optional; new sessions start bound to this environment

[environments.dev-box]
type = "ssh"
host = "dev-box"             # resolved by ~/.ssh/config: user, port, key, ProxyJump
defaultCwd = "/home/me/projects"

[environments.dev-container]
type = "docker"
container = "myapp-dev"
# context = "orbstack"       # optional docker context
defaultCwd = "/workspace"

[environments.sandbox]
command = "sandbox"              # executable name or absolute path
args = ["ssh", "i-1234567890", "--",
        "/home/me/.kimi-code/bin/kimi", "exec-server"]
env = { SANDBOX_TOKEN = "..." }  # optional: environment for the launcher process only
defaultCwd = "/home/me/kimi-code"
```

Key rules:

- `type` and `command` are mutually exclusive within one entry: `type = "ssh"` and `type = "docker"` are built-in launchers, while `command` + `args` is the generic form (same shape as stdio entries in `.mcp.json`). `env` sets the launcher process's environment on your machine; it is **not** propagated into commands the agent runs on the target.
- `defaultCwd` prefills the working-directory prompt when you bind a session to the environment. It is not validated locally and no path mapping is applied — it must be a valid path on the target.
- The optional top-level `default` names the environment new sessions bind to initially; the entry it points at must set `defaultCwd`. Without a `default`, new sessions start on the `local` environment.
- The environment id is the entry's key: at most 64 characters, no leading or trailing whitespace; `local` and `default` are reserved words.

Environments added through `/environment` are available as soon as the operation completes, even when [file watching](../configuration/config-files.md#watch) is disabled. With file watching enabled, editing declaration files also registers, replaces, or unregisters environments without a restart. A removed environment drains rather than vanishing from under a session that still uses it — the session keeps its connection until in-flight work releases it (bounded to a few seconds), new tool calls fail with `environment.not_found`, and nothing silently falls back to `local`.

For the full field reference, see [`environments`](../configuration/config-files.md#environments).

## Switching environments in a session

The environment binding is per session: it records which environment the session's tools execute on, plus the working directory on that environment. Different sessions in the same workspace may bind different environments, and subagents inherit their parent agent's binding.

The model is kept informed about where its tools run: creating a session bound to a remote environment, and every switch in either direction, records a persisted reminder with the environment id, OS and architecture, shell, and working directory. Creating a session on `local` records nothing.

### The `/environment` dialog

The `/environment` slash command opens the environment manager, modeled after the provider manager:

The manager appears immediately with a loading indicator while it fetches the latest environment list, so a slow connection does not leave the TUI blank.

- **List**: the `local` environment plus every declared environment, each row showing its id, type, connection status, and `defaultCwd`. Target OS/arch is not shown yet — it is only known after a connection handshake, so surfacing it in the list is a future enhancement.
- **Add**: create a new declaration from a minimal form — SSH entries can pick from hosts discovered in `~/.ssh/config`; other types or a custom command can be entered directly. The entry is written to the user-level `config.toml` and takes effect immediately: the new environment appears in the list and can be switched to without a restart.
- **Switch**: pick an environment, then enter the working directory on the target (prefilled from the entry's `defaultCwd`). The directory is validated against the target's filesystem by the server; failures are reported inline, and a failed connection shows the exit code and a bounded slice of stderr.
- **Reconnect**: an environment in the disconnected or pending state offers an explicit reconnect action.

The footer shows the active environment's identity (for example `ssh:dev-box`) before the working directory; `local` renders nothing. A disconnected environment is shown in the error color with a banner, while a pending one — never connected yet — renders dim with no error tone, and the local git status slot is hidden for remote sessions. Approval prompts display the target environment next to the command or path, and `@` file completion is served by the server so candidates come from the target's filesystem.

Switching is refused while tool calls are executing or an approval is pending — retry once the turn settles. An accepted switch takes effect immediately: the session's next tool call already runs on the new environment.

### `kimi --environment`

The hidden `--environment <id>` flag binds a new session to a configured environment directly — a one-shot override of the `[environments]` default, with the working directory taken from the entry's `defaultCwd`:

```sh
kimi -p --environment dev-box "Run the test suite"
```

The flag is creation-only, like `--agent`: it cannot be combined with `--session`/`--continue`, because a resumed session restores its recorded binding automatically. An unknown id, or an entry without `defaultCwd`, fails startup outright. Creation also connects to the target before the session starts, so a connection failure aborts with the reported reason instead of opening a broken session.

## Agent environment tools

The switches above are driven by you. The agent environment tools instead hand environment switching to the agent itself: the main agent gains two tools, and its system prompt lists the environments available in the session's workspace so it knows which ids exist. Everything else on this page — the binding model, the reminder recorded on every switch, undo restoring the previous binding — applies unchanged.

The tools are off by default. To opt in, set `KIMI_CODE_EXPERIMENTAL_AGENT_ENVIRONMENT_TOOLS=1`, write `[experimental] agent_environment_tools = true` in `config.toml`, or toggle the feature on in `/experiments` before creating the session. Sessions created while it is disabled have neither the tools nor the prompt section.

The main agent can:

- **Switch with `change_environment`**: pass an environment `id` (`local` or a declared id) and optionally a `cwd` (falls back to the declaration's `defaultCwd`). The target connects eagerly — a connection or `cwd` validation failure is reported immediately and changes nothing — and the switch itself takes effect as soon as the tool call completes: the next tool call in the same turn already runs on the new environment. When other tool calls are still executing in parallel, the call instead fails with an error naming the in-flight count — retry once they have finished, and their work is never yanked mid-flight. The reminder with the new environment's details arrives with the next turn.
- **Create a temporary environment with `connect`**: pass a launcher spec — `{ type: "ssh", host: "..." }`, `{ type: "docker", container: "..." }`, or `{ type: "command", command: "...", args: [...] }`, with an optional `id`. The environment connects right away and is registered in the workspace like a declared one, but nothing is written to `config.toml`: a temporary environment vanishes when the process exits, cannot be reconnected after a connection drop (create a fresh one instead), and a session resumed onto it finds it gone.
- **Bind a subagent with the `environment` parameter**: the `Agent` tool accepts an optional `environment` id; the spawned subagent binds to that environment (at its `defaultCwd`) instead of inheriting the parent's binding. Resumed subagents keep their own binding.

Two guardrails apply to both tools. They are rejected in Plan mode — exit plan mode first. And they follow the permission mode: only Always Ask mode asks for confirmation before switching or connecting; Ask When Needed and Never Ask modes proceed without asking. The tool group is not registered while tower mode is active.

## Disconnects and reconnecting

Workspaces bound to the same target share one connection per environment: the first workspace to connect builds it, and the rest reuse it. When that connection drops — network loss, a stopped container, the executor exiting — every workspace bound to the target goes `disconnected` at once, and every process the sessions started on the target is terminated. Terminal scrollback stays readable locally.

There is **no silent fallback to the local environment** after a drop: a command like `rm` or `git` that was meant for the remote machine must never land on yours. The next tool call retries the connection on demand — while the target stays unreachable, tool calls fail with an `environment.unavailable` error, and you can also reconnect explicitly from the `/environment` dialog.

Reconnecting replaces the **shared** connection, so it reaches every workspace bound to the same target: whichever workspace triggers it — the `/environment` dialog, the REST API, or an automatic retry — Kimi Code builds a fresh connection and switches every workspace's view to it. A turn still in flight on the old connection fails with `environment.unavailable`, exactly as if the connection had dropped.

Resuming a session works the same way: the restored binding is tried once at load, and when the target is unreachable the session still opens with the binding kept and the environment left `disconnected`. The first tool call retries the connection, and there is never a silent fallback to `local`.

Every connect attempt is bounded to 10 seconds: a target that never answers the handshake fails with an `initialize timed out` error instead of hanging silently, and when the launcher wrote anything to stderr — a stuck password prompt, an `npx` download's progress — the error includes that tail, so the cause is visible.

SSH exit codes are shown as diagnostics when a connection dies — `255` indicates a network-level drop, `127` that the executor was not found on the target.

## SSH authentication

SSH connections are non-interactive. The launcher spawns the system `ssh` with `-T` (no terminal allocated) and `-o BatchMode=yes`. BatchMode disables every interactive prompt — password, key passphrase, host-key confirmation — because the connection's input and output streams carry the protocol traffic, leaving no terminal to answer a prompt on. A host that requires any of these fails fast with an error like `Permission denied (publickey,password)`, surfaced as a connection failure in the `/environment` dialog, instead of hanging on a prompt nobody can see.

Every non-interactive method the system `ssh` supports works unchanged, configured through `~/.ssh/config` and your shell environment:

- **Keys**: `IdentityFile` entries and the default key paths under `~/.ssh/`, for keys without a passphrase.
- **ssh-agent**: `SSH_AUTH_SOCK` is inherited from the terminal you start Kimi Code from, so the agent (a background program that holds your unlocked keys) authenticates BatchMode connections without prompting. For a passphrase-protected key, run `ssh-add` once in your own terminal first.
- **`ProxyJump` / `ProxyCommand`**: jump hosts configured in `~/.ssh/config` apply as usual.
- **`ControlMaster`**: BatchMode connections can ride an existing master connection — the basis of the password-only setup below.

Host keys use `StrictHostKeyChecking=accept-new` (trust on first use): the first connection to a new host records its key in `known_hosts` without asking, while a later host-key change fails the connection until you fix the entry by hand.

A host that only accepts passwords has two working setups, both prepared once from your own terminal:

- **Copy a key over**: run `ssh-copy-id user@host` and type the password a single time. From then on, key authentication works non-interactively.
- **Share a master connection**: enable connection sharing in `~/.ssh/config`, then open one master connection yourself — `ssh user@host` in a terminal, typing the password once. While that master stays alive in the background, every later connection (including BatchMode ones) reuses it without prompting.

```ssh-config
Host dev-box
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist yes
```

## The remote executor

The executor is a light build of Kimi Code itself, started as `kimi exec-server` on the target. It only serves filesystem, process, and terminal requests — it never touches model APIs, credentials, or session state. stdio is the default and only supported transport, so the explicit `kimi exec-server --listen stdio` spelling is equivalent and keeps working.

The fixed install path is `~/.kimi-code/bin/kimi` on the target (override it per entry with `remoteBin` when the executor lives elsewhere, for example a preinstalled container image).

### Installing the executor

Kimi Code does not install the executor automatically. When a connect finds no executor at the expected path, the connection fails with install guidance: it probes the target's OS and architecture, then prints the exact commands for your launcher type — download the verified build from the release CDN, copy it over (`scp` for SSH, `docker cp` for containers), and activate it with `chmod` + `mv`. Run the printed commands, then reconnect.

For `docker` entries you can also preinstall the executor in the image or bind-mount it, and point `remoteBin` at that absolute path. For `command` entries the guidance cannot probe the target — install the matching build at the absolute path your launcher command invokes.

### Version compatibility

The connection handshake requires a minimum executor version and a POSIX target. An executor that is too old is rejected with upgrade guidance — run the printed commands to install the current build over it, then reconnect.

## Limitations

Several behaviors are deliberately scoped. Each of the following is a known limitation:

- **Hooks run on the Kimi Code host**: `PreToolUse` and other lifecycle hooks always execute on the machine running Kimi Code, so in a remote session they observe local facts (local files, local processes), not the target's. They run with the session's local working directory; hooks that would execute on the target itself are a future, undesigned concept.
- **MCP servers stay local**: stdio MCP servers keep running on your machine even in remote sessions; they do not see the target's filesystem.
- **No hot reload on remote workspaces**: file watching is outside the remote abstraction, so changes to `AGENTS.md`, project skills, or MCP configuration on the target are not picked up live. The initial load when a session starts works normally; reconnect or restart the session to pick up later changes.
- **Tower mode unsupported**: tower multi-agent orchestration does not work on remote workspaces.
- **Git status slot hidden**: the CLI footer's git indicators (branch, status, PR) are local-only and hidden for remote sessions.
- **`/feedback` scanner unsupported**: the codebase scanner attached to `/feedback` scans the local disk and is unavailable for remote workspaces; a notice is shown instead.
- **Permission path patterns fail closed**: saved permission rules carry path patterns from the environment they were approved on. After switching environments, old patterns silently stop matching — fail-closed, so you see more approval prompts, never fewer. Re-approve under the new environment to save fresh rules.
- **Same path on two hosts shares one workspace entry**: workspaces are keyed by root path alone, so `/home/me/app` on two different hosts maps to a single workspace. A cosmetic side effect: the TUI's `~` abbreviation may render remote paths against your local home directory.
- **Local file paths in prompts are unreadable remotely**: a path like `/tmp/x.png` typed into a prompt resolves on the target's filesystem, so the agent cannot read your local files by path. Pasted images are unaffected — they travel as binary attachments, not paths.
- **Directory listing limit**: listing a remote directory with more than 50,000 entries fails explicitly instead of returning a partial list. Use a smaller subdirectory or split the directory. Skill discovery logs directories it cannot scan.
- **Small-file latency adds up**: session startup reads many small files, and each read is a remote round trip; remote sessions start slower than local ones.
- **One shared connection per target**: workspaces bound to the same environment share a single connection instead of opening one each. The flip side: a connection drop — or an explicit reconnect from any one workspace — affects every workspace bound to that target, and a turn in flight on the old connection fails as on a drop.

## Next steps

- [`environments` configuration reference](../configuration/config-files.md#environments) — every field of the `[environments]` section
- [Remote Control](./remote-control.md) — the reverse direction: steer this machine's sessions from another device
