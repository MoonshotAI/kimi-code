import { z } from 'zod';

import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const IDENTITY_SECTION = 'identity';

export const IdentityConfigSchema = z.object({
  name: z.string().optional(),
  slug: z.string().optional(),
});

export type IdentityConfig = z.infer<typeof IdentityConfigSchema>;

export const IDENTITY_NAME_ENV = 'KIMI_CODE_IDENTITY_NAME';
export const IDENTITY_SLUG_ENV = 'KIMI_CODE_IDENTITY_SLUG';

function parseIdentityEnv(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const identityEnvBindings: EnvBindings<IdentityConfig> = envBindings(
  IdentityConfigSchema,
  {
    name: { env: IDENTITY_NAME_ENV, parse: parseIdentityEnv },
    slug: { env: IDENTITY_SLUG_ENV, parse: parseIdentityEnv },
  },
);

export const stripIdentityEnv = stripEnvBoundFields(identityEnvBindings);

registerConfigSection(IDENTITY_SECTION, IdentityConfigSchema, {
  defaultValue: {},
  env: identityEnvBindings,
  stripEnv: stripIdentityEnv,
});
