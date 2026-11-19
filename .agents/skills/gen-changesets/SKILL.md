---
name: gen-changesets
description: Use when generating changesets in the kimi-code repository — deciding whether to write one, which package to list, the bump level, the wording, and the confirmation workflow.
---

# Generate Changesets

## Products And Libraries

Three user-facing products live under `apps/`. Every workspace package under `packages/` is a dependency library.

| Product | Package | Path | Ships via |
|---|---|---|---|
| CLI | `@moonshot-ai/kimi-code` | `apps/kimi-code` | npm + GitHub Release |
| Desktop | `kimi-code-app` | `apps/desktop` | GitHub Release + CDN |
| VS Code extension | `kimi-code` | `apps/vscode` | VS Marketplace + Open VSX |

Product changesets are user-facing changelog entries (they feed release notes, update dialogs, and marketplace changelogs). Library changesets are technical entries for the library's own changelog.

## 1. Whether To Write

- **Changed a product's code and users can perceive it** → write for that product.
- **Changed a library's source code** → always write for that library, even for internal refactors; the library's own changelog is the honest record of what changed. Test-only and docs-only changes are exempt.
- **Changed public KAP (HTTP API) behavior that external callers can perceive** → write for the owning package (for example `kap-server`); hidden first-party endpoints (`hide: true`) are exempt.
- **A library change flows into a product and is user-perceivable there** → also write for the product, as a separate file with a user-facing sentence.
  - Changed `kap-server`'s session-list behavior → a `kap-server` entry; desktop embeds kap-server and users feel the change → a `kimi-code-app` entry too.
  - `agent-core-v2` internal refactor (wire / journal / lifecycle plumbing) → an `agent-core-v2` entry only.
- The packages ignored in `.changeset/config.json` (the `app-*` UI layers, `vite-preset`, the vis packages, and `kimi-inspect`) never appear in a changeset. Changes to the `app-*` UI layers are written as `kimi-code-app` product entries instead.
- When unsure whether users can perceive a change, ask first.

## 2. Which Package

- `apps/kimi-code/**` → `@moonshot-ai/kimi-code`
- `apps/desktop/**` → `kimi-code-app`
- `apps/vscode/**` → `kimi-code`
- `packages/<lib>/**` → `<lib>`, plus one entry per affected product when the change is user-perceivable there.

To judge whether a library change reaches a product, check its consumers (`pnpm why <pkg>`). Common flows: `kap-server` → CLI (`kimi web`) and desktop (embedded server); `agent-core` / `pi-tui` → CLI; `oauth` → all three products.

One PR may carry several changesets — a library plus affected products, or several products changed at once. Never mix packages ignored in the config with non-ignored packages in one frontmatter.

## 3. Bump Level

- `patch`: bug fixes, small improvements — when in doubt, use this.
- `minor`: a real new capability users could not do before (a new slash command, a new mode, a new settings surface).
- `major`: **never write it.** If you think a change qualifies, stop and ask the user; without explicit approval fall back to `minor`, or to `patch` if `minor` is also unclear.
- A product entry written because of a library change takes its level from the user-perceivable impact (usually `patch`).

## 4. Wording

- **Product entries**: one short, user-facing English sentence that states only what changed. Drop trailing clauses that explain the cause, the benefit, or the mechanism. New features: say plainly what it is plus one line on how to use it, e.g. `Add the /foo slash command to list active sessions. Run /foo to see them.` Experimental features: also state how to enable them (the flag, config key, or env var).
- **Library entries**: honest, technical descriptions for the library's own changelog.
- No file, class, or function names, and no PR numbers. No vague words like refactor, optimize, or improve. No real internal identifiers — use neutral placeholders such as `example.com` or `YOUR_API_KEY`.
- One logical change per changeset; split unrelated changes into separate files.

## 5. Workflow

1. Run `git status` / `git diff --name-only` to see which packages actually changed.
2. Apply section 1; if no changeset is needed, stop.
3. Pick the package(s) and bump level(s), and write the sentence(s).
4. **Show the changeset text to whoever requested the work and get their confirmation before committing.**
