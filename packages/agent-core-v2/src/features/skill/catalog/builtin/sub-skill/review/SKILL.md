---
name: review
description: Analyze the available skill set and recommend candidate groups that could be consolidated into sub-skill bundles. Read-only — proposes a plan, does not move files.
disable-model-invocation: true
---

# Review sub-skills (`sub-skill.review`)

Analyze the current skill inventory and identify candidate groups that could be consolidated into sub-skill bundles. This sub-skill is **read-only**: it produces a proposal for the user to review before any file changes are made by `sub-skill.consolidate`.

## When to use

- The user asks to review, reorganize, or audit the skill inventory.
- There are many loosely-related skills that might benefit from hierarchical grouping.
- The user wants to evaluate whether a new skill should be a sub-skill of an existing parent.

## Process

1. **List the current inventory.** Use the skill registry (or scan the configured skill roots) to get a full list of skill names, descriptions, and source scopes.
2. **Categorize by domain.** Group skills by functional domain — e.g. file operations, web tools, collaboration, observability.
3. **Detect coupling.** Identify skills that are frequently used together or share similar `whenToUse` conditions.
4. **Flag granularity issues.** Call out skills that are too fine-grained (e.g. one skill per CLI flag) or too broad to land in any single domain.
5. **Propose sub-skill structures.** For each candidate group, list:
   - The parent skill name and a one-line description.
   - The children that should move under it.
   - Any documentation, reference, example, asset, or template directories that must move with each child so the final directory layout stays aligned.
   - Whether the parent needs `has-sub-skill: true` (it does, if children should be discovered).
6. **Output a summary report.** Present findings as a concise grouped list with rationale, and stop. Do **not** edit any file — that's `sub-skill.consolidate`'s job.

## Criteria for a good sub-skill grouping

- **Shared context.** Children operate within the same domain or workflow.
- **Composable entry point.** The parent gives a natural top-level handle; children handle specifics.
- **Shallow nesting.** Prefer 2 levels (parent → child). Avoid 3+ unless strictly necessary.
- **Backward compatibility.** Existing skill names should ideally remain discoverable.

## Example output format

```
Proposed sub-skill: web-research
  - Parent: web-research (has-sub-skill: true)
  - Children:
    - web-search    → move under web-research/search
    - fetch-url     → move under web-research/fetch
  - Documentation alignment: move each child's references/examples/assets with that child.
  - Rationale: Both deal with online information retrieval and are often chained together.
```
