# Bug Assessment: Swarm model change does not propagate to paused/resumed swarm agents

- **Slug**: swarm-model-change-propagation
- **Created**: 2025-08-26T08:00:02.053Z
- **Source**: pasted text
- **Verdict**: valid
- **Severity**: high

## Report (verbatim or summarized)

> currently when agents swarm multiple instances and if my account quota gets full, there is no way to change the active swarm model, when I change the model on the session, it should be able to change the model on swarmed paused models as well.

## Symptom

When a user runs an agent swarm (via `AgentSwarm` tool or `/swarm` command) and later changes the model on the parent session (via `/model` command or RPC), the model change does not propagate to already-spawned or paused swarm subagents. If the user's quota is exhausted on the current model, they cannot switch the swarm agents to a different model — they must wait or abandon the swarm.

## Reproduction

1. Start a session with a primary model (e.g., `kimi-k2`)
2. Launch an agent swarm with multiple subagents (via `AgentSwarm` tool or `/swarm <prompt>`)
3. Let some subagents complete or pause (e.g., waiting for user input or hitting rate limits)
4. Change the session model via `/model <new-model>` or the RPC `setModel` call
5. Resume or continue the swarm subagents
6. Observe that subagents still use the old model instead of the new session model

## Suspected Code Paths

- `packages/agent-core/src/session/subagent-host.ts` — `reInheritParentModel()` (lines 493-503): Only re-inherits parent model when `secondary-model` experiment is **disabled**. When enabled, subagents keep their bound model at spawn.
- `packages/agent-core-v2/src/features/swarm/session/sessionSwarmService.ts` — `resumeAttempt()` (lines 143-172): Does not update the child's model on resume; only emits `emitAgentRunSpawned` with the resumed model but doesn't call `profile.setModel()` on the child agent.
- `packages/agent-core-v2/src/features/swarm/tools/agent-swarm/agentSwarmTool.ts` — `runSwarm()` (lines 144-213): Passes `modelChoice` to spawn plan but doesn't handle model propagation on resume/retry.
- `packages/agent-core/src/agent/swarm/index.ts` — `SwarmMode` class: Manages swarm mode state but has no model propagation logic.

## Root Cause Hypothesis

**Confidence: high**

The codebase has two distinct code paths for swarm:
1. **v1 (agent-core)**: In `subagent-host.ts`, `reInheritParentModel()` explicitly skips model inheritance when the `secondary-model` experiment is enabled (line 501). This was intentional for v2 semantics but breaks the use case where users want to change models mid-swarm due to quota limits.
2. **v2 (agent-core-v2)**: In `sessionSwarmService.ts`, `resumeAttempt()` reads the child's current model (`resumedModel = child.accessor.get(IAgentProfileService).data().modelAlias`) but never updates it to match the parent's current model. The model binding is fixed at spawn time.

The design decision was that subagents should keep their bound model (v2 semantics), but there's no mechanism to propagate a parent model change to existing/paused swarm subagents.

## Proposed Remediation

**Preferred**: Add a "propagate model change to swarm subagents" capability

1. **Add a new method on `IAgentSwarmService`** (v2) and `SwarmMode` (v1): `propagateModelChange(newModelAlias: string, thinkingEffort?: string)` that iterates over all active/paused swarm subagents and updates their model.
2. **Hook into the model change event**: When the parent agent's model changes (via `IAgentProfileService.setModel()`), trigger propagation to swarm subagents if swarm mode is active.
3. **Scope the propagation**: Only affect subagents that belong to the current swarm (tracked via `swarmItem` metadata or parent agent ID).

**Alternatives**:
- Add a `/swarm model <model>` subcommand to explicitly push model changes to swarm agents (more explicit, less magical)
- Allow `resume` in `AgentSwarm` tool to accept an optional `model` override parameter

**Files likely to change**:
- `packages/agent-core-v2/src/features/swarm/agent/swarm.ts` (interface) and `swarmService.ts` (implementation)
- `packages/agent-core-v2/src/features/swarm/session/sessionSwarmService.ts` — add model update in `resumeAttempt` and new `propagateModelChange`
- `packages/agent-core/src/agent/swarm/index.ts` — add `propagateModelChange` to `SwarmMode`
- `packages/agent-core/src/session/subagent-host.ts` — modify `reInheritParentModel` to optionally force propagation
- `packages/kap-server/src/routes/sessionAgentConfig.ts` — handle swarm model propagation on `setModel` RPC

**Tests to add or update**:
- Test that changing parent model via `setModel` propagates to paused swarm subagents
- Test that resumed swarm subagents use the new model after propagation
- Test that propagation only affects subagents in the current swarm (not other subagents)

## Risks & Considerations

- **Breaking change**: Current behavior (subagents keep their model) is intentional for v2 semantics. The fix should be opt-in or gated behind a flag.
- **Scope correctness**: Must only propagate to subagents spawned by the current swarm, not all subagents in the session.
- **Concurrency**: Model change propagation must handle subagents that are currently running (should not interrupt in-flight requests).
- **Quota scenario**: The primary use case is quota exhaustion — propagation should work even when the old model is rate-limited.

## Open Questions

- [NEEDS CLARIFICATION: Should model propagation be automatic on parent model change, or explicit via a command/API?]
- [NEEDS CLARIFICATION: Should this apply to both v1 and v2 swarm implementations, or only v2 (agent-core-v2)?]
- [NEEDS CLARIFICATION: What happens to in-flight requests on subagents when the model changes mid-turn?]