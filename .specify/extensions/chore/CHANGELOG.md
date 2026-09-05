# Chore Workflow Changelog

## 1.0.0

- Initial release of the `chore` extension.
- `chore.assess` — scope a maintenance chore against the codebase and the project
  constitution, write `.specify/chores/<slug>/assessment.md`.
- `chore.fetch` — load an existing GitHub issue into the chore workflow.
- `chore.implement` — apply the scoped chore and record what changed.
- `chore.issue` — file a GitHub issue from a chore assessment.
- `chore.pr` — open a PR for the implemented chore, linking the issue.
- Constitution-aware: assessments consult `.specify/constitution.md` so chores
  stay inside the project's stated principles.
