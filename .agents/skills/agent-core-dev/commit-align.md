# Subskill — Commit align (triage a `main` commit against v2)

Context: you are on the `kimi-code-v2` branch, in the phase of catching it up to **new commits that landed on `main`**. Those commits change `packages/agent-core` (v1); the job is to decide, for one commit at a time, whether v2 (`packages/agent-core-v2`) already has the corresponding logic — and if not, what the minimal fix is.

Use this when the user hands you **one commit hash plus a short description** ("look at `<commit>` — it fixed the steering race"). It is the small, per-commit sibling of [align.md](align.md): `align.md` ports a whole v1 domain into v2; this file triages a single `main` commit and says *port / adapt / skip*. If the triage reveals a whole missing domain, stop and switch to [align.md](align.md).

## The one-paragraph mental model

A `main` commit edits v1's singleton-container code. The same behavior in v2 lives behind a scoped Service, so a commit lands in one of four buckets: **already-aligned** (v2 has it, possibly by construction), **partial** (v2 has a nearby version whose semantics drift), **missing** (v2 has nothing), or **not-applicable** (the v2 architecture removed the very problem the commit fixes). Your output is a bucket assignment plus evidence, then a fix sized to that bucket — never a blind port of the diff.

## The workflow

```text
Read the commit + the user's note → Locate the v1 logic → Map to a v2 domain
→ Check v2 for a corresponding implementation → Bucket it → Recommend a fix → Verify
```

### 1. Read the commit and the note

**Goal:** know exactly what changed in v1 and *why*. The user's one-liner gives the intent; the diff gives the facts.

Actions:

- Inspect the change scoped to v1: `git show <commit> -- packages/agent-core` (and `--stat` first to see the blast radius).
- From the diff, list: touched files, changed functions/methods, and the observable behavior delta (before → after).
- Reconcile with the user's note: is this a bugfix, a semantic correction, new behavior, or a refactor? The *why* decides whether v2 even needs the change.

Do not skim the user's sentence and guess — the diff is the spec for what "aligned" means here.

### 2. Locate the v1 logic

Pin the change to a v1 place: the contract (`<domain>/<domain>.ts`) + impl (`<domain>/<domain>Service.ts`), or the helper/handler the commit touched. Note which state it reads/writes and which other v1 services it calls — this is the same inventory as [align.md](align.md) §1, scoped to the commit's footprint.

### 3. Map to a v2 domain

Use the v1 → v2 domain table in [align.md](align.md) §3 as a starting point, then **verify against the current `packages/agent-core-v2/src/` tree** — it is the source of truth. Identify the candidate v2 Service(s) that would own this behavior, and their `LifecycleScope`.

### 4. Check v2 and assign a bucket

Search the candidate domain in v2 (Grep the method name, the state field, the error code). For each piece of the commit's behavior delta, decide:

- **Already-aligned** — v2 produces the same observable result (sometimes for free, because the v2 design never had the bug). Cite the v2 file:line.
- **Partial** — v2 has a near miss: same method, different guard/ordering/error; or the state lives at a different scope. Name the exact drift.
- **Missing** — no v2 Service owns this behavior. Confirm it is a single-Service gap, not a whole-domain gap (latter → [align.md](align.md)).
- **Not-applicable** — the v2 architecture removed the condition the commit fixes (e.g. the scope tree already serializes what v1 patched with a lock). Explain why, so a reviewer trusts the skip.

Every claim needs a citation (`path:line`) on both sides; "I couldn't find it" is a finding only after you name where you looked.

### 5. Recommend a fix (sized to the bucket)

- **Already-aligned** — say so and stop; reference the v2 location. No code change.
- **Partial** — propose the smallest edit that closes the drift: which Service, which method, which guard. Stay inside v2 rules — scope/domain direction, no `Map<sessionId, …>` at `App` (see [align.md](align.md) §6–§7 red lines).
- **Missing** — sketch the port at commit granularity: target domain + scope, the Service/method to add or extend, the dependency direction, and which [align.md](align.md) §7 conversions apply (registration, `#/…` imports, co-located coded error, `IFlagService` for any gate). If it needs a new scope or a wire change, flag it.
- **Not-applicable** — recommend no v2 change, but call out any test worth adding so the gap stays closed.

Keep the recommendation to the commit's footprint. If it keeps growing, that is the signal to hand off to [align.md](align.md) for a full domain port.

### 6. Verify

Point at the checks that cover the fix, per [verify.md](verify.md): `lint:domain`, `typecheck`, and the relevant `test`. Note the expected outcome rather than asserting you ran it if you did not.

## Output shape

When triaging, answer in this order so the user can act on it directly:

1. **Commit + intent** — one line restating what the commit changed and why (from the note + diff).
2. **v1 location** — file(s) and the behavior delta.
3. **v2 status** — one of the four buckets, with `path:line` evidence on both sides.
4. **Recommendation** — the concrete fix (or the justified skip), scoped to the commit; name the target Service / scope / dependency direction.
5. **Verify** — which checks should pass, and whether to escalate to [align.md](align.md).

## Red lines (this subskill)

- Read the diff and the note before judging v2; never infer "aligned" from the description alone.
- Do not copy a v1 diff into v2. Decide the bucket first; a bugfix commit often maps to **not-applicable** because the v2 design already removed the defect.
- Cite `path:line` on both sides. A recommendation without evidence is a guess.
- Stay in the commit's footprint. Growing scope means "switch to [align.md](align.md)", not "keep porting here".
- Do not break v2 invariants to chase v1 parity — scope direction, domain direction, and no `Map<sessionId, …>` at `App` still hold ([align.md](align.md) red lines).
