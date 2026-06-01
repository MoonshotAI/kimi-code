import { existsSync, readFileSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'pathe';

import { ErrorCodes, KimiError } from '#/errors';
import { applyEnvModelConfig, stripEnvModelConfig } from './env-model';
import {
  KimiConfigSchema,
  formatConfigValidationError,
  getDefaultConfig,
  type BackgroundConfig,
  type HookDefConfig,
  type KimiConfig,
  type LoopControl,
  type ModelAlias,
  type MoonshotServiceConfig,
  type OAuthRef,
  type PermissionConfig,
  type ProviderConfig,
  type ServicesConfig,
  type ThinkingConfig,
  validateConfig,
} from '#/config/schema';
import { atomicWrite } from '#/utils/fs';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

/* ------------------------------------------------------------------ */
/*  Key helpers – reuse generic snake / camel conversion instead of    */
/*  maintaining per-section *_KEY_MAP tables.                         */
/* ------------------------------------------------------------------ */

function snakeToCamel(str: string): string {
  return str.replaceAll(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function camelToSnake(str: string): string {
  return str.replaceAll(/[A-Z]/g, (ch: string) => `_${ch.toLowerCase()}`);
}

/* ------------------------------------------------------------------ */
/*  Read / parse                                                       */
/* ------------------------------------------------------------------ */

const DEFAULT_CONFIG_FILE_TEXT = `# ~/.kimi-code/config.toml
# Runtime settings for Kimi Code.
# This file starts empty so built-in defaults can apply.
# Login will populate managed Kimi provider and model entries.
`;

export async function ensureConfigFile(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, 'wx', 0o600);
    await handle.writeFile(DEFAULT_CONFIG_FILE_TEXT, 'utf-8');
  } catch (error) {
    if (isFileExistsError(error)) return;
    throw error;
  } finally {
    await handle?.close();
  }
}

export function readConfigFile(filePath: string): KimiConfig {
  if (!existsSync(filePath)) {
    return getDefaultConfig();
  }
  const text = readFileSync(filePath, 'utf-8');
  return parseConfigString(text, filePath);
}

/**
 * Load the config for runtime consumption: the on-disk config plus any model
 * synthesized from `KIMI_MODEL_*` environment variables. Use this everywhere a
 * value is assigned to the live runtime config; use the raw `readConfigFile`
 * for write-back paths so the synthesized model is never persisted.
 */
export function loadRuntimeConfig(
  filePath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): KimiConfig {
  return applyEnvModelConfig(readConfigFile(filePath), env);
}

export function parseConfigString(tomlText: string, filePath = 'config.toml'): KimiConfig {
  if (tomlText.trim().length === 0) {
    return getDefaultConfig();
  }

  let data: Record<string, unknown>;
  try {
    data = parseToml(tomlText) as Record<string, unknown>;
  } catch (error) {
    throw new KimiError(ErrorCodes.CONFIG_INVALID, `Invalid TOML in ${filePath}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  return parseConfigData(data, filePath);
}

function parseConfigData(data: Record<string, unknown>, filePath: string): KimiConfig {
  const raw = cloneRecord(data);
  const transformed = transformTomlData(data);
  transformed['raw'] = raw;

  try {
    return KimiConfigSchema.parse(transformed);
  } catch (error) {
    throw new KimiError(ErrorCodes.CONFIG_INVALID, `Invalid configuration in ${filePath}: ${formatConfigValidationError(error)}`, {
      cause: error,
    });
  }
}

export function transformTomlData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);

    if (targetKey === 'providers' && isPlainObject(value)) {
      result[targetKey] = transformRecord(value, transformProviderData);
    } else if (targetKey === 'models' && isPlainObject(value)) {
      result[targetKey] = transformRecord(value, transformModelData);
    } else if (targetKey === 'thinking' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'permission' && isPlainObject(value)) {
      result[targetKey] = transformPermissionData(value);
    } else if (targetKey === 'services' && isPlainObject(value)) {
      result[targetKey] = transformRecord(value, transformServiceData, snakeToCamel);
    } else if (targetKey === 'loopControl' && isPlainObject(value)) {
      result[targetKey] = transformLoopControlData(value);
    } else if (targetKey === 'background' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (!isPlainObject(value)) {
      result[targetKey] = value;
    }
  }
  return result;
}

function transformRecord(
  value: Record<string, unknown>,
  transformEntry: (entry: Record<string, unknown>) => Record<string, unknown>,
  transformName: (name: string) => string = (name) => name,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [entryName, entryConfig] of Object.entries(value)) {
    record[transformName(entryName)] = isPlainObject(entryConfig)
      ? transformEntry(entryConfig)
      : entryConfig;
  }
  return record;
}

function transformPlainObject(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[snakeToCamel(key)] = value;
  }
  return out;
}

function transformProviderData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'oauth') {
      out[targetKey] = isPlainObject(value) ? transformPlainObject(value) : value;
    } else if (targetKey === 'env' || targetKey === 'customHeaders') {
      out[targetKey] = cloneObjectValue(value);
    } else {
      out[targetKey] = value;
    }
  }
  return out;
}

function transformModelData(data: Record<string, unknown>): Record<string, unknown> {
  return transformPlainObject(data);
}

function transformPermissionData(data: Record<string, unknown>): Record<string, unknown> {
  const raw = transformPlainObject(data);
  const out: Record<string, unknown> = {};

  const rules: unknown[] = [];
  appendPermissionRules(rules, raw['rules']);
  appendPermissionRules(rules, raw['deny'], 'deny');
  appendPermissionRules(rules, raw['allow'], 'allow');
  appendPermissionRules(rules, raw['ask'], 'ask');
  if (rules.length > 0) {
    out['rules'] = rules;
  }
  return out;
}

function appendPermissionRules(
  target: unknown[],
  value: unknown,
  decision?: 'allow' | 'deny' | 'ask',
): void {
  if (value === undefined) return;
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    target.push(transformPermissionRule(entry, decision));
  }
}

function transformPermissionRule(value: unknown, decision?: 'allow' | 'deny' | 'ask'): unknown {
  if (!isPlainObject(value)) return value;

  const rule = transformPlainObject(value);
  const tool = rule['tool'];
  const match = rule['match'];
  const pattern = rule['pattern'];
  const out: Record<string, unknown> = {};

  if (decision !== undefined) {
    out['decision'] = decision;
  } else {
    out['decision'] = rule['decision'];
  }
  out['scope'] = rule['scope'];
  out['reason'] = rule['reason'];

  if (typeof tool === 'string') {
    const argPattern = typeof match === 'string' ? match : pattern;
    out['pattern'] = typeof argPattern === 'string' ? `${tool}(${argPattern})` : tool;
  } else {
    out['pattern'] = pattern;
  }

  return out;
}

function transformServiceData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'oauth') {
      out[targetKey] = isPlainObject(value) ? transformPlainObject(value) : value;
    } else if (targetKey === 'customHeaders') {
      out[targetKey] = cloneObjectValue(value);
    } else {
      out[targetKey] = value;
    }
  }
  return out;
}

function transformLoopControlData(data: Record<string, unknown>): Record<string, unknown> {
  const out = transformPlainObject(data);
  if (out['maxStepsPerTurn'] === undefined && out['maxStepsPerRun'] !== undefined) {
    out['maxStepsPerTurn'] = out['maxStepsPerRun'];
  }
  delete out['maxStepsPerRun'];
  return out;
}

/* ------------------------------------------------------------------ */
/*  Write / stringify                                                  */
/* ------------------------------------------------------------------ */

export async function writeConfigFile(filePath: string, config: KimiConfig): Promise<void> {
  // Final guard: never persist the env-synthesized model/provider to disk,
  // even if a caller passes back the runtime config as a patch (see
  // stripEnvModelConfig / the getConfig -> setConfig round-trip).
  const validated = validateConfig(stripEnvModelConfig(config));
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await atomicWrite(filePath, `${stringifyToml(configToTomlData(validated))}\n`);
}

export function configToTomlData(config: KimiConfig): Record<string, unknown> {
  const out = cloneRecord(config.raw);

  // Strip deprecated fields
  delete out['default_yolo'];
  delete out['defaultYolo'];
  delete out['defaultPermissionMode'];

  // Top-level scalar fields
  const scalarFields: (keyof KimiConfig)[] = [
    'defaultProvider',
    'defaultModel',
    'planMode',
    'yolo',
    'defaultThinking',
    'defaultPermissionMode',
    'defaultPlanMode',
    'mergeAllAvailableSkills',
    'extraSkillDirs',
    'telemetry',
  ];
  for (const key of scalarFields) {
    setDefined(out, camelToSnake(key), config[key]);
  }

  setRecordSection(out, 'providers', config.providers, providerToToml);
  setRecordSection(out, 'models', config.models, modelToToml);
  setSection(out, 'thinking', config.thinking, thinkingToToml);
  setSection(out, 'services', config.services, servicesToToml);
  setSection(out, 'loop_control', config.loopControl, loopControlToToml);
  setSection(out, 'background', config.background, backgroundToToml);
  setSection(out, 'permission', config.permission, permissionToToml);
  setHooks(out, config.hooks);

  return out;
}

function setRecordSection<T>(
  out: Record<string, unknown>,
  snakeKey: string,
  value: Record<string, T> | undefined,
  toToml: (v: T, raw: unknown) => Record<string, unknown>,
): void {
  if (value === undefined) {
    delete out[snakeKey];
    return;
  }

  const rawSub = cloneRecord(out[snakeKey]);
  const converted: Record<string, unknown> = {};
  for (const [entryName, entryConfig] of Object.entries(value)) {
    converted[entryName] = toToml(entryConfig, rawSub[entryName]);
  }

  if (Object.keys(converted).length > 0) {
    out[snakeKey] = converted;
  } else {
    delete out[snakeKey];
  }
}

function setSection<T>(
  out: Record<string, unknown>,
  snakeKey: string,
  value: T | undefined,
  toToml: (v: T, raw: unknown) => Record<string, unknown>,
): void {
  if (value === undefined) {
    delete out[snakeKey];
    return;
  }
  const rawSub = cloneRecord(out[snakeKey]);
  const converted = toToml(value, rawSub);
  if (Object.keys(converted).length > 0) {
    out[snakeKey] = converted;
  } else {
    delete out[snakeKey];
  }
}

function providerToToml(provider: ProviderConfig, rawProvider: unknown): Record<string, unknown> {
  const out = cloneRecord(rawProvider);
  for (const [key, value] of Object.entries(provider)) {
    if (key === 'oauth' && value !== undefined) {
      out[camelToSnake(key)] = oauthToToml(value as OAuthRef);
    } else if ((key === 'env' || key === 'customHeaders') && value !== undefined) {
      out[camelToSnake(key)] = cloneUnknown(value);
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

function modelToToml(model: ModelAlias, rawModel: unknown): Record<string, unknown> {
  const out = cloneRecord(rawModel);
  for (const [key, value] of Object.entries(model)) {
    if (key === 'capabilities' && Array.isArray(value)) {
      out[camelToSnake(key)] = [...value];
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

function thinkingToToml(thinking: ThinkingConfig, rawThinking: unknown): Record<string, unknown> {
  const out = cloneRecord(rawThinking);
  for (const [key, value] of Object.entries(thinking)) {
    setDefined(out, camelToSnake(key), value);
  }
  return out;
}

function permissionToToml(
  permission: PermissionConfig,
  rawPermission: unknown,
): Record<string, unknown> {
  const out = cloneRecord(rawPermission);
  delete out['deny'];
  delete out['allow'];
  delete out['ask'];

  if (permission.rules !== undefined) {
    out['rules'] = permission.rules.map(permissionRuleToToml);
  } else {
    delete out['rules'];
  }
  return out;
}

function permissionRuleToToml(
  rule: NonNullable<PermissionConfig['rules']>[number],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rule)) {
    setDefined(out, camelToSnake(key), value);
  }
  return out;
}

function servicesToToml(services: ServicesConfig, rawServices: unknown): Record<string, unknown> {
  const out = cloneRecord(rawServices);
  if (services.moonshotSearch !== undefined) {
    out['moonshot_search'] = serviceToToml(services.moonshotSearch);
  } else {
    delete out['moonshot_search'];
  }
  if (services.moonshotFetch !== undefined) {
    out['moonshot_fetch'] = serviceToToml(services.moonshotFetch);
  } else {
    delete out['moonshot_fetch'];
  }
  return out;
}

function serviceToToml(service: MoonshotServiceConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(service)) {
    if (key === 'oauth' && value !== undefined) {
      out[camelToSnake(key)] = oauthToToml(value as OAuthRef);
    } else if (key === 'customHeaders' && value !== undefined) {
      out[camelToSnake(key)] = cloneUnknown(value);
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

function loopControlToToml(
  loopControl: LoopControl,
  rawLoopControl: unknown,
): Record<string, unknown> {
  const out = cloneRecord(rawLoopControl);
  for (const [key, value] of Object.entries(loopControl)) {
    setDefined(out, camelToSnake(key), value);
  }
  return out;
}

function backgroundToToml(
  background: BackgroundConfig,
  rawBackground: unknown,
): Record<string, unknown> {
  const out = cloneRecord(rawBackground);
  for (const [key, value] of Object.entries(background)) {
    setDefined(out, camelToSnake(key), value);
  }
  return out;
}

function setHooks(out: Record<string, unknown>, hooks: readonly HookDefConfig[] | undefined): void {
  if (hooks === undefined) {
    delete out['hooks'];
    return;
  }
  out['hooks'] = hooks.map(hookToToml);
}

function hookToToml(hook: HookDefConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(hook)) {
    setDefined(out, camelToSnake(key), value);
  }
  return out;
}

function oauthToToml(oauth: OAuthRef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(oauth)) {
    out[camelToSnake(key)] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Utilities                                                          */
/* ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  return cloneUnknown(value);
}

function cloneUnknown<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneObjectValue(value: unknown): unknown {
  return isPlainObject(value) ? cloneUnknown(value) : value;
}

function setDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  } else {
    delete target[key];
  }
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}
