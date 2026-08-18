---
id: issue-fix
when: A bug report, GitHub issue, or feature request needs a verified, reviewed fix
stages:
  - id: triage
    objective: Understand the problem, locate the root cause, and judge whether it is worth fixing
    completion: Root cause pinned to concrete files and lines; frequency (common / occasional / edge case), affected scope (all users / specific scenario / specific platform), and severity (crash / broken behavior / annoyance) each have a stated conclusion; a recommendation on whether to fix, with the estimated cost
    gate: human

  - id: plan
    objective: Produce a fix plan the user can approve
    completion: The plan names the files and parts to change, the approach and why it works, and the estimated size of the change; related code paths have been explored and the impact on existing behavior and future maintainability is assessed
    gate: human

  - id: implement
    objective: Make the problem stop reproducing, test-first, without breaking existing behavior
    completion: A failing test reproducing the issue was written before the fix and passes after it; the full test suite of the affected packages passes; the change's impact on existing mechanisms was checked against the code, not assumed
    gate: ai

  - id: review
    objective: Independent review until no substantive issue remains
    completion: An independent review covered correctness against the root cause, robustness (error paths, concurrency, leaks), backward compatibility, code quality, and security; every finding is either fixed or explicitly rejected with a stated reason; the final round surfaced no substantive new issue
    gate: ai-then-human

  - id: report
    objective: Deliver the closing report and prepare the submission for user approval
    completion: The closing report covers root cause, fix, cost, impact, test coverage, and review outcomes; lint and tests are green; a changeset exists per the repo's rules; the PR draft has been presented to the user
    gate: human
---

## triage

Analysis only — write no code. Judge from first principles: what is actually broken, for whom, and at what cost to fix. When the input is a feature request rather than a bug, this stage is a brainstorm with the user until the direction is agreed; the rest of the flow is identical from there.

## plan

Still no code. A good plan survives contact with the codebase: explore the real code paths before claiming impact, and state trade-offs instead of hiding them.

## implement

Write the failing reproduction test before touching the fix. Do not dodge a needed refactor with a cheap patch, and do not refactor unrelated code paths — stay scoped to this issue. If the change may affect an existing mechanism, verify against the code instead of assuming. Quality first: there is no deadline pressure in this stage.

## review

Use a fresh, independent reviewer; loop until a round surfaces no substantive issue, then finish with one adversarial pass — assume the change ships today: what breaks in production, and which edge case is untested? Triage findings honestly: obviously-correct small fixes are simply applied, substantive ones get analyzed on cost versus benefit, over-engineering and false positives are rejected with a stated reason.

## report

Report like a project manager: background, root cause, impact, fix, cost, test coverage, review outcomes — every claim backed by what was actually run or changed. Commit messages and the PR are written in English, follow the repo's changeset rules, and carry no co-author attribution. The PR is created only after the user approves the draft.
