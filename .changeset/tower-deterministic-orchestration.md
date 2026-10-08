---
"@moonshot-ai/kimi-code": minor
---

Tower mode (experimental): missions are orchestrated deterministically with TowerRebase, steered worker messages, LLM-free `/tower status`, and code-enforced completion/merge gates; `/tower on` pauses the active goal and agent goal creation/resume is denied (manual `/goal resume` exits tower); destructive Bash commands (`git clean`/`git reset --hard` in the main checkout, `rm` on tower paths) are vetoed; and accidental .tower/comms deletion is reported by TowerStatus and wake digests while TowerSend/TowerComplete recover a minimal state stamped recoveredAt.
