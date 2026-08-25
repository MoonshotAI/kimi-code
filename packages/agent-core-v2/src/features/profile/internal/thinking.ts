import { THINKING_SECTION } from '#/app/kosongConfig/configSection';
import { IConfigService } from '#/app/config/config';
import type { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import type { Model } from '#/kosong/model/catalog';
import type { ThinkingEffort } from '#/kosong/contract/provider';
import {
  drivesThinkingThroughTraits,
  modelSupportsThinkingEffort,
  normalizeRequestedThinkingEffort,
  resolveForcedThinkingEffort,
  resolveThinkingEffortForModel,
  requiresStrictThinkingValidation,
  type ThinkingConfig,
} from '#/kosong/model/thinking';

import { ProfileError, ProfileErrors } from '../errors';

export interface ThinkingDeps {
  readonly config: IConfigService;
  readonly protocolAdapters: IProtocolAdapterRegistry;
}

export function strictThinkingValidation(deps: ThinkingDeps, model: Model | undefined): boolean {
  if (model === undefined) return false;
  return requiresStrictThinkingValidation(
    deps.protocolAdapters,
    model.protocol,
    model.providerType,
  );
}

export function resolveThinkingEffort(
  deps: ThinkingDeps,
  requested: string | undefined,
  model: Model | undefined,
): ThinkingEffort {
  return resolveThinkingEffortForModel(
    requested,
    deps.config.get<ThinkingConfig>(THINKING_SECTION),
    model,
    strictThinkingValidation(deps, model),
  );
}

export function supportsThinkingEffort(
  deps: ThinkingDeps,
  effort: ThinkingEffort,
  model: Model | undefined,
): boolean {
  return modelSupportsThinkingEffort(effort, model, strictThinkingValidation(deps, model));
}

export function assertThinkingEffortSupported(
  deps: ThinkingDeps,
  requested: string,
  model: Model | undefined,
  modelAlias: string,
): void {
  const normalized = normalizeRequestedThinkingEffort(requested);
  if (normalized === undefined || supportsThinkingEffort(deps, normalized, model)) return;
  const efforts = model?.supportEfforts ?? [];
  const supported = efforts.length === 0 ? 'off' : ['off', ...efforts].join(', ');
  throw new ProfileError(
    ProfileErrors.codes.MODEL_CONFIG_INVALID,
    `Thinking effort "${requested}" is not supported by model "${modelAlias}". Supported efforts: ${supported}.`,
  );
}

export function resolveThinkingState(
  deps: ThinkingDeps,
  base: ThinkingEffort,
  model: Model | undefined,
): {
  readonly effective: ThinkingEffort;
  readonly forced: ThinkingEffort | undefined;
} {
  const forced = resolveForcedThinkingEffort(
    deps.config.get<ThinkingConfig>(THINKING_SECTION)?.forcedEffort,
    base,
    drivesThinkingThroughTraits(model?.providerType),
  );
  return { effective: forced ?? base, forced };
}

export function anthropicThinkingEffortWarning(
  model: Model | undefined,
  effort: ThinkingEffort,
): { readonly code: string; readonly message: string; readonly key: string } | undefined {
  if (model?.protocol !== 'anthropic') return undefined;
  if (effort === 'on' || effort === 'off') return undefined;
  const efforts = model.supportEfforts?.filter((value) => value.length > 0);
  if (efforts === undefined || efforts.length === 0 || efforts.includes(effort)) return undefined;
  const code = 'anthropic-thinking-effort-not-listed';
  const message = `Thinking effort "${effort}" is not listed for model "${model.name}" (known: ${efforts.join(', ')}). The configured value will be sent unchanged to the Anthropic-compatible backend.`;
  const key = [code, model.id, model.name, effort, efforts.join(',')].join('\u0000');
  return { code, message, key };
}
