---
id: issue-fix
when: A bug reported in a GitHub issue needs a verified fix
stages:
  - id: triage
    objective: Locate the root cause and judge whether it is worth fixing (frequency, blast radius, cost)
    completion: Root cause pinned to concrete files and lines; frequency, blast radius, and cost each have a stated conclusion
    gate: human

  - id: plan
    objective: Produce an executable fix plan
    completion: The plan states which files change, the approach, and the expected impact
    gate: human

  - id: implement
    objective: Make the reported problem stop reproducing without breaking existing behavior
    completion: A test reproducing the issue exists and passes; the full test suite of the affected package passes
    gate: ai

  - id: review
    objective: Confirm from an independent perspective that no new problem was introduced
    completion: Every finding is either fixed or explicitly judged not worth fixing
    gate: ai-then-human
---

## implement

Decide how to work freely; do not refactor unrelated code paths, and do not change behavior outside this issue.
