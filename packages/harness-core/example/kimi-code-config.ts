import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse } from 'smol-toml';

export interface KimiCodeDefault {
  readonly home: string;
  readonly key: string;
}

export function loadKimiCodeDefault(): KimiCodeDefault {
  const home = process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
  const path = join(home, 'config.toml');
  const root = asRecord(parse(readFileSync(path, 'utf8')));
  if (root === undefined) {
    throw new Error(`invalid kimi-code config: ${path}`);
  }
  const key =
    process.env['KIMI_MODEL'] ?? asString(root['default_model']) ?? 'free-tokens_kimi/kimi-k3';
  const models = asRecord(root['models']);
  const entry = models === undefined ? undefined : asRecord(models[key]);
  if (entry === undefined) {
    throw new Error(`model '${key}' is not in ${path}`);
  }
  const providerId = asString(entry['provider']);
  if (providerId === undefined) {
    throw new Error(`model '${key}' is missing provider`);
  }
  const providers = asRecord(root['providers']);
  if (providers === undefined || asRecord(providers[providerId]) === undefined) {
    throw new Error(`provider '${providerId}' is not in ${path}`);
  }
  return { home, key };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
