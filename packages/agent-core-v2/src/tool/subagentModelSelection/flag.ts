/**
 * `subagentModelSelection` domain (L3) — registers the experimental flag.
 *
 * Gates the model directory and model parameter exposed by Agent and
 * AgentSwarm. Off by default; enable through the dedicated environment
 * variable, the master experimental switch, or the experimental config.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const SUBAGENT_MODEL_SELECTION_FLAG_ID = 'subagent-model-selection';
export const SUBAGENT_MODEL_SELECTION_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SUBAGENT_MODEL_SELECTION';

export const subagentModelSelectionFlag: FlagDefinitionInput = {
  id: SUBAGENT_MODEL_SELECTION_FLAG_ID,
  title: 'Subagent model selection',
  description:
    'Expose configured model aliases to collaboration tools and allow Agent and AgentSwarm to select a model for delegated work.',
  env: SUBAGENT_MODEL_SELECTION_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(subagentModelSelectionFlag);
