# Getting started

## What is Kimi Code CLI

Kimi Code CLI is an AI agent that runs in the terminal, helping you carry out software development tasks and day-to-day terminal operations. It can read and edit code, run shell commands, search files, and fetch web pages, autonomously planning and adjusting the next step based on feedback as it works.

It fits scenarios such as:

- **Writing and modifying code**: implementing new features, fixing bugs, completing refactors
- **Understanding a project**: exploring an unfamiliar codebase and answering questions about architecture and implementation
- **Automating tasks**: batch-processing files, running builds and tests, chaining multiple scripts together

The entire CLI is written in TypeScript, distributed through npm, and runs on Node.js.

## Installation

### Install script (recommended)

The quickest way to install Kimi Code CLI is with the install script; no pre-installed Node.js is required:

- **macOS / Linux**:

```sh
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

- **Windows (PowerShell)**:

```powershell
irm https://code.kimi.com/kimi-code/install.ps1 | iex
```

This downloads the latest release, verifies the checksum, and places the `kimi` executable on your `PATH`.

### npm installation

If you prefer to install via npm, you need Node.js 24.15.0 or later:

```sh
node --version
```

The package name is `@moonshot-ai/kimi-code`:

```sh
npm install -g @moonshot-ai/kimi-code
```

Or with pnpm:

```sh
pnpm add -g @moonshot-ai/kimi-code
```

## System dependencies

Beyond Node.js, Kimi Code CLI uses a few external command-line tools. None of them block startup — the CLI degrades gracefully and tells you when one is missing. You can review their status any time with `/status`.

| Tool | Used for | If missing |
| --- | --- | --- |
| `ripgrep` (`rg`) | The `Grep` tool and file-content search | Auto-downloaded on first use. If `rg` is already on your `PATH`, that copy is used instead. |
| `fd` | Cross-directory fuzzy file search for `@` mentions | Optional. Inside a git repository, `git ls-files` still powers `@` completion; outside one, you get a startup warning. Install with `brew install fd` (macOS) or `sudo apt-get install fd-find` (Ubuntu). |
| Shell (Git Bash on Windows) | The `Bash` tool, which runs shell commands | On Windows the `Bash` tool runs through Git Bash. If it is not installed and `KIMI_SHELL_PATH` does not point to a `bash.exe`, the CLI still starts, but the `Bash` tool is omitted until a shell is available. Install [Git for Windows](https://gitforwindows.org/) to enable it. |

## Upgrade and uninstall

After installation, verify that the executable is ready:

```sh
kimi --version
```

**Upgrade**: run `kimi upgrade` to let the CLI check the latest version and show the update prompt:

```sh
kimi upgrade
```

Choose `Install update now` to upgrade through the detected installation source, or continue with the current version. If the current installation cannot be upgraded automatically, the command prints the manual command to run. You can also upgrade directly with your package manager. For npm:

```sh
npm install -g @moonshot-ai/kimi-code@latest
```

**Uninstall**: if you installed via the script, remove the `kimi` executable. If you installed via npm:

```sh
npm uninstall -g @moonshot-ai/kimi-code
```

## First launch

Move into the project directory you want to work in and simply run `kimi` to start the interactive UI:

```sh
cd your-project
kimi
```

If you only want to run a single instruction without entering the interactive UI, use the `-p` flag:

```sh
kimi -p "Take a look at this project's directory structure"
```

To resume the previous session, add the `-C` flag:

```sh
kimi -C
```

On the first launch, Kimi Code CLI has no credentials yet, and you need to configure an API source before you can start a conversation. In the interactive UI, enter the slash command `/login` to begin the login flow:

```
/login
```

`/login` opens a platform selector supporting:

- **Kimi Code (OAuth)** — device code flow; open the URL on any device, sign in, and enter the code to authorize
- **Kimi Platform API key** — enter an API key from `platform.kimi.com` or `platform.kimi.ai`

To sign out, enter `/logout` to clear the current credentials.

::: tip
If you want to use Anthropic, OpenAI, Google, or other providers, edit `config.toml` directly to configure the API key. See [Providers and models](../configuration/providers.md) for details. Runtime configuration such as the model and provider is also written to `config.toml`. See [Config files](../configuration/config-files.md), [Environment variables](../configuration/env-vars.md), and [Configuration overrides](../configuration/overrides.md) for details.
:::

## Your first conversation

Once login is complete, you can describe a task to Kimi Code CLI directly in natural language. For example, you can have it familiarize itself with the current project first:

```
Take a look at this project's directory structure and briefly describe what each directory is for.
```

Kimi Code CLI will automatically call file-reading, search, and web-fetching tools, browse the relevant content, and then give you an answer. Read-only operations such as reading files and searching the web are executed automatically by default without requiring confirmation. For operations that modify files or run shell commands, it asks for your confirmation before executing by default, and you can approve or reject as you see fit.

You can also have it do something more concrete, such as:

```
Add a function in src/utils that converts any string to kebab-case, and add a unit test for it.
```

Kimi Code CLI plans the steps, modifies the code, runs the tests, and tells you what it did at each step.

In the interactive UI, entering `/help` shows all available [slash commands](../reference/slash-commands.md) along with common keyboard shortcut hints. To exit Kimi Code CLI, enter `/exit`. You can also press `Ctrl-C` — the UI will first clear the current input and prompt you to press it again, and the second press exits. Or press `Ctrl-D` twice with the input box empty to exit.

## Where data is stored

Kimi Code CLI stores its local data under `~/.kimi-code/` by default, including config files, session records, logs, and the update cache. If you want to move it elsewhere, you can point to a new root directory via the `KIMI_CODE_HOME` environment variable. For the full directory layout and environment variable reference, see [Data locations](../configuration/data-locations.md) and [Environment variables](../configuration/env-vars.md).
