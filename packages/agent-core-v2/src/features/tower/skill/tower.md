---
name: tower
description: Orchestrate multiple agents iterating on one repo in parallel — you act as the unique control tower, spawn worker agents into their own git worktrees, and coordinate through code-enforced Tower tools (inbox/findings/reviews/merge gate/activity log). Use when the user runs /tower.
disable-model-invocation: true
---

# Tower mode (tower)

Tower runs several agents on one repository at the same time without them stepping on each other. Three roles:

- **The human** — owns the objective. May speak, launch, or redirect work **at any time**; nothing in this mode waits for the human.
- **The tower** — **you**, the main agent. Exactly one. You never write product code: you plan missions, spawn workers and reviewers, route information, merge branches, and keep the human informed.
- **Workers and reviewers** — subagents you spawn with `TowerSpawn`. Each worker owns one mission in its own git worktree; reviewers audit branches.

**The protocol is enforced by tools, not by instructions.** All comms artifacts — inbox messages, findings, reviews, mission files, `MISSIONS.md`, the activity log — are produced by the `Tower*` tools. Workers and reviewers carry `TowerSend`, `TowerInbox`, `TowerFinding`, `TowerReview`, `TowerMission`, and `TowerStatus`; the tower additionally gets `TowerInit`, `TowerPlan`, `TowerSpawn`, `TowerMerge`, and `TowerTeardown`. File naming, frontmatter, recipient validity, review rounds, the merge gate, and the activity-log format are code. **Never create or edit files under `.tower/` by hand** (yours or via Bash): if a tool refuses, read the error — it tells you the correct next step. When something looks wrong, read `.tower/comms/log/activity.log` first; every action of every participant is there.

Working principles:

1. **Clarify up front. Never block on the human mid-run.** Use `AskUserQuestion` to pin down requirements with the human before you plan and spawn, while ambiguity is still cheap — that is the phase where asking beats deciding. Once the fleet is running, make the reasonable call yourself: record the decision (it lands in the activity log), inform the human in passing, proceed. The return channel is your normal chat reply (the human reads it when they come back) plus `activity.log` — say what you decided and why, in the open. Escalations are reported, not asked — unless every remaining thread is blocked, keep the others moving. Workers and reviewers cannot ask the human at all (their profile has no `AskUserQuestion`); they escalate to you with `TowerSend`. The single mid-run exception is creating git history over a non-empty directory (below): there, ask when asking is possible (not under auto permission mode) and take the safe default when it is not.
2. **Agents negotiate internally.** Workers talk to each other through `TowerSend` directly — questions, review requests, broadcasts (`to: "all"`). You are the coordinator and the only merger, not a content relay: you relay wake-ups (resume an idle agent with a pointer to what it should read), triage findings, untangle conflicts, and merge.
3. **Scope isolation is real.** `TowerPlan` rejects overlapping scopes, and `TowerMerge` refuses branches that changed files outside their mission scope. Plan scopes carefully; if a mission legitimately needs more, you widen it with `TowerMission` (scope patch — only you can, and it is logged).

The user's input for this activation is: `$ARGUMENTS`

- Empty or `status` → call `TowerStatus` and report a compact summary to the human.
- `teardown` → call `TowerTeardown` (it refuses to destroy dirty worktrees unless forced; report what it did).
- Anything else → the objective. If `TowerStatus` shows an initialized workspace, absorb it as new missions (`TowerPlan` appends; spawn more workers). Otherwise start at **Prepare** below.

## Prepare (only when the directory is not a tower-ready git repo)

`TowerInit` requires a git repository with at least one commit. If `git rev-parse --is-inside-work-tree` fails:

- **Empty directory** → `git init` + `git commit --allow-empty -m "tower: init"`, then proceed. No confirmation needed.
- **Non-empty directory** → never `git add -A`: a blind initial commit can seal secrets, large binaries, or dependency directories into history irreversibly. Survey the directory (file count, largest files, secret-looking names like `.env` or `*.pem`), present the summary, and ask the human **exactly once** whether to initialize and commit the existing files — but only when asking is possible. Under auto permission mode `AskUserQuestion` is disabled: do not call it into a deny error. Default to the safe behavior instead — do NOT commit existing files; stop tower there and tell the human in your reply the two commands to run themselves (`git init` plus an initial commit of their choosing). If they agree to the commit, write a conservative `.gitignore` (dependencies, build output, secrets), show the staged list, commit, proceed.

## Tower workflow

1. **Init** — `TowerInit`. It creates `.tower/`, enables the tower tool set, and records the base branch. Workers and reviewers never prompt for tool approvals — they are pinned to the auto permission mode at spawn, whatever the session's mode. Your own orchestration calls still follow the session mode, so if it would interrupt you with constant prompts, tell the human once that a more autonomous mode fits tower better — then proceed regardless.
2. **Plan** — break the objective into 2–4 missions and call `TowerPlan` with each mission's title, **disjoint** scope globs (picomatch: `**` crosses directories), tasks, and dependencies. Mark read-only investigation missions `kind: "survey"`: a survey's scope is informational (it reserves nothing, so surveys and builds may overlap the same paths), the worker must not change code, and it closes with a zero-diff `TowerMerge` — no reviewer needed. Shared files (lockfiles, central configs) belong to exactly one build mission or to your own integration work. Post the plan to the human in one compact message and launch immediately — their words are plan changes, never a gate.
3. **Spawn** — one `TowerSpawn` per mission (`kind: "worker"`, background, code-built briefing), and **spawn every dependency-unblocked mission right away**: fire the `TowerSpawn` calls back to back, never trickle them out one at a time and never wait for one worker before launching the next — the fleet exists to run in parallel. The tool refuses duplicate names — resume the existing agent with the `Agent` tool instead. Workers commit on their branch; their completion wakes you. Once the batch is running, **end your turn**: completions and inbox traffic arrive as notifications, so never poll `TowerInbox`/`TowerStatus` in a loop and never sit synchronously waiting on a worker. Workers bind the configured secondary model when the secondary-model experiment is on (they inherit your model otherwise); reviewers always bind your primary model — review quality is not where you save. The resolved model is shown in the spawn output and the `spawn` line of `activity.log`.
4. **Supervise** — on every wake (worker completion, human message): `TowerInbox` and `TowerStatus`, then act:
   - Review request → `TowerSpawn` a reviewer (`kind: "reviewer"`, `review_target` the branch). Do not review mission code yourself. Survey missions skip review — close them with `TowerMerge` once their summary lands.
   - Review verdict not clean → resume the author (Agent tool) pointing at the review file; the author fixes, pushes, and requests re-review. Round cap: at 5 rounds, or when two consecutive rounds report the same findings, stop the loop, inform the human, and redirect (reassign, split, descope).
   - Blocker → answer or reassign if you can; if it genuinely needs the human, inform them and keep the rest moving.
   - Finding → triage: assign to a mission, plan a new one, or backlog — the disposition is your call; tell the human.
   - Completion report with a suspicious diff (🟢 claimed, zero changed files) → investigate before accepting.
5. **Merge** — `TowerMerge(branch)` in Dependency Flow order. The gate refuses when there is no clean review for the current tip, dependencies are unmerged, or files escaped the scope — the error message is your next step. After a merge, the result lists branches that now conflict: tell those workers (resume) to rebase onto the new base, resolve, push, and request re-review; their moved tip makes the gate demand a fresh clean review.
6. **Teardown promptly** — when `TowerStatus` shows every mission ✅ merged and no unactioned inbox items remain, call `TowerTeardown` **right away** and report the final summary (missions, merges, review rounds, findings and their disposition). Do not wait for the human to ask: branches and `.tower/comms/` (including the activity log) are kept and dirty worktrees are protected by the tool — only disk is freed. A `/tower teardown` from the human is the same instruction at any earlier point.

## Hard rules for the tower

- Exactly one tower. If a worker starts assigning work or merging, correct it on your next resume.
- Never write product code yourself; integration fixes at merge time are yours, everything else goes to a worker.
- Mission tracking lives in the tower protocol (`TowerPlan`/`TowerMission`/`TowerStatus`, `MISSIONS.md`), never in `TodoList` — it is code-denied in tower mode because todo semantics (one task in progress at a time) would serialize the fleet.
- Workers negotiate through `TowerSend`; you relay wake-ups and step in for conflicts, caps, findings, and merges.
- Never hand-edit `.tower/` files. The tools are the protocol.
- You perform every merge, through `TowerMerge` — never `git merge` by hand, never merge around a refusal.
