import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { stringify } from 'smol-toml';

export type TomlValue = string | number | boolean | readonly TomlValue[] | { readonly [key: string]: TomlValue };

export interface ProviderConfig {
  readonly type: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly customHeaders?: Readonly<Record<string, string>>;
  readonly extra?: Readonly<Record<string, TomlValue>>;
}

export interface ModelConfig {
  readonly provider: string;
  readonly model: string;
  readonly maxContextSize?: number;
  readonly capabilities?: readonly string[];
  readonly displayName?: string;
  readonly extra?: Readonly<Record<string, TomlValue>>;
}

export interface KimiConfig {
  readonly defaultModel?: string;
  readonly defaultPermissionMode?: 'manual' | 'auto' | 'yolo';
  readonly providers?: Readonly<Record<string, ProviderConfig>>;
  readonly models?: Readonly<Record<string, ModelConfig>>;
  readonly loopControl?: Readonly<Record<string, TomlValue>>;
  readonly hooks?: readonly Readonly<Record<string, TomlValue>>[];
  readonly extra?: Readonly<Record<string, TomlValue>>;
  readonly raw?: string;
}

export function kimiConfigToml(config: KimiConfig): string {
  const document: Record<string, TomlValue> = {};
  if (config.defaultModel !== undefined) document['default_model'] = config.defaultModel;
  if (config.defaultPermissionMode !== undefined) document['default_permission_mode'] = config.defaultPermissionMode;
  Object.assign(document, config.extra);
  if (config.providers !== undefined) document['providers'] = mapValues(config.providers, providerTable);
  if (config.models !== undefined) document['models'] = mapValues(config.models, modelTable);
  if (config.loopControl !== undefined) document['loop_control'] = config.loopControl;
  if (config.hooks !== undefined) document['hooks'] = config.hooks;
  const text = stringify(document);
  const body = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  return config.raw === undefined ? body : `${body}\n${config.raw}\n`;
}

export async function writeKimiConfig(dataDir: string, config: KimiConfig): Promise<string> {
  const path = join(dataDir, 'config.toml');
  await writeFile(path, kimiConfigToml(config), 'utf8');
  return path;
}

export function mergeKimiConfig(base: KimiConfig, override: KimiConfig): KimiConfig {
  return {
    ...base,
    ...override,
    providers: { ...base.providers, ...override.providers },
    models: { ...base.models, ...override.models },
    loopControl: base.loopControl === undefined && override.loopControl === undefined ? undefined : { ...base.loopControl, ...override.loopControl },
    hooks: base.hooks === undefined && override.hooks === undefined ? undefined : [...(base.hooks ?? []), ...(override.hooks ?? [])],
    extra: { ...base.extra, ...override.extra },
    raw: [base.raw, override.raw].filter((part) => part !== undefined).join('\n') || undefined,
  };
}

function providerTable(provider: ProviderConfig): TomlValue {
  const table: Record<string, TomlValue> = { type: provider.type };
  if (provider.baseUrl !== undefined) table['base_url'] = provider.baseUrl;
  if (provider.apiKey !== undefined) table['api_key'] = provider.apiKey;
  if (provider.customHeaders !== undefined) table['custom_headers'] = provider.customHeaders;
  return { ...table, ...provider.extra };
}

function modelTable(model: ModelConfig): TomlValue {
  const table: Record<string, TomlValue> = { provider: model.provider, model: model.model };
  if (model.maxContextSize !== undefined) table['max_context_size'] = model.maxContextSize;
  if (model.capabilities !== undefined) table['capabilities'] = model.capabilities;
  if (model.displayName !== undefined) table['display_name'] = model.displayName;
  return { ...table, ...model.extra };
}

function mapValues<T>(record: Readonly<Record<string, T>>, map: (value: T) => TomlValue): Record<string, TomlValue> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value)]));
}
