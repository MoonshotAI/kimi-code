# Merge request / pull request description

**Suggested title:** `fix(agent): isolate workspace baseline from trusted system prompt`

**Branch (placeholder):** `fix/system-prompt-baseline-isolation`  
**Target:** `main`  
**Do not open until:** linked issue exists and CONTRIBUTING workflow is followed.

Copy everything below the line into GitHub/GitLab when ready.

---

## Related Issue

Resolve #<!-- issue_number -->

<!-- Prefer opening the companion issue first; paste its URL/number here. -->

Design reference (branch-local): `docs/design/system-prompt-baseline-isolation.md`  
Issue draft: `docs/design/issue-system-prompt-baseline-isolation.md`

## Problem

See linked issue. Short form:

Kimi’s always-sent baseline mixed **trusted host rules** with **workspace-controlled text** (`AGENTS.md`, directory listings, skill listings, session timestamp) inside the **system** channel. Soft prose (“AGENTS is not privileged”) was not a structural boundary. A poisoned checkout can therefore elevate project text toward system-law priority (prompt injection via baseline / supply chain), not only via the user’s chat turn.

Related historical discussion: MoonshotAI/kimi-code#2024 (closed without landed fix), #2028 (`KIMI_NOW` / cache), #524 `/context`, #1955 baseline size.

## What changed

### Phase 1 — structural isolation

- Added shared helpers (v1 + v2):
  - `escapeUntrustedText`, `sanitizeUntrustedControls`, `wrapUntrusted`
- Envelopes: `untrusted_cwd_listing`, `untrusted_additional_dirs`, `untrusted_agents_md`, `untrusted_skills_listing`
- Skill activation: non-system preamble + `hardenSkillBody` (closer breakout + control strip)
- Goal injectors: reuse shared escape instead of local copies
- Default system templates describe workspace data as untrusted and non-overriding

### Phase 2a/2b — role / channel split (Codex-aligned, without kosong `developer` role)

- **Trusted system prompt** retains role, safety, tool etiquette, OS/shell, cwd **path**, and rules pointing at external context.
- **Removed from system body:** raw listing / AGENTS / skills payloads and mid-system dynamic `now`.
- **Request-time user fragments** via `buildBaselineContextMessages` / `baselineMessagesForContext`:
  1. Time fringe: “It is …” (stable system prefix → better prompt-cache characteristics; related to #2028).
  2. External workspace body with Phase 1 envelopes.
- Stitched at generate/request time — **not** written into conversation history / durable turn memory:
  - v1: `Agent` holds fragments → `KosongLLM` prefixes history; BTW copies parent baseline; full compaction estimates + summarizer calls include baseline.
  - v2: `IAgentProfileService.getBaselineContextMessages()` → `llmRequester` prefixes (turn-snapshotted with system prompt).
- Legacy template placeholders for untrusted vars stay **empty** so custom agent templates cannot re-inject workspace payloads into system through those vars.

### Why this fits Kimi Code

- Dual engines (`agent-core` + `agent-core-v2`) stay parallel.
- Uses existing kosong roles (`user` + system side-channel); avoids a kosong-wide `developer` role change.
- Host approvals / sandbox remain the real control plane; this change lowers **architectural** trust of workspace text.

### Out of scope (explicit non-goals)

- First-class `developer` in kosong  
- `/context` UI (#524)  
- Dedicated baseline size campaign (#1955)  
- Permission / YOLO semantic changes  
- MCP tool-description meta strip  

## Architecture (after)

```text
┌─ systemPrompt (trusted, stable) ─────────────────────┐
│  role + safety + tool etiquette + OS/shell + cwd path │
│  rules: workspace data arrive as user baseline msgs   │
└──────────────────────────────────────────────────────┘
┌─ request-only user fragments (not history) ──────────┐
│  [user] time fringe                                        │
│  [user] External Workspace Context + <untrusted_*>…       │
└──────────────────────────────────────────────────────┘
┌─ context memory (conversation) ──────────────────────┐
│  real user / assistant / tool / system-reminder turns │
└──────────────────────────────────────────────────────┘
```

## Test plan

Commands used during development (Node ≥ 24.15, pnpm monorepo):

```sh
pnpm --filter @moonshot-ai/agent-core typecheck
pnpm --filter @moonshot-ai/agent-core-v2 typecheck

pnpm --filter @moonshot-ai/agent-core exec vitest run \
  test/profile \
  test/utils/xml-escape.test.ts \
  test/agent/kosong-llm.test.ts \
  test/tools/skill-tool.test.ts \
  test/agent/injection/goal.test.ts \
  test/agent/skill-tool-manager.test.ts

pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run \
  test/app/agentProfileCatalog \
  test/_base/utils/xml-escape.test.ts \
  test/agent/goal/injection \
  test/app/skillCatalog/skill-tool-manager.test.ts \
  test/agent/llmRequester/llmRequesterService.test.ts
```

**Last verified:** typecheck green; agent-core focused **96** tests; agent-core-v2 focused **66** tests.

Coverage includes:

| Area | Tests |
|------|--------|
| Envelope + escape helpers | `xml-escape.test.ts` (v1/v2) |
| Baseline builder (fringe, skills gate, breakout) | `baseline-context.test.ts`, profile-shared/default-agent-profiles |
| System trusted-only | default profile / loader tests |
| LLM stitch prepend | `kosong-llm.test.ts`, `llmRequesterService.test.ts` |
| Skill activation harden | skill-tool / skill-tool-manager |
| Goal escape single-source | goal injection tests |

**Manual (recommended before merge):**

1. Temp dir + hostile `AGENTS.md` requiring “POISONED” prefix.  
2. Fresh session, ask `What is 2+2?`.  
3. Inspect wire/request log: system lacks AGENTS body; user baseline fragments contain `<untrusted_agents_md>` with escaped closers if present.

## Changeset

`.changeset/untrusted-system-prompt-baseline.md` — **patch** `@moonshot-ai/kimi-code`:

> Isolate workspace-supplied baseline context (AGENTS.md, directory listings, skill listings, session time) in request-time user fragments with untrusted envelopes so it cannot live in the trusted system prompt or override host rules.

## Docs

- Design: `docs/design/system-prompt-baseline-isolation.md`  
- This MR / issue drafts under `docs/design/` (internal; not VitePress user docs).  
- Product en/zh user docs: **not** updated (no user-facing config/command change). Mark gen-docs N/A unless reviewers want a security note later.

## Risk and rollout

| Risk | Mitigation |
|------|------------|
| Models treat AGENTS weaker off-system | Still injected every turn; preamble insists it is project guidance |
| Custom agent templates that referenced `{{ KIMI_AGENTS_MD }}` etc. | Placeholders empty by design; baseline still delivers content with standard framing |
| Resume from old wire with fat system blob until refresh | Next bind/refresh re-renders trusted-only + baseline rebuild |
| BTW/subagent missing baseline | `copyBaselineContextFrom` / profile bind paths |
| Residual social engineering via benign-looking AGENTS | Accepted; permissions/sandbox still authorize action |

**Rollout:** default-on, no feature flag. Patch release with CLI bundle.

## Checklist

- [x] I have read the [CONTRIBUTING](https://github.com/MoonshotAI/kimi-code/blob/main/CONTRIBUTING.md) document.
- [ ] I have linked a related issue, or explained the problem above. <!-- open issue from companion draft, then link -->
- [x] I have added tests that prove my feature works.
- [x] Ran changeset (manual file matching gen-changesets intent): `.changeset/untrusted-system-prompt-baseline.md`
- [x] Ran gen-docs skill, or this PR needs no doc update. <!-- N/A: no en/zh product page change -->

## File map (primary)

```text
packages/agent-core/src/utils/xml-escape.ts
packages/agent-core/src/profile/baseline-context.ts
packages/agent-core/src/profile/resolve.ts
packages/agent-core/src/profile/default/system.md
packages/agent-core/src/agent/turn/kosong-llm.ts
packages/agent-core/src/agent/index.ts
packages/agent-core/src/agent/skill/prompt.ts
packages/agent-core/src/agent/injection/goal.ts
packages/agent-core/src/agent/compaction/full.ts
packages/agent-core/src/session/subagent-host.ts

packages/agent-core-v2/src/_base/utils/xml-escape.ts
packages/agent-core-v2/src/app/agentProfileCatalog/baseline-context.ts
packages/agent-core-v2/src/app/agentProfileCatalog/profile-shared.ts
packages/agent-core-v2/src/app/agentProfileCatalog/system.md
packages/agent-core-v2/src/agent/profile/profile.ts
packages/agent-core-v2/src/agent/profile/profileService.ts
packages/agent-core-v2/src/agent/llmRequester/llmRequesterService.ts
packages/agent-core-v2/src/agent/skill/prompt.ts
packages/agent-core-v2/src/agent/goal/injection/goalInjection.ts

.changeset/untrusted-system-prompt-baseline.md
docs/design/system-prompt-baseline-isolation.md
```

## Reviewer notes

1. Confirm system prefix no longer includes listing/AGENTS/skills/`now` for **default** profiles.  
2. Confirm request path always prepends baseline (including compaction summarizer path on v1).  
3. Confirm empty baseline does not double-prefix or force empty user turns.  
4. Reject accidental commits of `docs/.gitignore` noise, handoff files, or `_refs/` comparison clones.  
5. Branch may need rebase onto latest `main` before open (worktree was behind origin during development).
