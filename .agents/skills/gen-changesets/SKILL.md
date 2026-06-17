---
name: gen-changesets
description: Use when generating changesets in the kimi-code repository, including package bump selection, internal package and CLI bundle handling, bump levels, major confirmation, and English changelog wording.
---

# Generate Changesets

`kimi-code` uses changesets to manage versions and changelogs. The current user-facing published package is:

- `@moonshot-ai/kimi-code`: the CLI

All other `@moonshot-ai/*` packages are treated as internal packages, including `@moonshot-ai/kimi-code-sdk`, `agent-core`, `kosong`, `kaos`, `kimi-code-oauth`, `kimi-telemetry`, and `migration-legacy`.

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
| `patch` | Bug fixes; build/package fixes; internal refactors that do not change behavior; wording tweaks; small dependency upgrades |
| `minor` | New backwards-compatible features or capabilities |
| `major` | Breaking changes: incompatible config changes, renamed or removed commands/arguments, behavior semantics changes, and similar |

### Major Rule

Never write `major` on your own.

If you believe a change qualifies as major, stop first, explain why, and ask the user for confirmation. Only write `major` after the user explicitly agrees. If the user does not reply, replies ambiguously, or disagrees, fall back to `minor`; if `minor` is also unclear, fall back to `patch`.

## Wording Rules

- Changelog entries **must be written in English**.
- **Keep it short — ideally a single sentence that states what was done.** Do not write a paragraph, do not pile on technical detail, and do not enumerate every sub-change.
- User-facing CLI wording should only be used when CLI users can perceive the change.
- Internal changes that do not affect CLI users can still share a changeset with the CLI, but the wording must describe the real change honestly and must not present it as a user-facing feature.
- Do not mention file names, class names, function names, PR numbers, or commit hashes.
- Do not include real internal endpoints, key names, account names, or service names. If an example is needed, use neutral placeholders such as `example.com`, `example.test`, or `YOUR_API_KEY`.
- Avoid vague words such as `refactor`, `optimize`, and `improve`. Describe the actual change, or use more specific wording.

## Common Examples

An internal package fixes a bug visible to CLI users:

```markdown
---
"@moonshot-ai/kimi-code": patch
---

Fix occasional loss of tool call results in long conversations.
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

## Red Flags

- You are about to write `major` without asking the user.
- Internal package source enters the CLI bundle, but `@moonshot-ai/kimi-code` is missing.
- A changeset frontmatter mixes ignored internal packages with non-ignored packages.
- `packages/node-sdk` was not changed, but `@moonshot-ai/kimi-code-sdk` was listed for "internal package sync".
- The changelog entry is in Chinese.
- The wording claims more than the diff actually did.
- The CLI wording mentions internal package names, class names, or PR numbers.
- The entry includes real internal identifiers instead of neutral placeholders.
