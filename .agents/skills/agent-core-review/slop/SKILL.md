---
name: slop
description: Invoke only when the user explicitly asks to review code through the "single level of abstraction / layered error handling" lens — a function does only its own layer's business logic while errors are handled above or below. The agent reports detections, raw-count measurements, and move directions. Apply only when the user explicitly requests this lens.
---

# Single Level of Abstraction & Layered Error Handling

North star: **a function should read as a straight-line description of what its own layer does. Anything that is not that — input validation, error handling, error-to-response translation, logging, retries, low-level mechanics — belongs to a layer above or below, not inline.**

This is a review dimension, not a hard rule. See "Exemption checklist" at the end.

## Scope of this skill — detect and measure

The agent applying this lens is a **sensor**. Its one job is to report *whether* a function mixes levels and *by how much*; deciding *how serious* it is belongs downstream. Severity labels (`Block` / `Request changes` / `Nit`) compress a continuous quantity into an uncalibrated three-point scale and are the main source of review-to-review variance, so they are produced downstream — by a deterministic rubric, anchored examples, or a human — from the facts the agent reports.

The agent's output is exactly these four things:

- **Detection (yes/no):** does this statement / block / function violate a rule of the lens?
- **Measurement (raw factual counts only):** mechanically countable quantities — body size, control-flow keywords, named syntactic shapes (see "Quantify"). Anything that first requires classifying a line (core/foreign, happy/error, high/low level) is recorded under detection, not here.
- **Direction (where it moves):** for each foreign concern, the destination layer — push **down** into a value / parser / infra helper, or push **up** into the edge handler.
- **Exemption flags:** which items, if any, hit the exemption checklist — recorded, not weighed.

Severity grades, merge/block verdicts, and "is splitting worth it" calls live downstream, derived from the four items above.

## When to use

Apply this lens only when the user asks for it explicitly (for example "用单一抽象层次审视一下", "check whether this function does too much", "errors should be handled above/below, right?"). Leave general reviews and refactors to other lenses unless the user names this one.

## The principle

One function, one level of abstraction, one responsibility. Three mutually reinforcing rules:

1. **Single Level of Abstraction (SLAP).** Every statement inside a function sits at the same conceptual level. High-level intent ("reserve inventory, charge payment, create the order") must not be interleaved with low-level mechanics (building headers, escaping strings, opening sockets, parsing bytes). If some lines read as "what" and others as "how", they belong in different functions.
2. **Error handling is its own concern (Clean Code).** A function either does the work or handles the error — not both. Business logic describes the happy path and *signals* failure (throw or return a result); the catch, mapping, logging, and recovery live in a dedicated handler, usually one layer up. Prefer exceptions / result types over threaded check-and-return ladders that interrupt the main flow.
3. **Separation of concerns by layer.** Each layer owns exactly one kind of knowledge: low-level code knows formats and protocols; mid-level code knows business rules; edge code knows the outside world (HTTP / CLI / UI). A function that knows two of these at once is leaking a layer.

The combined test: **could you explain this function to someone without using the word "and"?** If the explanation is "it reserves stock AND validates the email format AND maps the error to a status code AND logs to metrics", it is doing more than its layer's job.

Concerns that usually do **not** belong in a business function:

- Format / range / null validation that a lower value or parser could guarantee once.
- Mapping domain failures to an external protocol (status code, exit code, UI message) — that is the edge layer's job.
- Catch-and-swallow, retry loops, backoff, timeout, circuit breaking around a single call — infrastructure, push down.
- Cross-cutting telemetry / log / metric noise woven through every step — extract or push to a wrapper.
- Check-and-return ladders that occupy more space than the business core — replace with signal + a handler above.

## Methodology — fixing a function that violates it

Work top-down. Never start by shuffling lines.

1. **Name the level.** In one sentence, write what this function is for at its own layer. If you cannot, the function has no clear level — split before polishing.
2. **Classify every statement.** Tag each line or block as: **core** (this layer's business), **down** (a detail a lower abstraction should own), **up** (a concern an upper / edge layer should own), or **cross-cutting** (log / metric / retry). Unlabeled lines are where the mess hides — do not "just leave them".
3. **Decide down vs. up for each foreign item.**
   - Push **down** when it is a guarantee a lower building block can provide: a value that can only be constructed valid, a parser that returns a typed result, an infra helper that already retries. The business function then assumes validity and stays clean.
   - Push **up** when it is about translating or reacting to failure for the outside world: status codes, messages, exit codes, aggregation of many errors. The edge layer catches once and maps; business code just signals.
   - Rule of thumb: if removing it would change what the business rule says, it is core and stays; if removing it only changes how a failure is reported or a detail is computed, it moves.
4. **Extract, do not interleave.** Pull each foreign concern into its own named function or layer. Keep the original function as a readable sequence of same-level calls. For error handling specifically, separate the work body from the recovery body into distinct functions so neither clutters the other.
5. **Signal, do not handle, in the middle.** Mid-layer business functions throw / return and let the right layer react. Do not catch-and-log-and-continue in business code unless continuing is itself the business rule.
6. **Re-read for level.** After the moves, every remaining line should be explainable at the same altitude. If not, repeat from step 1.

Keep the change minimal: move the smallest thing that restores the level. Do not invent abstractions, frameworks, or generic "handler" machinery beyond what the function actually needs. Three straight-line, same-level calls beat a premature pipeline.

## Review method — applying the lens to a diff

Read each changed or touched function and, for each check, record only: **the hit (yes/no) plus evidence (`file:line`)**, and — where the check points at a construct — a raw factual count from "Quantify".

1. **Altitude check.** Are all lines at the same level of abstraction? Record each place where a "what" line is immediately followed by a "how" block (or vice versa) inside the same function, with `file:line`.
2. **Happy-path check.** Can you read the business intent top to bottom without stepping through error branches? Record whether error handling sits inline between business steps (yes/no + `file:line`), supported by raw counts from "Quantify" (e.g. number of `catch` clauses, `continue` statements).
3. **Ownership check.** For each validation, catch, mapping, log, retry: is this layer the rightful owner, or is it borrowed from above / below? Record each borrowed item with `file:line` and its destination (down / up), using the rules from the methodology.
4. **Layer-leak check.** Does a business function mention an external protocol (status code, exit code, UI text, wire field)? Does an edge function contain a business rule? Record each leak candidate with `file:line` and whether it names an *external* protocol or an *internal* domain shape.
5. **Explanation test.** Describe the function in one sentence with no "and". Record whether "and" was needed; if so, list the proposed split as candidate moves (down / up).

### Quantify — report only raw factual counts

Report only quantities that can be counted **mechanically from the text**. Anything that first requires classifying a line (core vs foreign, happy-path vs error-handling, high-level vs low-level) is recorded under detection (the five checks above) as evidence, not as a number here.

Report, per function:

- **Body size** — lines and/or statements of the function body; state the basis (e.g. "statements, excluding lone braces").
- **Control-flow keywords (raw counts)** — `if`, `continue`, early `return`, `throw`, `try` / `catch` / `finally`, `await`, loops (`for` / `while` / `.forEach`).
- **Named syntactic shapes a check points at** — when a check cites a construct, count it verbatim and name the exact token: e.g. number of object literals, string literals, `.trim()` calls, `.length` reads, `origin.` property reads, spread `[...x]` operations.
- **Recovery presence (raw)** — number of `catch` clauses, and number of log / metric calls inside them.

Quantities that embed a prior classification — out-of-level vs core counts, guard-to-core ratios, happy-path vs error-handling volume, "repeated boundary checks a lower layer could guarantee once", "low-level literals in a high-level flow" — are captured as evidence under the relevant check (`file:line` + the verbatim tokens). A downstream rubric derives any ratio from those raw facts.

### Red flags

Record each as evidence (yes/no + `file:line`); these are candidates, not verdicts:

- A body that is mostly check-and-return / check-and-throw ladders around a thin core.
- A recovery block that logs, maps, and returns inline, sitting next to business steps.
- A function that both computes a value and decides how that value's failure is shown to the user.
- Low-level literals (byte offsets, header strings, format codes) inside a high-level workflow.
- A name that needs "And" / "Or" / "With" to be honest, or a name so vague ("handle", "process", "do") that it hides multiple levels.
- Catch-and-swallow that hides a failure the caller needed to see.
- Defensive null / format checks repeated at every call site instead of guaranteed once at the boundary.

### Severity grading belongs downstream

The agent's facts (detections, raw counts, directions, exemptions) feed a downstream grade; the agent reports those facts and stops there. Grades compress a continuous quantity into an uncalibrated three-point scale and are exactly where identical evidence gets labeled differently across runs. Grading happens above the agent:

- A **deterministic rubric** — a versioned threshold table over the raw counts from "Quantify"; or
- **Anchored examples** — the reviewer judges relative to repo-known reference functions rather than against an absolute adjective like "materially"; or
- A **human**, for items that land near a threshold boundary.

If a downstream consumer still asks the agent for a grade, the agent returns the underlying facts and the threshold band it would fall under, with `confidence: low` on boundary cases; the grade itself is produced downstream.

### How to report findings

Report **evidence + direction**. Lead with the location and the level, then the proposed move. Prefer "this block is one level lower than the rest of the function (`file:line`) — move it **down** into X" over "this is ugly" or "this is a request-changes". The destination layer (down into a value / parser / infra helper, or up into the edge handler) is the actionable output and the deliverable. Attach the "Quantify" numbers and any exemption flags to each finding.

## Exemption checklist

This is a lens, not a law. For each foreign concern, check whether any exemption below applies and **record the hit (yes/no) plus the reason**. The agent records exemptions as facts; a recorded exemption is then used downstream to cap the grade (e.g. to `Nit`) deterministically.

- **Tiny function:** the function is small enough that splitting would add indirection with no reader benefit.
- **Foreign concern is the single job:** the "foreign" concern is in fact the function's one purpose — a dedicated error mapper, a validator, an infra wrapper, or an index-bookkeeping helper whose low-level arithmetic *is* its level.
- **Atomicity / correctness / performance:** the steps genuinely must stay together (e.g. a re-check after an `await` to guard state that may have changed).
- **Edge-translator role:** an edge / handler function whose job is to translate an external event into internal indices; naming the wire fields is its job.

Keep a split that would make the code harder to read as a recorded candidate for downstream review. When the evidence lands on an exemption boundary, record both sides and set `confidence: low`.

## Output contract

Return, per function, items 1–5 only:

1. **Level statement** — one sentence: what the function is for at its own layer.
2. **Per-check results** — for each of the five review checks: `hit: yes/no`, evidence `file:line`, and (only where the check points at a construct) a raw factual count.
3. **Measurements** — the raw factual counts from "Quantify".
4. **Exemptions** — checklist hits (yes/no + reason).
5. **Proposed moves** — for each foreign concern: `file:line` → destination (down into X / up into Y). This is the actionable deliverable.

Severity grades, block/merge verdicts, and "worth splitting" calls live downstream, derived from items 1–4. When a consumer asks for a label, hand back items 1–4 and the threshold band, with `confidence: low` on boundary cases.
