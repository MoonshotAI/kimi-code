# Remote environments

A remote environment lets the Agent read and write files and run Shell commands on another machine or in a container, while Kimi Code CLI, model requests, credentials, and session state stay on your machine.

## Use a remote environment over SSH

### 1. Prepare the remote machine

- Install the Kimi Code executor for the target platform at `~/.kimi-code/bin/kimi`.
- Make sure your machine can sign in to the remote machine with SSH keys.
- Configure users, ports, keys, and jump hosts in `~/.ssh/config` if needed.

Kimi Code does not install the executor automatically. If it is missing or incompatible, install or update to the build provided for the target platform.

### 2. Declare the environment in `config.toml` on your machine

```toml
[environments.dev-box]
type = "ssh"
host = "dev-box"
defaultCwd = "/home/me/projects"
```

If the executor is outside the default path, add:

```toml
remoteBin = "/path/to/kimi"
```

### 3. Create a remote session

```sh
kimi --environment dev-box
```

To use a different remote directory for one session:

```sh
kimi --environment dev-box --environment-cwd /home/me/another-project
```

Resuming a session automatically restores its remote environment and working directory. You do not need to repeat these flags.

After setup:

- File operations and Shell commands run on the remote machine.
- The CLI, model requests, and credentials stay on your machine.
- Subagents inherit their parent Agent's remote environment.

#### `kimi --environment` and `--environment-cwd`

- Both flags are creation-only and cannot be combined with `--session` or `--continue`.
- `--environment-cwd` must be used with `--environment`.
- A later `/new` keeps the current environment instead of applying the startup flags again.

## SSH authentication

Prepare authentication once in your own terminal:

- For a password-only host, run `ssh-copy-id user@host` and use key authentication afterwards.
- For a passphrase-protected key, run `ssh-add` so ssh-agent holds the unlocked key.
- For jump hosts or connection sharing, configure `ProxyJump` or `ControlMaster` in `~/.ssh/config`.

Connection behavior:

- The first connection to a new host records its host key. A later key change fails the connection until you fix the entry.
- The interactive CLI can prompt for an SSH password when the server supports it. The password stays only in the current process memory.
- Password prompts require OpenSSH 8.4 or later. Independent OTP/MFA and private-key passphrase prompts are not supported.
- Non-interactive clients such as `kimi -p` do not prompt for passwords. Configure keys or connection sharing in advance.

## Declare Docker and custom-command environments

Besides SSH, you can declare a Docker-compatible container or a custom launcher command.

Docker example:

```toml
[environments.dev-container]
type = "docker"
container = "myapp-dev"
defaultCwd = "/workspace"
```

Custom command example:

```toml
[environments.sandbox]
command = "sandbox"
args = ["ssh", "i-1234567890", "--"]
defaultCwd = "/home/me/kimi-code"
```

Common rules:

- `defaultCwd` must be an absolute path on the target environment.
- `type` and `command` are mutually exclusive within one entry.
- Optional `[environments] default = "dev-box"` sets the default environment for new sessions.
- After you change how an environment starts, the next use reconnects with the new configuration and running remote commands stop.

See the [`environments` configuration reference](../configuration/config-files.md#environments) for all fields.

## Windows targets

When the remote target is a Windows machine:

- Install [Git for Windows](https://gitforwindows.org/) and the Windows executor on the target.
- The default executor path is `~/.kimi-code/bin/kimi.exe`.
- Use a native drive path such as `C:\work\project` for `defaultCwd`.
- SSH and custom commands are supported; Docker containers are not.

```toml
[environments.windows-dev]
type = "ssh"
host = "windows-dev"
remoteBin = "kimi"
defaultCwd = 'C:\work\project'
```

## Disconnects and reconnecting

- The next tool call tries to reconnect.
- There is no silent fallback to your machine, so a remote command cannot accidentally run locally.
- A call already running during a disconnect fails and is not retried automatically.
- If the target stays unreachable, tool calls report an error. Check the network, SSH, and executor first.

## Limitations

- `WebSearch` and `FetchURL` always run from your machine.
- Hooks and stdio MCP servers without `environment_id` run on your machine by default.
- Remote sessions do not load project-level Agent files from the target.
- Remote `AGENTS.md` and project Skills do not hot reload. They are read again when you create or resume a session, or run `/reload`.
- File paths in prompts resolve on the target. Local paths cannot be read directly, but pasted images are unaffected.
- Tower mode is unavailable in remote workspaces.

<details>
<summary>More limitations</summary>

- The `/feedback` codebase scanner is unavailable in remote workspaces.
- Listing a remote directory with more than 50,000 entries fails. Use a smaller subdirectory.
- Many small files can slow down remote session startup.
- The same root path on two hosts shares one workspace entry.
- Descendants left behind by an exited Windows leader may not be cleaned up automatically. Stop background tasks first.

</details>

## Next steps

- [`environments` configuration reference](../configuration/config-files.md#environments): view all fields.
- [Remote Control](./remote-control.md): steer this machine's sessions from another device.
