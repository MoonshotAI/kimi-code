---
name: gen-changesets
description: Use when generating changesets in the kimi-code repository — deciding whether to write one, which package to list, the bump level, the wording, and the confirmation workflow.
---

# Generate Changesets

## Products And Libraries

Three user-facing products live under `apps/`. Workspace packages under `packages/` are dependency libraries, except the private `packages/app-*` UI layers.

| Product | Package | Path | Ships via |
|---|---|---|---|
| CLI | `@moonshot-ai/kimi-code` | `apps/kimi-code` | npm + GitHub Release |
| Desktop | `kimi-code-app` | `apps/desktop` | GitHub Release + CDN |
| VS Code extension | `kimi-code` | `apps/vscode` | VS Marketplace + Open VSX |

`kimi web` is not a separate package: it serves the browser UI built from `apps/desktop/src/renderer` and `packages/app-*`, bundled inside `@moonshot-ai/kimi-code`. Web-facing entries therefore go on `@moonshot-ai/kimi-code`.

Product changesets are user-facing changelog entries (they feed release notes, update dialogs, and marketplace changelogs). Library changesets are technical entries for the library's own changelog.

## 1. Whether To Write

- **Changed a product's code and users can perceive it** → write for that product (see section 2 for desktop vs. `kimi web`).
- **Changed a library's source code** → always write for that library, even for internal refactors; the library's own changelog is the honest record of what changed. Test-only and docs-only changes are exempt. **Never write a library changeset for `packages/app-*`** — they are private UI layers bundled into the apps, not published libraries.
- **Changed public KAP (HTTP API) behavior that external callers can perceive** → write for the owning package (for example `kap-server`); hidden first-party endpoints (`hide: true`) are exempt.
- **A library change flows into a product and is user-perceivable there** → also write for the product, as a separate file with a user-facing sentence.
  - Changed `kap-server`'s session-list behavior → a `kap-server` entry; desktop embeds kap-server and users feel the change → a `kimi-code-app` entry too.
  - `agent-core-v2` internal refactor (wire / journal / lifecycle plumbing) → an `agent-core-v2` entry only.
- **Never write changesets for `packages/app-*` or packages ignored in `.changeset/config.json`**, even if an `app-*` package is missing from the `ignore` list. User-perceivable changes in `packages/app-*` are written as `kimi-code-app` product entries by default instead.
- When unsure whether users can perceive a change, ask first.

## 2. Which Package

- `apps/kimi-code/**` → `@moonshot-ai/kimi-code`
- `apps/desktop/**` → `kimi-code-app`
- `apps/vscode/**` → `kimi-code`
- `packages/app-*` → no package entry; write `kimi-code-app` when user-perceivable (subject to the desktop/web rule below).
- `packages/<lib>/**` (other libraries) → `<lib>`, plus one entry per affected product when the change is user-perceivable there.

### Desktop vs. `kimi web`

Desktop and `kimi web` share `apps/desktop/src/renderer` and `packages/app-*`, **but a desktop change does not automatically get a `kimi web` entry**. Do not mirror desktop entries onto `@moonshot-ai/kimi-code`:

- **Desktop-only** (`apps/desktop/src/main/**`, `apps/desktop/src/shared/**`, or `isDesktop` branches such as the updater, tray, native menus, window chrome, and screenshots) → `kimi-code-app` only. These never run in `kimi web`.
- **Shared UI and session behavior** (`apps/desktop/src/renderer/**`, `packages/app-*`, shared `kap-server` behavior) → `kimi-code-app` only by default, even though `kimi web` ships the same code.

Add a `@moonshot-ai/kimi-code` entry **only when the change specifically targets `kimi web`**, and name `kimi web` in the sentence:

- `kimi web` CLI flags, daemon lifecycle, token/host handling, or serving `dist-web`.
- Browser-only behavior: `!isDesktop` branches, web-only routes, browser APIs, CSP, or insecure/non-loopback browser contexts.
- If the change fixes both a web-specific path and desktop, write both entries; otherwise write only `@moonshot-ai/kimi-code`.

To judge whether a library change reaches a product, check its consumers (`pnpm why <pkg>`). Common flows: `kap-server` → CLI (`kimi web`) and desktop (embedded server); `agent-core` / `pi-tui` → CLI; `oauth` → all three products. When a flow reaches both desktop and `kimi web`, apply the desktop/web rule above instead of writing both product entries.

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
