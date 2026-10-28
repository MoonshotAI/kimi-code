# Remote environments

A remote environment lets the agent's tools — reading and writing files, and running Shell commands — execute on another machine or inside a container, while Kimi Code CLI itself, all model requests, and your credentials stay on your machine. Use it when the code lives on a remote server, or when you want tool execution isolated in a Docker-compatible container.

## How remote environments work

Kimi Code keeps the agent loop, model requests, credentials, approvals, and session state on your machine. The target environment only executes two groups of OS primitives: filesystem and process. A small executor process (`kimi exec-server`) runs on the target and serves those primitives over a single connection; everything else — including every LLM request — stays local.

Plan files stay in the local session directory, including in remote sessions. `Read`, `Write`, and `Edit` address the current plan locally; saved plans remain readable after leaving plan mode. Task output is also retained locally and mirrored to the target when available. If that mirror fails, the returned local output path remains readable with `Read`.

The security boundaries are fixed:

- **API keys never leave your machine**: LLM API keys and OAuth tokens are never sent to the target, and the executor never makes model requests.
- **Web tools stay local**: `WebSearch` and `FetchURL` always run from your machine, even in a remote session.
- **Hooks and MCP servers stay local by default**: lifecycle hooks and stdio MCP servers without an explicit `environment_id` run on your machine — see [Limitations](#limitations).
- **SSH uses the system `ssh`**: the SSH launcher spawns the system `ssh` binary, so `~/.ssh/config` (users, ports, keys, `ProxyJump`, `ControlMaster`) and your ssh-agent apply as usual — see [SSH authentication](#ssh-authentication) for passwords, passphrases, and host keys.

Only POSIX targets are supported; Windows targets are not.

::: info Remote environments vs. Remote Control
[Remote Control](./remote-control.md) is the opposite direction: it lets another device (like your phone) watch and steer sessions that run on **this** machine. A remote environment does the reverse — this machine's CLI drives tool execution on **another** machine or container.
:::

## Declaring environments

Environments are declared in the `[environments]` section of `config.toml`. Three kinds of entries are available: SSH hosts, Docker-compatible containers, and custom launcher commands for anything else (OrbStack machines, `kubectl exec`, Apple Container, managed sandboxes, and so on).

```toml
[environments]
default = "dev-box"          # optional; sessions created without an explicit binding start here

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
args = ["ssh", "i-1234567890", "--"]  # how to reach the target; Kimi Code appends the executor invocation
env = { SANDBOX_TOKEN = "..." }  # optional: environment for the launcher process only
defaultCwd = "/home/me/kimi-code"
```

Key rules:

- `type` and `command` are mutually exclusive within one entry: `type = "ssh"` and `type = "docker"` are built-in launchers, while `command` + `args` is the generic form (same shape as stdio entries in `.mcp.json`). For the generic form, Kimi Code appends `<remoteBin> exec-server` (default `~/.kimi-code/bin/kimi`) after `args` unless `args` already invokes `exec-server`; launchers that pass arguments straight through without a shell, such as `kubectl exec`, need an absolute `remoteBin` because `~` is not expanded. `env` sets the launcher process's environment on your machine; it is **not** propagated into commands the agent runs on the target.
- `defaultCwd` is used when a session is created on the environment unless `--environment-cwd` overrides it. It must be an absolute POSIX path on the target; relative paths and `~` are not expanded against your machine or the target's home. Repeated separators, `.` and `..` are normalized before checking that directory on the target, and the normalized path is saved in the binding. Symlink names are preserved, not rewritten with realpath; `symlink/..` therefore uses the lexical parent, not the symlink target's physical parent.
- The optional top-level `default` names the environment a session binds to when creation does not specify one — a cold start, print mode, or an API create. The entry it points at must set `defaultCwd`. Without a `default`, those sessions start on the `local` environment. In the TUI, `/new` instead keeps the current session's environment and working directory. If no session exists yet, `/new` uses `--environment` when the process was started with it, otherwise the resolved default.
- If the configuration file cannot be read or the `[environments]` section is invalid, session creation fails with `config.invalid` instead of treating this as no default. Explicitly selecting `local` still creates a local session.
- The environment id is the entry's key: at most 64 characters, no leading or trailing whitespace; `local` and `default` are reserved words.

With file watching enabled, declaration edits are applied without a restart. Removing an environment does not silently rebind a session to `local`; subsequent tool calls fail with `environment.not_found` or `environment.unavailable`.

Changing an environment's launcher (for example `host`, `container`, `context`, `remoteBin`, `command`, `args`, or `env`) disconnects it and terminates running remote commands and remote MCP servers. The next use connects with the new launcher; project instructions (`AGENTS.md`) and project skills already loaded in a session are not refreshed.

Environment IDs are process-wide: sessions bound to the same ID share one connection, and their working directories can differ.

For the full field reference, see [`environments`](../configuration/config-files.md#environments).

## Creating and resuming sessions

The environment binding is per session: it records which environment the session's tools execute on, plus the working directory on that environment. Different sessions in the same workspace may bind different environments, and subagents inherit their parent agent's binding. Creating a remote session records a persisted reminder with the environment id, OS and architecture, shell, and working directory so the model knows where its tools run. Creating a session on `local` records nothing.

### `kimi --environment` and `--environment-cwd`

The hidden `--environment <id>` flag binds a new session to a configured environment, overriding the `[environments]` default for that creation. The hidden `--environment-cwd <path>` flag overrides the selected entry's `defaultCwd` and must be used together with `--environment`:

```sh
kimi --environment dev-box --environment-cwd /home/me/projects -p "Run the test suite"
```

Both flags are creation-only: they cannot be combined with `--session` or `--continue`, because a resumed session restores its recorded binding automatically. They bind the first session in the process. A later `/new` keeps the live binding instead of applying the flags again; `/new` uses them only when no session exists yet. An unknown id, an entry without `defaultCwd` when no override is given, or an invalid target directory fails startup outright. Creation also connects to the target before the session starts, so a connection failure aborts with the reported reason instead of opening a broken session.

Resuming reads the persisted environment id and working directory and reconnects to the target. If the environment is not registered or cannot be reached, resuming fails instead of opening the session on `local`.

The footer shows the active environment's identity before the working directory; `local` renders nothing. A disconnected environment is shown with its failure reason, and the local git status slot is hidden for remote sessions. Approval prompts display the target environment next to the command or path, and `@` file completion queries the target filesystem.

## Disconnects and reconnecting

Each environment id keeps one connection for the whole process. Workspaces bound to that id share it; a different id, including another id on the same machine, keeps its own. Two layers decide when the connection is dead: the SSH launcher's transport keepalive (`ServerAliveInterval`), and a protocol-level liveness probe — after about 30 seconds of idle time the client sends a `ping` to the executor, and no response within 10 seconds means the connection is dead. Any inbound traffic resets the idle clock so active transfers are never probed, and executors too old to know `ping` disable the probe automatically. A closed local pipe is also a disconnect signal. When the connection drops — network loss, a stopped container, or the executor exiting — every workspace using that id goes `disconnected` at once, and the processes it started on the target end with the connection.

There is **no silent fallback to the local environment** after a drop: a command like `rm` or `git` that was meant for the remote machine must never land on yours. The next tool call opens the pipe again. While the target stays unreachable, tool calls fail with an `environment.unavailable` error. A call that was already in flight on the old connection fails and is not retried on the new connection.

Every connect attempt is bounded to 10 seconds: a target that never answers the handshake fails with an `initialize timed out` error instead of hanging silently, and when the launcher wrote anything to stderr — a stuck password prompt or an `npx` download's progress — the error includes that tail so the cause is visible.

## SSH authentication

By default, SSH connections are non-interactive. The launcher spawns the system `ssh` with `-T` (no terminal allocated) and `-o BatchMode=yes`. BatchMode disables every interactive prompt — password, key passphrase, host-key confirmation — because the connection's input and output streams carry the protocol traffic, leaving no terminal to answer a prompt on. A host that requires any of these fails fast with an error like `Permission denied (publickey,password)`, surfaced as a connection failure during creation or the next tool call, instead of hanging on a prompt nobody can see.

In the interactive TUI, if authentication fails and the server offers `password` or `keyboard-interactive`, Kimi Code CLI also prompts for the SSH password and retries through OpenSSH Askpass (a helper that supplies credentials without a terminal). The password is kept only in process memory for reconnects and is never written to config or a credential store. Changing the environment or exiting Kimi Code CLI discards it.

This fallback requires OpenSSH 8.4 or later and covers passwords and same-password keyboard-interactive authentication, not independent OTP/MFA challenges or private-key passphrase prompts. `kimi -p` and other clients without an interactive password callback keep the fail-fast behavior.

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

The executor is a light build of Kimi Code itself, started as `kimi exec-server` on the target. It only serves filesystem and process requests — it never touches model APIs, credentials, or session state. stdio is the default and only supported transport, so the explicit `kimi exec-server --listen stdio` spelling is equivalent and keeps working.

The fixed install path is `~/.kimi-code/bin/kimi` on the target (override it per entry with `remoteBin` when the executor lives elsewhere, for example a preinstalled container image).

### Installing the executor

Kimi Code does not install the executor automatically. When a connect finds no executor at the expected path, the connection fails with guidance to download the binary for the target platform from the Kimi Code release CDN and install it at the expected path. For `docker` entries you can also preinstall the executor in the image or bind-mount it, and point `remoteBin` at that absolute path. For `command` entries, install the matching build at the absolute path your launcher command invokes.

### Version compatibility

The connection handshake requires a minimum executor version and a POSIX target. An executor that is too old is rejected with upgrade guidance — install the current build over it, then reconnect.

## Limitations

Several behaviors are deliberately scoped. Each of the following is a known limitation:

- **Hooks run on the Kimi Code host**: `PreToolUse` and other lifecycle hooks always execute on the machine running Kimi Code, so in a remote session they observe local facts (local files, local processes), not the target's. They run with the session's local working directory; hooks that would execute on the target itself are a future, undesigned concept.
- **MCP servers stay local by default**: stdio MCP servers without an explicit `environment_id` keep running on your machine even in remote sessions; they do not see the target's filesystem. MCP configuration comes from the local directory you started Kimi Code in, including its project-level configuration; MCP configuration on the target is not read.
- **Remote sessions load only user-level agent files**: project-level agent files can replace the system prompt, and workspace trust currently covers local paths only, so remote sessions read neither `.kimi-code/agents/` nor `.agents/agents/` on the target, and do not apply the project-level agent files of the directory you started in.
- **No hot reload on remote workspaces**: file watching is outside the remote abstraction, so changes to `AGENTS.md` or project skills on the target are not picked up live; they are read again when you create or resume a session, or run `/reload`.
- **Tower mode unsupported**: tower multi-agent orchestration does not work on remote workspaces.
- **Git status slot hidden**: the CLI footer's git indicators (branch, status, PR) are local-only and hidden for remote sessions.
- **`/feedback` scanner unsupported**: the codebase scanner attached to `/feedback` scans the local disk and is unavailable for remote workspaces; a notice is shown instead.
- **Same path on two hosts shares one workspace entry**: workspaces are keyed by root path alone, so `/home/me/app` on two different hosts maps to a single workspace. A cosmetic side effect: the TUI's `~` abbreviation may render remote paths against your local home directory.
- **Local file paths in prompts are unreadable remotely**: a path like `/tmp/x.png` typed into a prompt resolves on the target's filesystem, so the agent cannot read your local files by path. Pasted images are unaffected — they travel as binary attachments, not paths.
- **Directory listing limit**: listing a remote directory with more than 50,000 entries fails explicitly instead of returning a partial list. Use a smaller subdirectory or split the directory. Skill discovery logs directories it cannot scan.
- **Small-file latency adds up**: session startup reads many small files, and each read is a remote round trip; remote sessions start slower than local ones.
- **One shared connection per target**: workspaces bound to the same environment share a single connection instead of opening one each. The flip side: a connection drop affects every workspace bound to that target, and a turn in flight on the old connection fails as on a drop.

## Next steps

- [`environments` configuration reference](../configuration/config-files.md#environments) — every field of the `[environments]` section
- [Remote Control](./remote-control.md) — the reverse direction: steer this machine's sessions from another device
