---
name: translate-docs
description: Translate and sync bilingual user documentation between docs/zh/ and docs/en/ following the source-of-truth rules in docs/AGENTS.md.
---

# Translate Docs

## Overview

This repository keeps bilingual user documentation under `docs/zh/` and `docs/en/`. This skill synchronizes the two locales, page by page, after either side has been updated.

This skill is invoked by both `gen-docs` (incremental updates) and `audit-docs` (full pre-release audit) to keep locale mirrors in sync.

## Prerequisites

If any of the following are missing, stop and report to the user before continuing:

- `docs/zh/` and `docs/en/` mirrored directory structure.
- `docs/AGENTS.md` — terminology table, typography rules, and source-of-truth rules.

## Locale sync rules

- **Changelog** (`release-notes/changelog.md`): English is the source. Translate to Chinese.
- **Breaking changes** (`release-notes/breaking-changes.md`): English is the source. Translate to Chinese.
- **All other pages**: `docs/en/` and `docs/zh/` are mirrored pairs. After either side changes, update the other locale in the same change.

When non-changelog pages change in either locale, sync the mirror before release. When the English changelog changes, sync the Chinese changelog.

## Workflow

1. **Detect what needs syncing**

   - `git diff main..HEAD --stat docs/` — see which files changed
   - For each changed file under `docs/en/` or `docs/zh/`, locate its mirror in the other locale (same relative path).

2. **Translate page by page, section by section**

   - Keep heading hierarchy, list structure, code blocks, callout blocks, and link targets identical between the two versions.
   - When in doubt about a technical term, **read the actual code** to confirm behavior rather than guessing.

3. **Apply terminology and typography rules from `docs/AGENTS.md`**

   - Use the term table exactly. Do not invent translations or use synonyms.
   - English H2+ uses sentence case (proper nouns excepted, per the term table).
   - Chinese typography: full-width punctuation (`，。；：？！（）`), space between Chinese and ASCII (letters / numbers / inline code / links).
   - Callout titles (`::: tip` / `::: warning` / `::: info` / `::: danger`) use the short Chinese labels from `docs/AGENTS.md`.

4. **Verify**

   - `git diff docs/` — scan for terminology drift or punctuation regressions.
   - Run the docs build if available (`pnpm --filter docs run build` or equivalent) to catch broken links and Markdown errors.

## Rules and conventions

- **Do not one-sided fixes**: if the changed locale has an unclear or incorrect statement, fix it there first; do not patch only the mirror.
- **Match style, not just words**: Chinese docs use a narrative tone (see `docs/AGENTS.md` writing-style examples); preserve that tone in Chinese; preserve sentence-case headings and concise English style in English.
- **Code blocks and identifiers stay as-is**: do not translate code, command names, flag names, or file paths.
- **Public examples**: Do not introduce real internal endpoints, key names, account names, or service names while translating. Keep or replace them with neutral placeholders such as `example.com`, `example.test`, and `YOUR_API_KEY` in both locales.

## Common mistakes

- Rewriting only the mirror because a phrase feels awkward in the target language — fix the changed locale first, then sync.
- Letting English headings slip into Title Case (only sentence case is allowed for H2+).
- Forgetting to add spaces between Chinese characters and inline code or English words.
- Translating proper nouns listed in the term table (`Wire`, `MCP`, `ACP`, `JSON`, `OAuth`, `macOS`, `uv`, etc.).
- Updating only one direction and leaving the other locale stale — always finish all pages flagged by the diff.
- Copying real internal values into the mirror instead of using neutral `example` placeholders.
