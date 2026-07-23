/**
 * `sandbox` domain (L3) — `sandbox` config-section schema and TOML transforms.
 *
 * Owns the `[sandbox]` configuration section (OS-level command sandbox for Bash:
 * enable/mode/fail-closed/excluded commands plus the nested `[sandbox.filesystem]`
 * and `[sandbox.network]` tables), including the snake_case ↔ camelCase TOML
 * transforms for the nested tables. Self-registered at module load via
 * `registerConfigSection`, so the `config` domain never imports this domain's
 * types. `resolveSandboxConfig` reads the section through `IConfigService` and
 * warns once when `network.allowed_domains` is set — the domain allowlist lands
 * in Phase 3; until then only `network.enabled` takes effect.
 */

import { z } from 'zod';

import { type IConfigService } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import {
  cloneRecord,
  isPlainObject,
  plainObjectToToml,
  transformPlainObject,
} from '#/app/config/toml';

import type { SandboxConfig } from './sandboxTypes';

export const SANDBOX_SECTION = 'sandbox';

export const SandboxModeSchema = z.enum(['workspace-write', 'read-only']);

export const SandboxFilesystemConfigSchema = z.object({
  denyRead: z.array(z.string()).optional(),
  allowWrite: z.array(z.string()).optional(),
  denyWrite: z.array(z.string()).optional(),
});

export const SandboxNetworkConfigSchema = z.object({
  enabled: z.boolean().optional(),
  allowedDomains: z.array(z.string()).optional(),
  allowUnixSockets: z.array(z.string()).optional(),
});

export const SandboxConfigSchema = z.object({
  enabled: z.boolean().optional(),
  mode: SandboxModeSchema.optional(),
  require: z.boolean().optional(),
  autoAllowSandboxedBash: z.boolean().optional(),
  excludedCommands: z.array(z.string()).optional(),
  filesystem: SandboxFilesystemConfigSchema.optional(),
  network: SandboxNetworkConfigSchema.optional(),
});

export const sandboxFromToml = (rawSnake: unknown): unknown => {
  if (!isPlainObject(rawSnake)) return rawSnake;
  const raw = transformPlainObject(rawSnake);
  if (isPlainObject(raw['filesystem'])) {
    raw['filesystem'] = transformPlainObject(raw['filesystem']);
  }
  if (isPlainObject(raw['network'])) {
    raw['network'] = transformPlainObject(raw['network']);
  }
  return raw;
};

export const sandboxToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const nested = cloneRecord(value);
  if (isPlainObject(nested['filesystem'])) {
    nested['filesystem'] = plainObjectToToml(nested['filesystem'], undefined);
  }
  if (isPlainObject(nested['network'])) {
    nested['network'] = plainObjectToToml(nested['network'], undefined);
  }
  return plainObjectToToml(nested, rawSnake);
};

let warnedAllowedDomains = false;

export function resolveSandboxConfig(config: IConfigService): SandboxConfig | undefined {
  const section = config.get<SandboxConfig | undefined>(SANDBOX_SECTION);
  const allowedDomains = section?.network?.allowedDomains;
  if (!warnedAllowedDomains && allowedDomains !== undefined && allowedDomains.length > 0) {
    warnedAllowedDomains = true;
    console.warn(
      '[sandbox] network.allowed_domains 尚未生效（Phase 3 实现域名白名单代理）；当前网络策略只认 network.enabled。',
    );
  }
  return section;
}

registerConfigSection(SANDBOX_SECTION, SandboxConfigSchema, {
  fromToml: sandboxFromToml,
  toToml: sandboxToToml,
});
