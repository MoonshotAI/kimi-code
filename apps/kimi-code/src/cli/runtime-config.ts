/**
 * Local runtime config helpers — ported (trimmed) from
 * `@moonshot-ai/kimi-code-sdk` `legacy/config.ts` (G-1 CLI consumption
 * cutover). The full SDK chain (salvage/env overrides) is not needed: the
 * TS host reads only the fields it consumes (native-LLM provider, hooks,
 * default model, telemetry) and degrades to defaults on any parse error.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parse } from 'smol-toml';

/** Resolve the Kimi Code home directory (v1 `config/path.ts` semantics). */
export function resolveKimiHome(homeDir?: string | undefined): string {
  return homeDir ?? process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code');
}

/** Resolve the config.toml path (forward slashes, stable across hosts). */
export function resolveConfigPath(input: {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
}): string {
  return (input.configPath ?? join(resolveKimiHome(input.homeDir), 'config.toml')).replaceAll(
    '\\',
    '/',
  );
}

/** The consumed config surface (subset of the SDK `KimiConfig`). */
export interface RuntimeConfig {
  defaultModel?: string;
  telemetry?: boolean;
  providers?: Record<string, Record<string, unknown>>;
  models?: Record<string, Record<string, unknown>>;
  hooks?: readonly { name?: string; [key: string]: unknown }[];
  agent?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RuntimeConfigLoadResult {
  readonly config: RuntimeConfig;
  readonly fileWarnings: readonly string[];
  readonly envWarnings: readonly string[];
  readonly fileError?: Error;
}

/** TOML config -> camelCase config for the sections the host reads. */
function transformConfig(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'providers' && isPlainObject(value)) {
      out[targetKey] = transformRecord(value, transformProviderData);
    } else if (targetKey === 'models' && isPlainObject(value)) {
      out[targetKey] = transformRecord(value, transformModelData);
    } else if (targetKey === 'agent' && isPlainObject(value)) {
      out[targetKey] = transformPlainObject(value);
    } else {
      out[targetKey] = value;
    }
  }
  return out;
}

function transformRecord(
  data: Record<string, unknown>,
  transform: (value: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = isPlainObject(value) ? transform(value) : value;
  }
  return out;
}

function transformProviderData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'env' || targetKey === 'customHeaders') {
      out[targetKey] = value;
    } else {
      out[targetKey] = value;
    }
  }
  return out;
}

function transformModelData(data: Record<string, unknown>): Record<string, unknown> {
  const out = transformPlainObject(data);
  if (isPlainObject(out['overrides'])) {
    out['overrides'] = transformPlainObject(out['overrides']);
  }
  return out;
}

function transformPlainObject(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[snakeToCamel(key)] = value;
  }
  return out;
}

function snakeToCamel(str: string): string {
  return str.replaceAll(/_([a-z])/g, (_match, ch: string) => ch.toUpperCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read and parse the config file without ever throwing. `fileError` is set
 * when the file is unreadable or the TOML is invalid; the config degrades to
 * defaults (the engine itself is authoritative for full validation).
 */
export function loadRuntimeConfigSafe(filePath: string): RuntimeConfigLoadResult {
  const fileWarnings: string[] = [];
  let fileError: Error | undefined;
  let config: Record<string, unknown> = {};

  let text: string | undefined;
  try {
    text = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : undefined;
  } catch (error) {
    fileError = error instanceof Error ? error : new Error(String(error));
    fileWarnings.push(`Failed to read ${filePath}: ${fileError.message}.`);
  }

  if (text !== undefined && text.trim().length > 0) {
    try {
      config = transformConfig(parse(text) as Record<string, unknown>);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fileError = new Error(`Invalid TOML in ${filePath}: ${message}`);
      fileWarnings.push(`Invalid TOML in ${filePath}: ${message}.`);
    }
  }

  return { config, fileWarnings, envWarnings: [], fileError };
}
