# Sandbox

Kimi Code can run the agent's `Bash` commands inside an OS-level sandbox — the same approach as claude-code (sandbox-runtime) and codex: the whole filesystem is mounted read-only inside the sandbox, only the workspace and a small set of roots stay writable, sensitive paths can be masked, and the network is cut off by default. The sandbox is enforced by the kernel (Linux namespaces via [bubblewrap](https://github.com/containers/bubblewrap), macOS Seatbelt via `sandbox-exec`), so it holds regardless of what the command line does — unlike the lexical path checks the file tools already perform.

The sandbox only wraps `Bash` command execution. File tools (Read/Write/Edit/Grep/Glob) are covered separately through the permission policies described in [Interaction with the permission system](#interaction-with-the-permission-system).

## Quick start

```toml
# ~/.kimi-code/config.toml
[sandbox]
enabled = true
```

On Linux, install bubblewrap first (`apt install bubblewrap` / `dnf install bubblewrap` / `pacman -S bubblewrap`). On macOS no extra dependency is needed (`sandbox-exec` ships with the system). See [Platform support](#platform-support) and [Failure behavior](#failure-behavior).

## Platform support

| Platform | Backend | Requirement |
| --- | --- | --- |
| Linux | bubblewrap (`bwrap`) | `bwrap` on PATH, with user namespaces usable (the availability probe actually runs a trivial sandboxed command, so restrictions like Ubuntu 24.04's AppArmor user-namespace limits are detected) |
| macOS | Seatbelt (`sandbox-exec`) | None (system binary) |
| Windows | Not supported | Commands run unsandboxed; a warning is logged once per session |

The backend is probed lazily on the first sandboxed command and cached for the rest of the session.

## Configuration reference

All fields are optional; the defaults below apply when a field is omitted.

```toml
[sandbox]
enabled = false                        # Master switch. Default: off.
mode = "workspace-write"               # "workspace-write" | "read-only". Write baseline inside the sandbox.
require = false                        # true = refuse to run Bash when no backend is available (fail-closed).
auto_allow_sandboxed_bash = true       # Sandboxed Bash calls skip the approval prompt.
excluded_commands = []                 # Command prefixes that bypass the sandbox.

[sandbox.filesystem]
deny_read = []                         # Extra paths to mask (appended to the built-in sensitive list).
allow_write = []                       # Extra writable roots on top of the mode defaults.
deny_write = []                        # Paths inside writable roots re-protected as read-only.

[sandbox.network]
enabled = false                        # false = no network inside the sandbox.
allowed_domains = []                   # Reserved for the Phase 3 domain allowlist proxy; inert today (see note).
allow_unix_sockets = []                # Reserved (e.g. an ssh-agent socket); inert today.
```

### `mode`

- **`workspace-write`** (default): writable roots are the session working directory, its additional directories, the system temp directory, and everything in `filesystem.allow_write`.
- **`read-only`**: writable roots shrink to the system temp directory plus `filesystem.allow_write`. The workspace itself is read-only — useful for audit / review-style sessions. Writes outside the writable roots are also hard-denied by the permission layer in this mode (see below).

### `filesystem` rule semantics

`deny_read`, `allow_write`, and `deny_write` entries are **literal paths, not glob patterns**:

- A leading `~` is expanded to your home directory.
- An entry matches the path itself or anything beneath it (a trailing `/**` is accepted and simply marks the subtree explicitly). Matching is separator-aware — `/foo` never matches `/foo-evil/x`.
- Other glob syntax (`*`, `**` in the middle, `?`) is not supported.
- `deny_read` beats the writable roots, `deny_write` beats `allow_write` / the mode defaults — deny always wins.
- On Linux, `deny_read` / `deny_write` entries that do not exist are skipped (bubblewrap cannot mount over a non-existent path).

### Built-in `deny_read` list

The sandbox always masks a built-in set of credential locations — it cannot be turned off, and `filesystem.deny_read` appends to it:

```
~/.ssh  ~/.aws  ~/.gnupg  ~/.azure  ~/.config/gcloud
~/.kube  ~/.docker  ~/.netrc  ~/.git-credentials  ~/.config/gh
```

In addition, a literal `.env` directly under each writable root (the workspace, its additional directories, the temp directory, and each `allow_write` entry) is masked. A `.env` in a **nested subdirectory** is not covered by this built-in rule — add the concrete directory to `filesystem.deny_read` if you need it masked.

Host daemon sockets are masked as well, since unix-domain sockets bypass network isolation: `/var/run/docker.sock`, `/run/docker.sock`, `/var/run/containerd.sock`, `/run/containerd/containerd.sock`, `/run/crio/crio.sock`, `/run/podman/podman.sock`, plus `$XDG_RUNTIME_DIR/bus`, `$XDG_RUNTIME_DIR/docker.sock`, `$XDG_RUNTIME_DIR/podman/podman.sock`, and `$XDG_RUNTIME_DIR/gnupg` (when `XDG_RUNTIME_DIR` is set or resolvable as `/run/user/<uid>`).

Sensitive files beyond these paths (`credentials` files, SSH key variants, …) are also hard-denied for the file tools by the permission layer while the sandbox is enabled — see below.

### Environment variable scrubbing

Sandboxed commands do not inherit secret-bearing environment variables: names ending in `_API_KEY`, `_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD`, or `_CREDENTIALS` (case-insensitive), plus `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `GPG_AGENT_INFO`, and `XAUTHORITY`, are blanked out in the command's environment. This is not configurable; put non-secret values in ordinary variables if a sandboxed command needs them.

### `network`

With `enabled = false` (default) the sandboxed command runs in a private network namespace with no connectivity (Linux) or with all network operations denied (macOS).

::: warning
`allowed_domains` is accepted by the schema but **has no effect yet** — the domain-allowlist proxy ships in Phase 3. Setting it prints a one-time warning; network access is still governed solely by `network.enabled`.
:::

### `excluded_commands` matching semantics

Some commands cannot work inside a sandbox (e.g. `docker`, which needs its daemon socket). `excluded_commands` entries bypass the sandbox and run through the normal approval flow instead. Matching:

1. The command line is split into segments on `&&`, `||`, `;`, `|`, and newlines.
2. Leading `VAR=value` environment assignments are stripped from each segment.
3. An entry matches when it equals the segment text or is a prefix of it followed by a space — so `docker` matches `docker ps` but not `docker-compose up`, and multi-word entries like `"git push"` work as expected.

## Failure behavior

- **Fail-open (default)**: if the sandbox backend is missing or unusable (no `bwrap`, restricted user namespaces, unsupported platform), a warning is logged once and commands run unsandboxed.
- **Fail-closed**: with `require = true`, a missing backend makes every `Bash` call fail with an explanatory error instead of running.

When a sandboxed command's output shows sandbox-denial signatures (e.g. `Operation not permitted`, a `bwrap:` error), the tool result carries a hint suggesting you add the command to `sandbox.excluded_commands` in case it was a false positive.

## Interaction with the permission system

While `sandbox.enabled = true`, three permission policies take effect (in addition to the OS-level enforcement on `Bash`):

1. **Sandboxed Bash skip-approval** — a `Bash` call that will run inside the sandbox is approved without prompting (disable with `auto_allow_sandboxed_bash = false`). User `deny` rules and the checks below still take precedence.
2. **Hard deny** — evaluated before mode-based auto-approval (`--auto` / `--yolo`):
   - reads/searches matching `filesystem.deny_read`;
   - **recursive** reads/searches (e.g. `Grep` over a directory tree) whose root contains a `deny_read` *directory* — the whole access is denied with a hint to narrow the search root (file entries such as the built-in `.env` masks never trigger this);
   - writes matching `filesystem.deny_write`;
   - in `read-only` mode, writes outside the writable roots;
   - any access to a **sensitive file** (env files, SSH keys, cloud credentials — the same patterns the file tools already guard), which is upgraded from "ask" to a hard "deny" while the sandbox is enabled.
3. **Outside-workspace ask** — file-tool accesses (read/write/search) outside the writable roots ask for approval instead of passing silently.

## Known limitations

- Only `Bash` is wrapped by the OS sandbox. External hooks run unsandboxed (same as claude-code), and the `Grep` tool's `rg` subprocess is not sandboxed separately — its search roots are already guarded by the workspace path checks plus the policies above.
- On Linux, `deny_read` masks only paths that exist when the command starts (bubblewrap cannot mount over a non-existent path).
- The sandbox masks the known host socket paths listed above but cannot block creating new `AF_UNIX` sockets (no seccomp filter); it also cannot stop a sandboxed process from talking to daemons over unnamed or relocated sockets.
- `network.allowed_domains` and `network.allow_unix_sockets` are reserved schema fields with no behavior yet (Phase 3).
- Windows is not supported; commands run unsandboxed there.

## Next steps

- [Configuration files](./config-files.md) — complete reference for all configurable fields
- [Config overrides](./overrides.md) — how config files, command-line options, and environment variables interact
