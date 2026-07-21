/**
 * `subagent` domain (L6) — registers the `dual-model-routing` experimental
 * flag into `flag`.
 *
 * Gates dual-model routing: when enabled, delegated subagents run on a
 * dedicated subagent model + thinking effort (configurable via session
 * metadata override or `[subagent]` config defaults) instead of inheriting
 * the main agent's model. Off by default; enable via
 * `KIMI_CODE_EXPERIMENTAL_DUAL_MODEL_ROUTING`, the master
 * `KIMI_CODE_EXPERIMENTAL_FLAG`, or the `[experimental]` config section.
 * Imported for its side effect (registers the definition) from the package
 * barrel.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const DUAL_MODEL_ROUTING_FLAG_ID = 'dual-model-routing';
export const DUAL_MODEL_ROUTING_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_DUAL_MODEL_ROUTING';

export const dualModelRoutingFlag: FlagDefinitionInput = {
  id: DUAL_MODEL_ROUTING_FLAG_ID,
  title: 'Dual model routing (separate subagent model)',
  description:
    'Route the main agent and its subagents to different models. Subagents use a dedicated subagent model (configurable via /model) instead of inheriting the main agent model. When disabled, subagents inherit the main model as before.',
  env: DUAL_MODEL_ROUTING_FLAG_ENV,
  default: false,
  surface: 'both',
};

registerFlagDefinition(dualModelRoutingFlag);
