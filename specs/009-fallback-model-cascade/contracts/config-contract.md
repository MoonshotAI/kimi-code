# Contracts: Fallback Model Cascade

**Feature**: 009-fallback-model-cascade
**Date**: 2026-09-01

## Engine contract: `resolveFallbackBinding`

Added next to the existing `compactionModelBindingFor` (`packages/agent-core-v2/src/session/compaction/configSection.ts`). The agent loop calls this in `AgentStepRetryService.recover` after the existing `failedAttempts >= maxAttempts` check fails.

```
resolveFallbackBinding(
  config: IConfigService,
  flags: IFlagService,
  own: { modelAlias: string; thinkingLevel: string },
): FallbackBinding | undefined
```

`FallbackBinding` is the same shape as `CompactionBinding`:

```ts
interface FallbackBinding {
  readonly model: string;
  readonly thinking?: string;
  readonly displayModel: string;
}
```

Returns `undefined` when the `fallback-model` flag is off OR `[fallback_model]` is empty — caller falls back to existing behavior (terminal error). Otherwise returns the next tier's binding, or `undefined` if both tiers have been tried.

## Engine contract: `resolveFallbackModel`

```
resolveFallbackModel(
  config: IConfigService,
  flags: IFlagService,
): FallbackModelConfig | undefined
```

Returns the configured `[fallback_model]` section, or `undefined` if the flag is off.

## Engine contract: `resolveFallbackSecondaryModel`

```
resolveFallbackSecondaryModel(
  config: IConfigService,
  flags: IFlagService,
): string | undefined
```

Returns the `secondary_model` field, or `undefined` if unset.

## Config schema: `FallbackModelConfigSchema`

```ts
export const FALLBACK_MODEL_SECTION = 'fallbackModel';

export const FallbackModelConfigSchema = ModelOverrideSchema.extend({
  model: z.string().min(1).optional(),
  secondaryModel: z.string().min(1).optional(),
});
```

Registered via `registerConfigSection(FALLBACK_MODEL_SECTION, FallbackModelConfigSchema, { env: fallbackModelEnvBindings })`.

## TUI contract: slash commands

| Command | Behavior |
|---------|----------|
| `/fallback-model <alias>` | Saves `[fallback_model] model = <alias>`, enables the `fallback-model` experiment. |
| `/fallback-model-secondary <alias>` | Saves `[fallback_model] secondary_model = <alias>`. |

Both commands open the existing `TabbedModelSelectorComponent` when no alias is supplied as an argument. The picker reuses the `squeeze-model` UI shape.
