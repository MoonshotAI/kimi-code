# @moonshot-ai/kimi-code

> The Starting Point for Next-Gen Agents

[![GitHub](https://img.shields.io/badge/github-AGSQ11/kimi--code-blue)](https://github.com/AGSQ11/kimi-code) [![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Docs](https://img.shields.io/badge/docs-online-blue)](https://moonshotai.github.io/kimi-code/en/)

## What is Kimi Code CLI

Kimi Code CLI is an AI coding agent that runs in your terminal. It can read and edit code, run shell commands, search files, fetch web pages, and choose the next step based on the feedback it receives. It works out of the box with Moonshot AI's Kimi models and can also be configured to use other compatible providers.

## Install

This fork is installed from source. Requires **Node.js ≥ 24.15.0** and **pnpm 10.33.0**.

```sh
git clone https://github.com/AGSQ11/kimi-code.git
cd kimi-code
pnpm install
pnpm --filter @moonshot-ai/kimi-code build
```

> On Windows, install [Git for Windows](https://gitforwindows.org/) before first launch because Kimi Code CLI uses the bundled Git Bash as its shell environment. If Git Bash is installed in a custom location, set `KIMI_SHELL_PATH` to the absolute path of `bash.exe`.

Run the CLI from the repo root:

```sh
pnpm --filter @moonshot-ai/kimi-code run dev:prod -- --version
```

For convenience, add an alias to your shell (example for `.bashrc` / `.zshrc`):

```sh
alias kimi='pnpm --filter @moonshot-ai/kimi-code run dev:prod --'
```

## Quick Start

Open a project and start the interactive UI:

```sh
cd your-project
pnpm --filter @moonshot-ai/kimi-code run dev:prod
```

On first launch, run `/login` inside Kimi Code CLI and choose either Kimi Code OAuth or a Moonshot Platform API key. After login, try a first task:

```
Take a look at this project and explain the main directories.
```

## Key Features

- **Source install.** Clone and build from the GitHub fork, ideal for customization and staying current with fork updates.
- **Blazing-fast startup.** The TUI is ready in milliseconds, so opening a session never feels heavy.
- **Polished TUI.** A carefully tuned interface designed for long, focused agent sessions.
- **Video input.** Drop a screen recording or demo clip into the chat — let the agent watch instead of typing out what's hard to describe in words.
- **AI-native MCP configuration.** Add, edit, and authenticate Model Context Protocol servers conversationally via `/mcp-config` — no hand-editing JSON.
- **Subagents for focused, parallel work.** Dispatch built-in `coder`, `explore`, `plan`, and `critic` subagents in isolated context windows; the main conversation stays clean.
- **Lifecycle hooks.** Run local commands at key points — gate risky tool calls, audit decisions, fire desktop notifications, wire into your own automation.

## Documentation

- Full docs: https://moonshotai.github.io/kimi-code/en/
- 中文文档: https://moonshotai.github.io/kimi-code/zh/
- Getting Started: https://moonshotai.github.io/kimi-code/en/guides/getting-started

## Repository & Issues

- Source: https://github.com/AGSQ11/kimi-code
- Issues: https://github.com/AGSQ11/kimi-code/issues
- Security: see SECURITY.md in the main repository

## License

MIT
