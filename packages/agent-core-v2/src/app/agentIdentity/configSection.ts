/**
 * `agentIdentity` domain — the `[identity]` config section.
 *
 * Owns the user-facing custom-identity preference: `name`, the display name in
 * the system prompt, and the optional `slug` that goes into protocol fields.
 * Both bind to `KIMI_CODE_IDENTITY_NAME` / `KIMI_CODE_IDENTITY_SLUG` so a
 * container or CI run can state an identity without writing `config.toml`; an
 * env override never persists back into the file. Leaving the section unset
 * means no custom identity, and every consumer keeps its current behavior.
 *
 * Unlike most sections this one is read exactly once: `agentIdentity` freezes
 * its snapshot when config first loads, so edits apply on the next start —
 * see the domain contract for why mid-process changes cannot be honored.
 *
 * Self-registered at module load via `registerConfigSection`.
 */

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
