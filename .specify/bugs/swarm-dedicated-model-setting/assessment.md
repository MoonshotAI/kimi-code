# Bug Assessment: No dedicated model setting for agent swarm (like secondary/vision model)

- **Slug**: swarm-dedicated-model-setting
- **Created**: 2025-08-26T08:00:02.053Z
- **Source**: pasted text
- **Verdict**: valid
- **Severity**: medium

## Report (verbatim or summarized)

> allow a dedicated model for agent swarm just like the secondary model vision-model setting, swarm model should be a setting

## Symptom

There is no configuration option to set a dedicated model specifically for agent swarm operations. Users can configure a secondary model for subagents via `[secondary_model]`, and a visual model via `[visual_model]`, but there's no equivalent `[swarm_model]` or similar setting. This forces swarm subagents to either use the primary model or the secondary model, with no independent configuration for swarm-specific workloads.

## Reproduction

1. Check `config.toml` for a `[swarm_model]` or similar section — it doesn't exist
2. Try to configure a dedicated model for swarm operations — only `[secondary_model]` is available
3. Launch an agent swarm — subagents use either primary or secondary model based on the `model` parameter in `AgentSwarm` tool

## Suspected Code Paths

- `packages/agent-core-v2/src/features/swarm/configSection.ts` — Only defines `timeoutMs`, no model configuration (lines 13-15)
- `packages/agent-core-v2/src/features/swarm/agent/swarmService.ts` — No model configuration handling
- `packages/agent-core-v2/src/features/swarm/tools/agent-swarm/agentSwarmTool.ts` — Reads model from tool argument or profile preference, not from a dedicated swarm config
- `packages/agent-core-v2/src/session/subagent/configSection.ts` — Defines `SecondaryModelConfigSchema` (lines 31-48) and `visualModelOverlay.ts` for visual model — pattern to follow
- `packages/agent-core/src/config/secondary-model.ts` — Secondary model overlay implementation to mirror

## Root Cause Hypothesis

**Confidence: high**

The swarm feature was implemented without a dedicated model configuration section. The pattern exists for:
- `[secondary_model]` — for general subagent delegation (implemented in `packages/agent-core-v2/src/session/subagent/configSection.ts` and `packages/agent-core/src/config/secondary-model.ts`)
- `[visual_model]` — for visual tasks (implemented in `packages/agent-core-v2/src/app/kosongConfig/visualModelOverlay.ts`)

But no equivalent `[swarm_model]` section was created. The `SwarmConfigSchema` in `configSection.ts` only has `timeoutMs`.

## Proposed Remediation

**Preferred**: Add a `[swarm_model]` config section following the secondary/visual model pattern

1. **Add `SwarmModelConfigSchema`** in `packages/agent-core-v2/src/features/swarm/configSection.ts` mirroring `SecondaryModelConfigSchema`:
   - `model`: string (model alias from `[models]`)
   - `defaultEffort`: string (thinking effort)
   - Patch fields (overrides like `maxContextSize`, `maxInputSize`, etc.)
2. **Create a swarm model overlay** (like `visualModelOverlay`) that synthesizes a derived model entry `__swarm__` when patch fields exist
3. **Update `AgentSwarmTool`** to use the swarm model by default when configured (instead of secondary model)
4. **Add `exposesSwarmModelChoice`** and `buildSwarmModelDescriptions` functions for tool schema

**Alternatives**:
- Extend `[secondary_model]` with a `swarmDefault` field to specify a different default for swarm vs. regular subagents
- Add a `swarm_model` key to the existing `[secondary_model]` section

**Files likely to change**:
- `packages/agent-core-v2/src/features/swarm/configSection.ts` — add `SwarmModelConfigSchema`, env bindings, overlay registration
- `packages/agent-core-v2/src/features/swarm/tools/agent-swarm/agentSwarmTool.ts` — use swarm model config
- `packages/agent-core-v2/src/features/swarm/session/sessionSwarmService.ts` — pass swarm model to spawn
- `packages/agent-core-v2/src/app/kosongConfig/` — add swarm model overlay (new file or extend visualModelOverlay pattern)

**Tests to add or update**:
- Test that `[swarm_model]` config is parsed and applied
- Test that swarm subagents use the dedicated swarm model by default
- Test that tool `model` parameter still overrides the config
- Test derived entry synthesis when patch fields are present

## Risks & Considerations

- **Config complexity**: Adding another model section increases configuration surface area
- **Precedence**: Need clear precedence: tool argument > profile preference > swarm model config > secondary model config > primary model
- **Migration**: Existing users relying on secondary model for swarm need a migration path
- **Overlay ordering**: Swarm model overlay must be registered after secondary model overlay so it can reference the secondary-derived entry if needed

## Open Questions

- [NEEDS CLARIFICATION: Should swarm model default to secondary model when not configured, or to primary model?]
- [NEEDS CLARIFICATION: Should the swarm model setting apply to both v1 and v2 swarm, or only v2?]
- [NEEDS CLARIFICATION: Should there be a separate `swarm_model` section or extend `secondary_model`?]