---
"@moonshot-ai/kimi-code": patch
---

Tower mode (experimental, `KIMI_CODE_EXPERIMENTAL_TOWER=1`): the agent can no longer enter tower mode on its own — turn it on with /tower on, or with /tower <base-branch> (also in the web UI) to pin the local branch missions merge back into; a missing base branch is created from the current checkout (uncommitted changes committed onto it as a labeled WIP snapshot) and the workspace is initialized or rebased to it immediately, refusing with guidance while missions are open. Tower agents that die (failed, timed out, killed, or lost) are recorded in the tower protocol — TowerStatus marks them in the roster and warns about missions whose owner died, with a resume hint — and the tower's console instructions now require summarizing every worker's deliverables per mission before teardown.
