import type {
  FlagDefinitionInput,
  FlagId,
} from '@moonshot-ai/agent-core-v2/app/flag/flagRegistry';

export { BETA_MASTER_CONFIG_KEY } from '@moonshot-ai/agent-core-v2/app/flag/flag';
export { MASTER_ENV } from '@moonshot-ai/agent-core-v2/app/flag/flagService';
export type {
  BetaMasterSwitchSource,
  BetaMasterSwitchState,
  ExperimentalFeatureState,
  ExperimentalFlagMap,
  ExperimentalFlagSource,
} from '@moonshot-ai/agent-core-v2/app/flag/flag';
export type {
  ExperimentalEffectTiming,
  ExperimentalStage,
  ExperimentalSurface,
  FlagDefinitionInput,
  FlagId,
  FlagSurface,
} from '@moonshot-ai/agent-core-v2/app/flag/flagRegistry';

export type FlagDefinition = FlagDefinitionInput & { readonly id: FlagId };
