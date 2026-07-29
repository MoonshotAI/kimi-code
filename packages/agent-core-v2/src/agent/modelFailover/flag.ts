/**
 * `modelFailover` domain (L4) — registers the runtime model-failover
 * experimental flag into `flag`.
 *
 * Gates automatic cross-model recovery independently from secondary-model
 * spawn routing. Off by default; enabled through the per-feature env value,
 * the master experimental env value, or `[experimental]`.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const MODEL_FAILOVER_FLAG_ID = 'model-failover';
export const MODEL_FAILOVER_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_MODEL_FAILOVER';

export const modelFailoverFlag: FlagDefinitionInput = {
  id: MODEL_FAILOVER_FLAG_ID,
  title: 'Runtime model failover',
  description:
    'Let subagents switch to an ordered fallback model after retry exhaustion or provider quota exhaustion.',
  env: MODEL_FAILOVER_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(modelFailoverFlag);
