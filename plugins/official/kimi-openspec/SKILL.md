# kimi-openspec

Official OpenSpec plugin for Kimi Code — enables spec-driven development (SDD) workflows.

## Overview

This plugin integrates [OpenSpec](https://github.com/Fission-AI/OpenSpec) into Kimi Code, allowing AI assistants to manage structured change proposals, specifications, and tasks before writing code.

## What is OpenSpec?

OpenSpec is a lightweight, open-source spec-driven development framework that helps AI coding assistants follow instructions more effectively. It works with 30+ tools including Kimi Code, Claude Code, Cursor, GitHub Copilot, and more.

### Core Workflow

```
/opsx:new → /opsx:continue → /opsx:apply → /opsx:verify → /opsx:archive
```

### Key Concepts

- **Proposals** — Structured change requests with technical designs
- **Specifications** — Living documentation that captures functional requirements
- **Task Checklists** — Implementation tasks with AI guidance
- **Archives** — Completed changes preserved for reference

## Installation

This plugin is bundled with Kimi Code as an official plugin. To enable it:

```bash
kimi plugin install kimi-openspec
```

Or add it to your Kimi Code configuration.

## Prerequisites

- Node.js 18+ (for running `npx`)
- The plugin automatically installs `@fission-ai/openspec` via `npx --yes`

## Tools

### `openspec_init`

Initialize OpenSpec in your project.

**Parameters:**
- `tools` (string, optional): AI tools to configure. Default: `"claude"`. Options: `"all"`, `"none"`, or comma-separated list (e.g. `"claude,cursor,codex"`).
- `force` (boolean, optional): Auto-cleanup legacy files without prompting.

### `openspec_new_change`

Create a new change directory with proposal, design, tasks, and spec scaffolding.

**Parameters:**
- `name` (string, required): Name of the change (kebab-case recommended).
- `description` (string, optional): Description to add to README.md.

### `openspec_list`

List all OpenSpec changes or specs.

**Parameters:**
- `specs` (boolean, optional): List specs instead of changes.

### `openspec_show`

Show details of a specific change or spec.

**Parameters:**
- `itemName` (string, required): Name of the item to show.
- `type` (string, optional): Item type — `"change"` or `"spec"`.

### `openspec_status`

Display artifact completion status for a change.

**Parameters:**
- `changeName` (string, required): Change name to show status for.

### `openspec_validate`

Validate a change proposal or spec.

**Parameters:**
- `itemName` (string, optional): Name of the change to validate.
- `all` (boolean, optional): Validate all changes and specs.
- `strict` (boolean, optional): Enable strict validation mode.

### `openspec_archive`

Archive a completed change and merge its spec updates back into the main specs directory.

**Parameters:**
- `changeName` (string, required): Name of the change to archive.
- `skipSpecs` (boolean, optional): Skip spec updates during archive.

### `openspec_update`

Update OpenSpec instruction files to the latest version.

### `openspec_instructions`

Output enriched instructions for an artifact or apply phase.

**Parameters:**
- `artifact` (string, required): Artifact name (e.g. `"design.md"`, `"tasks.md"`) or `"apply"`.
- `changeName` (string, optional): Change name.

### `openspec_read_file`

Read any OpenSpec artifact directly by file type. Much faster than `show` — use this when you need file contents.

**Parameters:**
- `name` (string, required): Change or spec name.
- `fileType` (string, required): File to read. Options: `proposal.md`, `design.md`, `tasks.md`, `spec.md`, `review.md`, `plan.md`, `.openspec.yaml`.
- `type` (string, optional): Item type — `"change"` or `"spec"`. If omitted, prefers changes.

### `openspec_refresh_cache`

Force refresh the cached directory listing. Use if changes were made outside OpenSpec tools.

## Prompts

### `openspec_kickoff`

A pre-built prompt that steers the AI into a strict spec-driven workflow from the first turn. Automatically injected when supported by the AI assistant.

## Usage Example

```
User: I want to add a dark mode feature to this application.
AI: I'll help you add a dark mode feature using OpenSpec for structured planning.

[AI uses openspec_init if not already initialized]
[AI uses openspec_new_change to create "add-dark-mode" change]
[AI uses openspec_read_file to review proposal.md and tasks.md]
[AI implements tasks sequentially]
[AI uses openspec_validate to verify]
[AI uses openspec_archive when complete]
```

## Architecture

This plugin is an MCP (Model Context Protocol) server that:

1. Wraps the `@fission-ai/openspec` CLI commands
2. Maintains an in-memory cache of `openspec/changes/` and `openspec/specs/` directories for fast listing
3. Provides direct file reading via `openspec_read_file` to bypass CLI subprocess overhead
4. Exposes a built-in `openspec_kickoff` prompt for spec-driven workflow initialization

## Cache

The plugin maintains an in-memory cache of the OpenSpec directory structure:
- Cache is built on server startup
- Cache is refreshed after any mutating operation (`init`, `new_change`, `archive`, `update`)
- Manual refresh available via `openspec_refresh_cache`

## Error Handling

- If OpenSpec CLI is not installed, the plugin will attempt to install it automatically via `npx --yes`
- If the project is not initialized, list operations will suggest running `openspec_init`
- File read operations return clear error messages with available files list

## License

MIT — see LICENSE file.
