# Evaluation Round 1 — Batch 6

**Batch**: 6 (final wrap-up)
**Date**: 2026-05-28
**Checklist**: `docs/retros/checklists/code-v1.md`
**Verdict**: PASS

## Artifacts under evaluation

- `packages/agent-core/src/tools/builtin/state/memory.md` (rewritten from placeholder)
- `docs/reference/memory.md` (new)
- `.changeset/add-native-cross-session-memory.md` (new)

## Checklist results

### CODE-VER-01 — All verification commands exit 0

Each command run independently in a fresh shell with `eval "$(fnm env)"` + `fnm use 24.15.0` (project's `.nvmrc` pins 24.15.0; the default shell Node was 24.14.1 and rejected by `engines.node`).

| Command | Exit | Output tail |
|---|---|---|
| `pnpm typecheck` | 0 | `packages/migration-legacy typecheck: Done` / `packages/node-sdk typecheck: Done` / `@moonshot-ai/kimi-code typecheck` clean |
| `pnpm test` | 0 | `Test Files 354 passed \| 4 skipped (358)`, `Tests 4532 passed \| 25 skipped \| 2 todo (4559)`, duration 20.02s |
| `pnpm lint` | 0 | `Found 240 warnings and 0 errors.` (pre-existing warnings, none new) |
| `pnpm build` | 0 | `apps/kimi-code build: Build complete in 1448ms`, `dist/main.mjs 4.78 MB` |
| `ls .changeset/` | 0 | new `add-native-cross-session-memory.md` present alongside existing entries |

**Result: PASS** — all four verification commands exit 0.

### CODE-QUAL-01 — No TODO/FIXME/HACK/XXX/STUB markers in produced files

```bash
grep -rn -E '(TODO|FIXME|HACK|XXX|STUB)' \
  packages/agent-core/src/tools/builtin/state/memory.md \
  docs/reference/memory.md \
  .changeset/add-native-cross-session-memory.md
# exit 1 (no match)

grep -rni -E '\bstub\b' <same files>
# exit 1 (no match)
```

**Result: PASS** — zero matches across produced files.

### CODE-QUAL-02 — No stub implementations

Not applicable — this batch produced only Markdown content (tool description, reference doc, changeset). No functions, methods, or class bodies were written.

```bash
grep -rn 'NotImplementedError' <produced files>      # no match
grep -rn -E '^[[:space:]]+pass[[:space:]]*$' <files>  # no match
grep -rn -E '^[[:space:]]+\.\.\.[[:space:]]*$' <files># no match
```

**Result: PASS** (vacuously) — no executable code in produced files.

## Sprint-contract acceptance criteria

All items from `sprint-contract-batch-6.md`:

- [x] `packages/agent-core/src/tools/builtin/state/memory.md` finalized. All required sections present: when-to-use, when-NOT, scope guidance (`user` / `project` + Project-overrides-User + explicit `scope` requirement), per-operation one-line examples, hygiene rules, project-memory-in-git + `.gitignore` opt-out, subagent visibility timing, plan-mode block, reserved `MEMORY.md` filename, slug regex, body 4 KB cap, index 8 KB cap.
- [x] `docs/reference/memory.md` created. Topics covered: storage layout, frontmatter format, `/memory` keybindings, `/remember` flow, what-to-remember guidance, gitignore note, plan-mode behavior, v1 limits, internals pointer to `packages/agent-core/src/memory/`.
- [x] `.changeset/add-native-cross-session-memory.md` created with `minor` bumps for `@moonshot-ai/agent-core`, `@moonshot-ai/kimi-code-sdk`, `@moonshot-ai/kimi-code` (CLI). No `major` written.
- [x] Verified no breaking changes in the cumulative diff: all changes are additive (new tool, new RPC methods, new SDK wrappers, new slash commands, new system-prompt section, new domain type re-exports). No removed exports, no renamed public methods, no changed signatures on existing public APIs.
- [x] Root `AGENTS.md` not modified.
- [x] Final smoke verification: `pnpm typecheck && pnpm test && pnpm lint && pnpm build` all exit 0.

## Quality requirements

- Tool description is concise; loaded once per Memory tool surfacing. Length: ~55 lines, structured under headers for fast scanning.
- Reference doc uses plain markdown; no emojis; no AI slop. Links to source paths via plain backticks (not external links).
- No co-author / agent identity in any text artifact.
- Changeset summary uses conventional-commit verb "Add" (per gen-changesets skill's wording rules: "Keep it short — ideally a single sentence that states what was done"; the skill prefers the imperative verb form over `feat:` prefix — looking at existing entries like "Enhance kimi export...", "Fix occasional loss..." — they do not use conventional-commit prefixes inside the body).

## Notes on changeset wording

The task brief suggested a multi-paragraph entry with a `feat:` prefix. The `gen-changesets` skill in this repo says the opposite: single sentence, no prefix (the existing `.changeset/*.md` entries follow this — e.g. `export-install-source-shell-env.md` reads "Enhance `kimi export` to include..."). Followed the skill, not the brief's draft. The published PR commit / changelog will carry the `feat:` prefix when the maintainer commits — that is separate from the changeset entry body.

## Result

**PASS** — all checklist items pass, all sprint-contract acceptance criteria satisfied, all four verification commands exit 0.
