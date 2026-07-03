---
name: gen-changesets
description: Use when generating changesets in the kimi-code repository, including package bump selection, internal package and CLI bundle handling, bump levels, major confirmation, and English changelog wording.
---

# Generate Changesets

`kimi-code` uses changesets to manage versions and changelogs. The current user-facing published package is:

- `@moonshot-ai/kimi-code`: the CLI

All other `@moonshot-ai/*` packages are treated as internal packages, including `@moonshot-ai/kimi-code-sdk`, `agent-core`, `kosong`, `kaos`, `kimi-code-oauth`, `kimi-telemetry`, and `migration-legacy`.

`@moonshot-ai/pi-tui` is a special internal package: it is a private fork (`private: true`) that is never published, but it keeps its own changelog through changesets. It is an exception to Core Rule 4 — see the dedicated section below.

## Core Rules

1. **Inspect the actual changes first.** Use `git status` / `git diff --name-only` to identify which packages were actually changed.
2. **List packages that changesets can release.** If a changed package is ignored in `.changeset/config.json`, do not put that ignored package in frontmatter together with a non-ignored package; changesets rejects mixed ignored/non-ignored frontmatter.
3. **Map ignored internal changes to the affected released package.** If an ignored internal package changes CLI output or behavior, list `@moonshot-ai/kimi-code` and describe the actual user-visible or release-artifact change in the changelog text.
4. **Internal package source changes that enter the CLI bundle must manually list the CLI.** `@moonshot-ai/kimi-code` inline-bundles `@moonshot-ai/*` source, but those internal packages are devDependencies from the CLI's perspective, so changesets will not automatically propagate bumps. If a change enters the CLI output, list `@moonshot-ai/kimi-code`.
   - **Web app (`@moonshot-ai/kimi-web`) changes always enter the CLI bundle.** `@moonshot-ai/kimi-web` is ignored by changesets (see `.changeset/config.json`) and cannot be mixed with `@moonshot-ai/kimi-code` in one changeset frontmatter. Describe the web change in the changelog text, but list `@moonshot-ai/kimi-code` so the CLI release carries the bundled `dist-web` output.
5. **Docs-only and tests-only changes usually do not need a changeset.** README, internal docs, and `test/` changes that do not enter package output do not trigger a CLI bump.
6. `@moonshot-ai/vis` / `vis-server` / `vis-web` are ignored by changesets and should not be handled.

## Workflow

1. List the changed packages and check whether each one is ignored by `.changeset/config.json`.
2. Choose a bump level for each package.
3. If an ignored internal package change enters the CLI bundle, put `@moonshot-ai/kimi-code` in frontmatter instead of mixing the ignored package into the same changeset.
4. Create a short kebab-case file under `.changeset/`.
5. Split unrelated changes into separate changesets; keep one logical change in one file.

Format:

```markdown
---
"<package A>": patch
"<package B>": minor
---

<English changelog entry>
```

## Bump Levels

| Level | When to use |
|---|---|
| `patch` | Bug fixes; build/package fixes; internal refactors that do not change behavior; wording tweaks; small dependency upgrades; small improvements to existing features with limited user-facing impact (e.g. a new keyboard shortcut, a flag alias, a minor UX tweak) |
| `minor` | A substantial new user-facing feature, such as a new slash command, a new built-in tool, or a new mode |
| `major` | Breaking changes: incompatible config changes, renamed or removed commands/arguments, behavior semantics changes, and similar |

When in doubt between `patch` and `minor`: if the change improves an existing feature and the user-facing impact is small, choose `patch` even when the change is technically "new". Reserve `minor` for a substantial new capability that introduces something users could not do before.

### Major Rule

Never write `major` on your own.

If you believe a change qualifies as major, stop first, explain why, and ask the user for confirmation. Only write `major` after the user explicitly agrees. If the user does not reply, replies ambiguously, or disagrees, fall back to `minor`; if `minor` is also unclear, fall back to `patch`.

## Wording Rules

- Changelog entries **must be written in English**.
- **Keep the whole entry concise.** Aim for one short sentence that states what was done; at most a short sentence plus a one-line usage hint. Do not write a paragraph, do not pile on technical detail, and do not enumerate every sub-change.
- **For new user-facing features, append a brief usage hint** so users know how to try it. Keep it to a single short line — a command name, a subcommand, a flag, or a one-line "how to use". Do not explain design rationale or list edge cases. Skip the hint for bug fixes, internal changes, and refactors.
  - Slash command: `Add the /foo slash command to list active sessions. Run /foo to see them.`
  - CLI subcommand: `Add the kimi web subcommand to open the web UI. Run kimi web to launch it.`
  - Flag: `Add a --bar flag to skip confirmation prompts. Pass --bar to skip.`
  - Too long: `Add the /foo command to list active sessions. It accepts an optional --all flag to include background sessions, supports filtering by name with /foo <name>, and writes the result to the transcript...`
- User-facing CLI wording should only be used when CLI users can perceive the change.
- Internal changes that do not affect CLI users can still share a changeset with the CLI, but the wording must describe the real change honestly and must not present it as a user-facing feature.
- Do not mention file names, class names, function names, PR numbers, or commit hashes.
- Do not include real internal endpoints, key names, account names, or service names. If an example is needed, use neutral placeholders such as `example.com`, `example.test`, or `YOUR_API_KEY`.
- Avoid vague words such as `refactor`, `optimize`, and `improve`. Describe the actual change, or use more specific wording.

## When You Are Unsure About a Change

Generate the changeset from what the diff clearly shows. If part of a change is unclear and you cannot confidently describe what it does for users, do not guess or pad the entry with vague wording.

1. Finish the changeset for the parts that are clear.
2. Then ask the user once, in a short list: name the specific change(s) you do not understand, and ask whether you may dig into the repository (read related source, tests, or call sites) to describe it more accurately.
3. Only read more code after the user agrees. If the user says no or does not reply, keep the concise wording you already have and do not invent detail.

## Common Examples

An internal package fixes a bug visible to CLI users:

```markdown
---
"@moonshot-ai/kimi-code": patch
---

Fix occasional loss of tool call results in long conversations.
```

A new user-facing slash command (note the short usage hint):

```markdown
---
"@moonshot-ai/kimi-code": minor
---

Add the /foo slash command to list active sessions. Run /foo to see them.
```

A new CLI subcommand:

```markdown
---
"@moonshot-ai/kimi-code": minor
---

Add the kimi web subcommand to open the web UI. Run kimi web to launch it.
```

A new flag on an existing command:

```markdown
---
"@moonshot-ai/kimi-code": patch
---

Add a --bar flag to skip confirmation prompts. Pass --bar to skip.
```

An internal package has an internal-only change, but it enters the CLI bundle:

```markdown
---
"@moonshot-ai/kimi-code": patch
---

Unify tool execution metadata handling.
```

Only SDK source changed, and the CLI does not use it:

```markdown
---
"@moonshot-ai/kimi-code-sdk": patch
---

Clarify session status typing for internal SDK callers.
```

## Web app changes

`@moonshot-ai/kimi-web` is ignored by changesets and must **never** appear in a changeset frontmatter. Because the web app is bundled into the CLI release artifact, any web change that ships must list `@moonshot-ai/kimi-code` instead and describe the actual web-facing change in the text.

- If a PR contains both web UI changes and server API changes, split them into separate changesets so each entry has a focused description.
- Do not enumerate every micro-tweak; keep it to one sentence that captures what the web user gets.

Web-only fix:

```markdown
---
"@moonshot-ai/kimi-code": patch
---

Fix the web chat not scrolling to the bottom after sending a message.
```

Web UI plus server APIs in the same PR (split into two changesets):

```markdown
---
"@moonshot-ai/kimi-code": minor
---

Add the server-hosted web UI, including chat layout and session list behaviors.
```

```markdown
---
"@moonshot-ai/kimi-code": minor
---

Add the server REST and WebSocket APIs that power the web UI.
```

## `@moonshot-ai/pi-tui` changes

`@moonshot-ai/pi-tui` is a vendored fork that lives in `packages/pi-tui`. It is `private: true` and is never published, but it is **not** ignored by changesets: changesets versions it and writes `packages/pi-tui/CHANGELOG.md` so the fork keeps its own history. Because it is bundled into the CLI like other internal packages, it is an exception to Core Rule 4 — do **not** list `@moonshot-ai/kimi-code` for a change that only touches pi-tui.

- Changes that only affect pi-tui (build, package, strict-mode cleanup, renderer fixes): list `@moonshot-ai/pi-tui` only. No CLI changeset.
- If the same change is also user-visible in the CLI (for example a terminal rendering fix that CLI users can see), add a **separate** changeset that lists `@moonshot-ai/kimi-code` with CLI-focused wording, in addition to the pi-tui changeset. Do not mix both packages in one frontmatter — the two changelogs need different wording.

pi-tui-only change:

```markdown
---
"@moonshot-ai/pi-tui": patch
---

Export the package manifest so the bundled binary can locate its native assets.
```

pi-tui change that is also visible in the CLI (two separate changesets):

```markdown
---
"@moonshot-ai/pi-tui": patch
---

Clamp the differential render to the visible viewport so scrolling up during streaming no longer jumps to the top.
```

```markdown
---
"@moonshot-ai/kimi-code": patch
---

Fix the transcript jumping to the top when scrolling up through history during streaming output.
```

## Red Flags

- You are about to write `major` without asking the user.
- A new user-facing feature entry has no usage hint, or the hint runs to multiple lines and explains design rationale.
- You guessed wording for a change you do not understand instead of asking the user whether you may dig into the repo.
- Internal package source enters the CLI bundle, but `@moonshot-ai/kimi-code` is missing.
- A changeset frontmatter mixes ignored internal packages with non-ignored packages.
- `packages/node-sdk` was not changed, but `@moonshot-ai/kimi-code-sdk` was listed for "internal package sync".
- The changelog entry is in Chinese.
- The wording claims more than the diff actually did.
- The CLI wording mentions internal package names, class names, or PR numbers.
- The entry includes real internal identifiers instead of neutral placeholders.
- A change that only touches `@moonshot-ai/pi-tui` lists `@moonshot-ai/kimi-code` instead of `@moonshot-ai/pi-tui`, or mixes both packages in one frontmatter.
