# Remote environments

Remote environments let Kimi Code operate another machine or container.

## How remote environments work

Kimi Code CLI still runs on your computer and hands only file reads, file writes, and command execution to the target environment. The target environment also needs Kimi Code CLI installed to carry them out.

## Quick start

This example uses `dev-box`, a machine you can already sign in to over SSH.

1. Install Kimi Code CLI on the target machine:

   ```sh
   ssh dev-box 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash'
   ```

2. Add the following to `~/.kimi-code/config.toml` on your machine:

   ```toml
   [environments.dev-box]
   type = "ssh"
   host = "dev-box"
   defaultCwd = "/home/me/projects"
   ```

3. Start a session:

   ```sh
   kimi --environment dev-box
   ```

   Once the session opens, the footer shows `dev-box` before the working directory. From then on, the files the agent reads and writes and the commands it runs are on `dev-box`.

To start every new session on `dev-box` by default, see [Setting a default environment](#setting-a-default-environment); for Docker containers and other connection methods, see [Declaring environments](#declaring-environments).

## Declaring environments

Declare environments under `[environments]` in `config.toml`. Before connecting, [install Kimi Code CLI](./getting-started.md#install-script-recommended) on the target environment.

### SSH hosts

```toml
[environments.dev-box]
type = "ssh"
host = "dev-box"
defaultCwd = "/home/me/projects"
```

`host` is resolved by the system `ssh`, so the user, port, key, and jump hosts in `~/.ssh/config` apply as usual; see [SSH authentication](#ssh-authentication). `defaultCwd` is the session's working directory on the target. It must be an absolute path on the target machine; relative paths and `~` are not supported.

### Docker containers

```toml
[environments.dev-container]
type = "docker"
container = "myapp-dev"
defaultCwd = "/workspace"
```

`container` is the name or id of a running container; Kimi Code enters it with `docker exec`. If you use a non-default Docker context such as OrbStack, add `context = "orbstack"`.

### Other environments

Use `command` and `args` to configure other environments, such as `kubectl exec`, WSL, Apple Container, or managed sandboxes:

```toml
[environments.k8s-pod]
command = "kubectl"
args = ["exec", "-i", "my-pod", "--"]
remoteBin = "/root/.kimi-code/bin/kimi"
defaultCwd = "/app"

[environments.wsl]
command = 'C:\Program Files\WSL\wsl.exe'
args = ["--exec"]
remoteBin = "/home/me/.kimi-code/bin/kimi"
defaultCwd = "/home/me/projects"
```

- Commands such as `kubectl exec` and `wsl --exec` pass arguments through without a shell, so `~` is not expanded. Set `remoteBin` to the absolute path of Kimi Code on the target.
- Wrap Windows paths that contain backslashes in single quotes so TOML does not treat `\` as an escape.
- Credentials the launcher command needs can go in `env`, for example `env = { SANDBOX_TOKEN = "..." }`. These variables are given only to the launcher command on your machine and are not passed to commands the agent runs on the target.

### Setting a default environment

```toml
[environments]
default = "dev-box"
```

With a default set, new sessions start directly on that environment. The default entry must set `defaultCwd`.
In the TUI, `/new` keeps the current session's environment and working directory.

### Windows target environments

Windows targets need [Git for Windows](https://gitforwindows.org/) installed (the `Bash` tool runs through Git Bash).

Use a drive path such as `C:\work\project` for `defaultCwd`:

```toml
[environments.windows-dev]
type = "ssh"
host = "windows-dev"
defaultCwd = 'C:\work\project'
```

## Picking an environment for one launch

Pass `--environment` at startup to choose the new session's environment, and `--environment-cwd` to override its working directory.

```sh
kimi --environment dev-box --environment-cwd /home/me/projects -p "Run the test suite"
```

Only Kimi Code CLI can pick an environment for one launch. Sessions created from other clients such as the Web UI use the [default environment](#setting-a-default-environment), and run on your machine when no default is set.

## SSH authentication

Kimi Code connects to SSH hosts non-interactively. If the following command succeeds in your terminal, Kimi Code can connect:

```sh
ssh -o BatchMode=yes dev-box true
```

- **Keys**: keys, ssh-agent, and jump hosts in `~/.ssh/config` work as usual. For a key with a passphrase, run `ssh-add` once in your terminal first.
- **Passwords**: in the TUI, Kimi Code CLI prompts for the SSH password (requires OpenSSH 8.4 or later). `kimi -p` does not support password sign-in.
- **Host keys**: a new host's key is trusted and written to `known_hosts` on first connection; if the host key later changes, the connection fails and you need to remove the matching entry from `known_hosts` manually.

## Things to know

- **Resuming a session reconnects to its environment**: if the environment has been removed or cannot be reached, resuming fails.
- **Changing an environment's configuration disconnects it**: commands running on the target environment are terminated, and the next use connects with the new settings.
- **An outdated Kimi Code CLI on the target environment cannot connect**: run the install command again on the target environment to upgrade.
- **Hooks and MCP servers run on your machine by default**: they cannot see files on the target environment; stdio MCP servers can run on the target environment through `environment_id`, see [MCP](../customization/mcp.md).
- **Web tools run on your machine**: `WebSearch` and `FetchURL` reach the network your computer is on.
- **File paths in prompts resolve on the target environment**: `/tmp/x.png` refers to a file on the target environment; paste local images directly instead.
- **Tower mode is not supported**.

## Next steps

- [`environments` configuration reference](../configuration/config-files.md#environments) — every field in the `[environments]` section
- [Remote control](./remote-control.md) — the opposite direction: control sessions on your machine from another device
