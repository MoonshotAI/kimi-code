---
name: kimi-code-docs
description: Use when the user asks about Kimi Code CLI itself, including setup, configuration, MCP, skills, plugins, slash commands, agents, hooks, sessions, IDE/ACP integration, login, updates, troubleshooting, or choosing the right Kimi Code surface.
whenToUse: The request is about Kimi Code as a product/runtime rather than about the user's project code. This includes how Kimi Code works, how to configure it, how to extend it, and how its documented commands or files should be used.
---

# Kimi Code Docs

Use this skill for Kimi Code product self-knowledge. The goal is to answer from Kimi Code's own docs or source, not from memory.

## Source route

1. For current user-facing product behavior, use the official Kimi Code docs first:
   - `https://moonshotai.github.io/kimi-code/en/`
   - `https://moonshotai.github.io/kimi-code/zh/`
2. If online docs are unavailable and the local repository has `docs/`, read the matching local docs page instead.
3. If docs and source disagree, say so and prefer source for current local behavior.
4. For implementation questions, inspect the owning source after locating the relevant product surface in the docs.
5. Do not invent pricing, rollout status, account entitlement, or undocumented model names.

## Product map

- Setup and first run: `guides/getting-started`
- Interactive usage: `guides/interaction`, `reference/slash-commands`, `reference/keyboard`
- Sessions and goals: `guides/sessions`, `guides/goals`
- Configuration: `configuration/config-files`, `configuration/providers`, `configuration/env-vars`, `configuration/data-locations`
- MCP: `customization/mcp`
- Skills: `customization/skills`, `reference/slash-commands#built-in-skill-commands`
- Plugins: `customization/plugins`
- Agents and hooks: `customization/agents`, `customization/hooks`
- IDE and ACP: `guides/ides`, `reference/kimi-acp`
- CLI flags and subcommands: `reference/kimi-command`

## Related built-in workflows

- Use `/update-config` for editing `config.toml` or `tui.toml`.
- Use `/mcp-config` for MCP server configuration and MCP OAuth login.
- Use `/custom-theme` for custom TUI theme files.
- Use `/import-from-cc-codex` for importing selected Claude Code or Codex assets.

## Boundaries

- Do not treat generic Moonshot or Open Platform API questions as Kimi Code CLI questions unless the user is configuring Kimi Code providers.
- For Kimi Code CLI or Kimi Code for VS Code, keep Kimi Code platform endpoints distinct from Open Platform endpoints.
- If a user asks how to change project behavior, prefer project instructions or project skills over this product-docs skill.
