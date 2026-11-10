

import { z } from 'zod';

import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import {
  camelToSnake,
  cloneRecord,
  isPlainObject,
  plainObjectToToml,
  setDefined,
  transformPlainObject,
} from '#/app/config/toml';

export const SANDBOX_SECTION = 'sandbox';

export const SandboxModeSchema = z.enum([
  'off',
  'read-only',
  'workspace-write',
  'danger-full-access',
]);

export const SandboxNetworkModeSchema = z.enum(['off', 'allowlist', 'all']);

export const SandboxNetworkSchema = z.object({
  mode: SandboxNetworkModeSchema.optional(),
  allowedDomains: z.array(z.string()).optional(),
  deniedDomains: z.array(z.string()).optional(),
  allowLocalBinding: z.boolean().optional(),
  allowUnixSockets: z.array(z.string()).optional(),
});

export const SandboxConfigSchema = z.object({
  mode: SandboxModeSchema.optional(),
  autoApproveSandboxed: z.boolean().optional(),
  allowUnsandboxedCommands: z.boolean().optional(),
  excludedCommands: z.array(z.string()).optional(),
  writableRoots: z.array(z.string()).optional(),
  readableRoots: z.array(z.string()).optional(),
  denyRead: z.array(z.string()).optional(),
  denyWrite: z.array(z.string()).optional(),
  enableWeakerNestedSandbox: z.boolean().optional(),
  network: SandboxNetworkSchema.optional(),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

export const SANDBOX_MODE_ENV = 'KIMI_CODE_SANDBOX_MODE';

function parseSandboxModeEnv(raw: string): string | undefined {
  const parsed = SandboxModeSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export const sandboxEnvBindings: EnvBindings<SandboxConfig> = envBindings(SandboxConfigSchema, {
  mode: {
    env: SANDBOX_MODE_ENV,
    parse: parseSandboxModeEnv,
  },
});

export const stripSandboxEnv = stripEnvBoundFields(sandboxEnvBindings);

export function resolveSandboxConfig(config: IConfigService): SandboxConfig | undefined {
  return config.get<SandboxConfig | undefined>(SANDBOX_SECTION);
}

const sandboxFromToml = (rawSnake: unknown): unknown => {
  if (!isPlainObject(rawSnake)) return rawSnake;
  const raw = transformPlainObject(rawSnake);
  if (isPlainObject(raw['network'])) {
    raw['network'] = transformPlainObject(raw['network']);
  }
  return raw;
};

const sandboxToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const out = cloneRecord(rawSnake);
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'network' && isPlainObject(entry)) {
      const nested = cloneRecord(isPlainObject(out['network']) ? out['network'] : {});
      setDefined(out, 'network', plainObjectToToml(entry, nested));
    } else {
      setDefined(out, camelToSnake(key), entry);
    }
  }
  return out;
};

registerConfigSection(SANDBOX_SECTION, SandboxConfigSchema, {
  fromToml: sandboxFromToml,
  toToml: sandboxToToml,
  env: sandboxEnvBindings,
  stripEnv: stripSandboxEnv,
});
