/**
 * Local provider-config harness — the trimmed replacement for the SDK
 * `createKimiHarness` surface that `sub/provider.ts` consumes (G-1 CLI
 * consumption cutover). Only the four config methods the `kimi provider`
 * command needs are implemented; sessions / auth / telemetry stay out of
 * scope.
 *
 * config.toml semantics mirror the SDK legacy writer (node-sdk legacy/config):
 * - reads are lenient (salvage what parses, like `loadRuntimeConfigSafe`);
 * - writes are strict — a syntax-invalid file is refused with an actionable
 *   error, never silently rewritten;
 * - `setConfig` deep-merges the patch onto the on-disk config, skipping
 *   `undefined`/`null` values (only `removeProvider` can delete keys);
 * - `removeProvider` drops the provider section, every model alias that
 *   referenced it, and `default_model` when it pointed at a removed alias;
 * - key conversion is snake_case on disk ↔ camelCase in memory, with the
 *   `source` block's nested keys kept as-is (legacy writer parity).
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import type { KimiHostIdentity } from '#/cli/oauth-local';
import {
  loadRuntimeConfigSafe,
  resolveConfigPath,
  resolveKimiHome,
} from '#/cli/runtime-config';

/** The `source` blob persisted on each imported provider (registry imports). */
export interface KimiProviderSource {
  kind?: string;
  url?: string;
  apiKey?: string;
  [key: string]: unknown;
}

/** A single `[providers.<id>]` entry (subset of the SDK `ProviderConfig`). */
export interface KimiProviderConfig {
  type?: string;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  source?: KimiProviderSource;
  oauth?: Record<string, unknown>;
  env?: Record<string, string>;
  customHeaders?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A single `[models.<alias>]` entry (subset of the SDK `ModelAlias`). */
export interface KimiModelAlias {
  provider: string;
  model?: string;
  maxContextSize?: number;
  capabilities?: readonly string[];
  [key: string]: unknown;
}

/** The consumed config surface (subset of the SDK `KimiConfig`). */
export interface KimiConfig {
  providers: Record<string, KimiProviderConfig>;
  models?: Record<string, KimiModelAlias>;
  defaultModel?: string;
  thinking?: { enabled?: boolean } & Record<string, unknown>;
  [key: string]: unknown;
}

/** The harness surface `sub/provider.ts` consumes (subset of the SDK `KimiHarness`). */
export interface KimiHarness {
  ensureConfigFile(): Promise<void>;
  getConfig(): Promise<KimiConfig>;
  setConfig(patch: Partial<KimiConfig>): Promise<KimiConfig>;
  removeProvider(providerId: string): Promise<KimiConfig>;
}

export interface CreateKimiHarnessOptions {
  readonly identity?: KimiHostIdentity;
  readonly homeDir?: string;
  readonly configPath?: string;
}

const DEFAULT_CONFIG_FILE_TEXT = `# ~/.kimi-code/config.toml
# Runtime settings for Kimi Code.
# This file starts empty so built-in defaults can apply.
# Login will populate managed Kimi provider and model entries.
`;

class ProviderConfigHarness implements KimiHarness {
  constructor(private readonly configPath: string) {}

  async ensureConfigFile(): Promise<void> {
    mkdirSync(dirname(this.configPath), { recursive: true, mode: 0o700 });
    if (existsSync(this.configPath)) return;
    writeFileSync(this.configPath, DEFAULT_CONFIG_FILE_TEXT, { encoding: 'utf-8', mode: 0o600 });
  }

  async getConfig(): Promise<KimiConfig> {
    const loaded = loadRuntimeConfigSafe(this.configPath);
    // The SDK's lenient reader starts from defaults (`providers: {}`); the
    // local port starts from `{}` — normalize so callers can index
    // `config.providers` unconditionally.
    return { providers: {}, ...loaded.config } as KimiConfig;
  }

  async setConfig(patch: Partial<KimiConfig>): Promise<KimiConfig> {
    const raw = readConfigForWrite(this.configPath);
    const merged = deepMerge(raw, toSnakePatch(patch as Record<string, unknown>));
    writeConfigFile(this.configPath, merged);
    return toCamelConfig(merged);
  }

  async removeProvider(providerId: string): Promise<KimiConfig> {
    const raw = readConfigForWrite(this.configPath);
    const providers = isRecord(raw['providers']) ? raw['providers'] : undefined;
    if (providers !== undefined) {
      delete providers[providerId];
    }
    const models = isRecord(raw['models']) ? raw['models'] : undefined;
    let removedDefault = false;
    if (models !== undefined) {
      for (const [alias, model] of Object.entries(models)) {
        if (isRecord(model) && model['provider'] === providerId) {
          delete models[alias];
          if (raw['default_model'] === alias) removedDefault = true;
        }
      }
    }
    if (removedDefault) {
      delete raw['default_model'];
    }
    writeConfigFile(this.configPath, raw);
    return toCamelConfig(raw);
  }
}

/**
 * Create the local provider-config harness. `identity` is accepted for call
 * parity with the SDK factory but unused here — this harness only does
 * config-file I/O.
 */
export function createKimiHarness(options: CreateKimiHarnessOptions = {}): KimiHarness {
  const homeDir = resolveKimiHome(options.homeDir);
  const configPath = resolveConfigPath({ homeDir, configPath: options.configPath });
  return new ProviderConfigHarness(configPath);
}

/* ------------------------------------------------------------------ */
/*  config.toml read / write                                           */
/* ------------------------------------------------------------------ */

/**
 * Strict read for write paths (read-merge-write must never use a salvaged
 * config as its base, or the rewrite would drop the user's broken-but-fixable
 * sections). A syntax-invalid file is refused with the same actionable
 * message the SDK's `readConfigFileForUpdate` produces.
 */
function readConfigForWrite(filePath: string): Record<string, unknown> {
  const text = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  if (text.trim().length === 0) return {};
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Cannot change settings while ${filePath} is invalid — fix it first (run \`kimi doctor\` for details).`,
    );
  }
}

/** Atomic write (temp file + rename, Windows-safe), mirroring the legacy writer. */
function writeConfigFile(filePath: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const hex = randomBytes(4).toString('hex');
  const tmpPath = `${filePath}.tmp.${process.pid}.${hex}`;
  let renamed = false;
  try {
    writeFileSync(tmpPath, `${stringifyToml(data)}\n`, { encoding: 'utf-8', mode: 0o600 });
    // Windows `fs.rename` maps to MoveFileEx and fails with EPERM if the
    // target is held by another handle; pre-unlinking turns this into the
    // POSIX-style "replace" case.
    if (process.platform === 'win32') {
      try {
        unlinkSync(filePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw error;
      }
    }
    renameSync(tmpPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Ignore — the temp file may not exist if the write itself failed.
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  camelCase ↔ snake_case conversion                                  */
/* ------------------------------------------------------------------ */

function snakeToCamel(str: string): string {
  return str.replaceAll(/_([a-z])/g, (_match, ch: string) => ch.toUpperCase());
}

function camelToSnake(str: string): string {
  return str.replaceAll(/[A-Z]/g, (ch: string) => `_${ch.toLowerCase()}`);
}

/**
 * Deep-merge a config patch onto a base (objects merge recursively; other
 * values replace). `undefined`/`null` patch values keep the base — the same
 * semantics as the SDK's `deepMergeConfig`.
 */
function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) continue;
    const existing = out[key];
    if (isRecord(value) && isRecord(existing)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** camelCase patch → snake_case tree, ready to merge onto the raw parse. */
function toSnakePatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    const snakeKey = camelToSnake(key);
    if ((snakeKey === 'providers' || snakeKey === 'models') && isRecord(value)) {
      // Provider/model ids are opaque — key-transform only the entry values.
      const entries: Record<string, unknown> = {};
      for (const [id, entry] of Object.entries(value)) {
        entries[id] = snakeKey === 'providers' ? toSnakeProvider(entry) : toSnakeTree(entry);
      }
      out[snakeKey] = entries;
    } else {
      out[snakeKey] = toSnakeTree(value);
    }
  }
  return out;
}

/** Provider entry conversion (legacy `providerToToml` parity). */
function toSnakeProvider(value: unknown): unknown {
  if (!isRecord(value)) return toSnakeTree(value);
  const out: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (entryValue === undefined) continue;
    if (key === 'apiKey') {
      // A non-empty key is persisted as `api_key`; an explicit empty string
      // never clobbers a real key on disk.
      if (entryValue !== '') out['api_key'] = entryValue;
      continue;
    }
    if (key === 'source') {
      // The `source` blob's nested keys are kept as-is (legacy parity).
      out['source'] = entryValue;
      continue;
    }
    if (key === 'oauth') {
      out['oauth'] = toSnakeTree(entryValue);
      continue;
    }
    if (key === 'env' || key === 'customHeaders') {
      out[key] = entryValue;
      continue;
    }
    out[camelToSnake(key)] = toSnakeTree(entryValue);
  }
  return out;
}

/** Recursive camelCase → snake_case (arrays and scalars pass through). */
function toSnakeTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnakeTree);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (entryValue === undefined) continue;
    out[camelToSnake(key)] = toSnakeTree(entryValue);
  }
  return out;
}

/** Raw snake_case tree → camelCase config surface. */
function toCamelConfig(data: Record<string, unknown>): KimiConfig {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const camelKey = snakeToCamel(key);
    if ((camelKey === 'providers' || camelKey === 'models') && isRecord(value)) {
      const entries: Record<string, unknown> = {};
      for (const [id, entry] of Object.entries(value)) {
        entries[id] = toCamelTree(entry);
      }
      out[camelKey] = entries;
    } else {
      out[camelKey] = toCamelTree(value);
    }
  }
  return { providers: {}, ...out } as KimiConfig;
}

/** Recursive snake_case → camelCase (arrays and scalars pass through). */
function toCamelTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCamelTree);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (entryValue === undefined) continue;
    out[snakeToCamel(key)] = toCamelTree(entryValue);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
