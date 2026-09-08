import { z } from 'zod';

import {
  type ConfigSchema,
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import type { TokenCountingStrategy } from './tokenCounting';

export const TOKEN_COUNTING_SECTION = 'tokenCounting';

export const TOKEN_COUNTING_STRATEGY_ENV = 'KIMI_TOKEN_COUNTING_STRATEGY';

export const TOKEN_COUNTING_STRATEGIES = ['measured+estimated', 'measured', 'estimated'] as const;

export const TokenCountingConfigSchema: ConfigSchema<TokenCountingConfig> = z.object({
  strategy: z.enum(TOKEN_COUNTING_STRATEGIES),
});

export type TokenCountingConfig = {
  readonly strategy: TokenCountingStrategy;
};

function parseStrategy(raw: string): TokenCountingStrategy | undefined {
  const value = raw.trim().toLowerCase();
  return (TOKEN_COUNTING_STRATEGIES as readonly string[]).includes(value)
    ? (value as TokenCountingStrategy)
    : undefined;
}

export const tokenCountingEnvBindings: EnvBindings<TokenCountingConfig> =
  envBindings<TokenCountingConfig>(TokenCountingConfigSchema, {
    strategy: { env: TOKEN_COUNTING_STRATEGY_ENV, parse: parseStrategy },
  });

export const stripTokenCountingEnv = stripEnvBoundFields<TokenCountingConfig>(
  tokenCountingEnvBindings,
);

export const DEFAULT_TOKEN_COUNTING_CONFIG: TokenCountingConfig = {
  strategy: 'measured+estimated',
};

registerConfigSection(TOKEN_COUNTING_SECTION, TokenCountingConfigSchema, {
  defaultValue: DEFAULT_TOKEN_COUNTING_CONFIG,
  env: tokenCountingEnvBindings,
  stripEnv: stripTokenCountingEnv,
});
