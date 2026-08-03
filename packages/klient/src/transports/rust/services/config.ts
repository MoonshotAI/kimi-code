/**
 * G1 — `configService` + `bootstrapService` for the rust transport.
 *
 * Host-side implementation (no rust-loop RPC): the effective config is read
 * through node-sdk's public `loadRuntimeConfigSafe` / `resolveConfigPath`
 * (lenient load, `KIMI_MODEL_*` env overlay, diagnostics on the side), and
 * `set`/`replace` persist `config.toml` through a small local port of
 * node-sdk's `legacy/config.ts` TOML read/write (camelCase KimiConfig ↔
 * snake_case TOML, atomic write). Paths come from `ctx.host.homeDir` /
 * `ctx.host.configPath`.
 *
 * Layering mirrors the retired agent-core-v2 `ConfigService`: per-run `memory`
 * overrides (highest precedence, never persisted) sit above the user config
 * file; `inspect` reports the memory value, the env-free file value, and the
 * engine default separately. State is keyed by config path so parallel klient
 * instances (tests with temp homes) never share a memory overlay.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

import { loadRuntimeConfigSafe, resolveConfigPath } from '@moonshot-ai/kimi-code-sdk';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { registerService } from '../router.js';
import type { RustCallContext, RustServiceRegistry } from '../types.js';

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

interface ConfigServiceState {
  readonly configPath: string;
  /** Per-run overrides (target `memory`) — never persisted. */
  readonly memory: Record<string, unknown>;
}

const states = new Map<string, ConfigServiceState>();

function getState(configPath: string): ConfigServiceState {
  let state = states.get(configPath);
  if (state === undefined) {
    state = { configPath, memory: {} };
    states.set(configPath, state);
  }
  return state;
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/* ------------------------------------------------------------------ */
/*  Small local port of node-sdk `legacy/config.ts` (TOML read/write).  */
/*  Kept close to the upstream file so behavior stays in sync; the SDK  */
/*  only exports the read helpers (`loadRuntimeConfigSafe` /            */
/*  `resolveConfigPath`), so the write converters are ported here.      */
/* ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneUnknown<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? cloneUnknown(value) : {};
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

function snakeToCamel(str: string): string {
  return str.replaceAll(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function camelToSnake(str: string): string {
  return str.replaceAll(/[A-Z]/g, (ch: string) => `_${ch.toLowerCase()}`);
}

/** Deep merge with node-sdk `configPure.deepMerge` semantics. */
function deepMerge<T>(base: T | undefined, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch ?? base) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(patch)) {
    const pv = patch[key];
    const bv = out[key];
    out[key] = isPlainObject(bv) && isPlainObject(pv) ? deepMerge(bv, pv) : pv;
  }
  return out as T;
}

/* -- Read: raw TOML → camelCase (env-free) ------------------------- */

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
  const out = transformPlainObject(data);
  if (isPlainObject(out['overrides'])) {
    out['overrides'] = transformPlainObject(out['overrides']);
  }
  return out;
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

/** snake_case TOML record → camelCase user config (mirrors node-sdk
 *  `transformTomlData`; unknown plain-object sections are dropped, same as
 *  the upstream salvage path). */
function transformTomlData(data: Record<string, unknown>): Record<string, unknown> {
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
    } else if (targetKey === 'image' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'experimental' && isPlainObject(value)) {
      result[targetKey] = cloneRecord(value);
    } else if (targetKey === 'subagent' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'agent' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'mcp' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'modelCatalog' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (!isPlainObject(value)) {
      result[targetKey] = value;
    }
  }
  return result;
}

/* -- Write: camelCase config → snake_case TOML ---------------------- */

function setRecordSection(
  out: Record<string, unknown>,
  snakeKey: string,
  value: Record<string, unknown> | undefined,
  toToml: (v: Record<string, unknown>, raw: unknown) => Record<string, unknown>,
): void {
  if (value === undefined) {
    delete out[snakeKey];
    return;
  }

  const rawSub = cloneRecord(out[snakeKey]);
  const converted: Record<string, unknown> = {};
  for (const [entryName, entryConfig] of Object.entries(value)) {
    converted[entryName] = toToml(entryConfig as Record<string, unknown>, rawSub[entryName]);
  }

  if (Object.keys(converted).length > 0) {
    out[snakeKey] = converted;
  } else {
    delete out[snakeKey];
  }
}

function setSection(
  out: Record<string, unknown>,
  snakeKey: string,
  value: unknown,
  toToml: (v: Record<string, unknown>, raw: unknown) => Record<string, unknown>,
): void {
  if (value === undefined) {
    delete out[snakeKey];
    return;
  }
  const rawSub = cloneRecord(out[snakeKey]);
  const converted = toToml(value as Record<string, unknown>, rawSub);
  if (Object.keys(converted).length > 0) {
    out[snakeKey] = converted;
  } else {
    delete out[snakeKey];
  }
}

function providerToToml(provider: Record<string, unknown>, rawProvider: unknown): Record<string, unknown> {
  const out = cloneRecord(rawProvider);
  for (const [key, value] of Object.entries(provider)) {
    if (key === 'apiKey') {
      // An explicit non-empty apiKey replaces the raw value; an explicit empty
      // apiKey is only persisted for a brand-new provider entry, never to
      // clobber a real key already on disk (node-sdk `providerToToml`).
      if (value !== undefined && value !== '') {
        out['api_key'] = value;
      } else if (rawProvider === undefined || typeof rawProvider !== 'object') {
        out['api_key'] = value ?? '';
      }
      continue;
    }
    if (key === 'oauth' && value !== undefined) {
      out[camelToSnake(key)] = oauthToToml(value as Record<string, unknown>);
    } else if ((key === 'env' || key === 'customHeaders') && value !== undefined) {
      out[camelToSnake(key)] = cloneUnknown(value);
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

function modelToToml(model: Record<string, unknown>, rawModel: unknown): Record<string, unknown> {
  const out = cloneRecord(rawModel);
  for (const [key, value] of Object.entries(model)) {
    if (key === 'capabilities' && Array.isArray(value)) {
      out[camelToSnake(key)] = [...value];
    } else if (key === 'overrides' && isPlainObject(value)) {
      const rawOverrides = isPlainObject(rawModel) ? rawModel['overrides'] : undefined;
      out['overrides'] = modelOverridesToToml(value, rawOverrides);
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

function modelOverridesToToml(
  overrides: Record<string, unknown>,
  rawOverrides: unknown,
): Record<string, unknown> {
  const out = cloneRecord(rawOverrides);
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'capabilities' && Array.isArray(value)) {
      out[camelToSnake(key)] = [...value];
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

function thinkingToToml(thinking: Record<string, unknown>, rawThinking: unknown): Record<string, unknown> {
  const out = cloneRecord(rawThinking);
  delete out['mode'];
  for (const [key, value] of Object.entries(thinking)) {
    setDefined(out, camelToSnake(key), value);
  }
  return out;
}

function permissionToToml(
  permission: Record<string, unknown>,
  rawPermission: unknown,
): Record<string, unknown> {
  const out = cloneRecord(rawPermission);
  delete out['deny'];
  delete out['allow'];
  delete out['ask'];

  if (permission['rules'] !== undefined) {
    out['rules'] = (permission['rules'] as unknown[]).map((rule) =>
      permissionRuleToToml(rule as Record<string, unknown>),
    );
  } else {
    delete out['rules'];
  }
  return out;
}

function permissionRuleToToml(rule: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rule)) {
    setDefined(out, camelToSnake(key), value);
  }
  return out;
}

function servicesToToml(
  services: Record<string, unknown>,
  rawServices: unknown,
): Record<string, unknown> {
  const out = cloneRecord(rawServices);
  const moonshotSearch = services['moonshotSearch'];
  const moonshotFetch = services['moonshotFetch'];
  if (moonshotSearch !== undefined) {
    out['moonshot_search'] = serviceToToml(moonshotSearch as Record<string, unknown>);
  } else {
    delete out['moonshot_search'];
  }
  if (moonshotFetch !== undefined) {
    out['moonshot_fetch'] = serviceToToml(moonshotFetch as Record<string, unknown>);
  } else {
    delete out['moonshot_fetch'];
  }
  return out;
}

function serviceToToml(service: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(service)) {
    if (key === 'oauth' && value !== undefined) {
      out[camelToSnake(key)] = oauthToToml(value as Record<string, unknown>);
    } else if (key === 'customHeaders' && value !== undefined) {
      out[camelToSnake(key)] = cloneUnknown(value);
    } else {
      setDefined(out, camelToSnake(key), value);
    }
  }
  return out;
}

function genericSectionToToml(
  section: Record<string, unknown>,
  rawSection: unknown,
): Record<string, unknown> {
  const out = cloneRecord(rawSection);
  for (const [key, value] of Object.entries(section)) {
    setDefined(out, camelToSnake(key), value);
  }
  return out;
}

function experimentalToToml(
  experimental: Record<string, unknown>,
  _rawExperimental: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(experimental)) {
    setDefined(out, key, value);
  }
  return out;
}

function setHooks(out: Record<string, unknown>, hooks: unknown): void {
  if (hooks === undefined) {
    delete out['hooks'];
    return;
  }
  out['hooks'] = (hooks as unknown[]).map((hook) => hookToToml(hook as Record<string, unknown>));
}

function hookToToml(hook: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(hook)) {
    setDefined(out, camelToSnake(key), value);
  }
  return out;
}

function oauthToToml(oauth: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(oauth)) {
    setDefined(out, camelToSnake(key), value);
  }
  return out;
}

/** camelCase config (with `.raw` snake-case base) → snake_case TOML data
 *  (mirrors node-sdk `configToTomlData`; unknown forward-compatible fields in
 *  the raw base survive because sections start from their raw snapshot). */
function configToTomlData(config: Record<string, unknown>): Record<string, unknown> {
  const out = cloneRecord(config['raw']);

  // Strip deprecated fields
  delete out['default_yolo'];
  delete out['defaultYolo'];
  delete out['defaultPermissionMode'];
  delete out['default_thinking'];
  delete out['defaultThinking'];

  // Top-level scalar fields
  const scalarFields: readonly string[] = [
    'defaultProvider',
    'defaultModel',
    'planMode',
    'yolo',
    'defaultPermissionMode',
    'defaultPlanMode',
    'mergeAllAvailableSkills',
    'extraSkillDirs',
    'telemetry',
  ];
  for (const key of scalarFields) {
    setDefined(out, camelToSnake(key), config[key]);
  }

  setRecordSection(out, 'providers', config['providers'] as Record<string, unknown> | undefined, providerToToml);
  setRecordSection(out, 'models', config['models'] as Record<string, unknown> | undefined, modelToToml);
  setSection(out, 'thinking', config['thinking'], thinkingToToml);
  setSection(out, 'services', config['services'], servicesToToml);
  setSection(out, 'loop_control', config['loopControl'], genericSectionToToml);
  setSection(out, 'background', config['background'], genericSectionToToml);
  setSection(out, 'subagent', config['subagent'], genericSectionToToml);
  setSection(out, 'agent', config['agent'], genericSectionToToml);
  setSection(out, 'mcp', config['mcp'], genericSectionToToml);
  setSection(out, 'image', config['image'], genericSectionToToml);
  setSection(out, 'model_catalog', config['modelCatalog'], genericSectionToToml);
  setSection(out, 'experimental', config['experimental'], experimentalToToml);
  setSection(out, 'permission', config['permission'], permissionToToml);
  setHooks(out, config['hooks']);

  return out;
}

/* -- File IO -------------------------------------------------------- */

function readRawToml(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  const text = readFileSync(filePath, 'utf-8');
  if (text.trim().length === 0) return {};
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch {
    // A broken file blocks writes (set/replace refuse to clobber it); reads
    // surface the problem through diagnostics() / loadRuntimeConfigSafe.
    return {};
  }
}

/** Env-free camelCase user config (with `.raw` snake-case base) — the write
 *  base for `set`/`replace`, so `KIMI_MODEL_*` env overlays never persist. */
function readUserConfig(filePath: string): Record<string, unknown> {
  const rawSnake = readRawToml(filePath);
  const config = transformTomlData(rawSnake);
  config['raw'] = rawSnake;
  return config;
}

/** Engine default config (node-sdk `getDefaultConfig`). */
const DEFAULT_CONFIG: Record<string, unknown> = { providers: {} };

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const hex = randomBytes(4).toString('hex');
  const tmpPath = `${filePath}.tmp.${process.pid}.${hex}`;
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w');
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    // Windows `fs.rename` maps to MoveFileEx and fails with EPERM when the
    // target is held open — pre-unlink turns this into the POSIX replace case.
    if (process.platform === 'win32') {
      try {
        await unlink(filePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw error;
      }
    }
    await rename(tmpPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        await unlink(tmpPath);
      } catch {
        /* ignore — tmp may not exist if open itself failed */
      }
    }
  }
}

async function writeConfigFile(filePath: string, config: Record<string, unknown>): Promise<void> {
  const data = configToTomlData(config);
  const text = `${stringifyToml(data)}\n`;
  // The writer must never emit unparseable TOML; fail before touching disk.
  parseToml(text);
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await atomicWrite(filePath, text);
}

/* ------------------------------------------------------------------ */
/*  configService                                                      */
/* ------------------------------------------------------------------ */

function configPathOf(ctx: RustCallContext): string {
  return resolveConfigPath({ homeDir: ctx.host.homeDir, configPath: ctx.host.configPath });
}

/** Merge/replace one domain into the user config file. Refuses to overwrite a
 *  file that cannot be parsed at all (node-sdk `readConfigFileForUpdate`
 *  behavior): salvaged-but-partial breakage is preserved as-is. */
async function writeDomain(
  ctx: RustCallContext,
  domain: string,
  source: 'set' | 'replace',
  apply: (base: unknown) => unknown,
): Promise<void> {
  const filePath = configPathOf(ctx);
  const { fileError } = loadRuntimeConfigSafe(filePath);
  if (fileError !== undefined) {
    throw new Error(`Cannot change settings while ${filePath} is invalid — fix it first.`);
  }
  const config = readUserConfig(filePath);
  const previousValue = config[domain];
  const next = apply(config[domain]);
  if (next === undefined) {
    delete config[domain];
  } else {
    config[domain] = next;
  }
  await writeConfigFile(filePath, config);
  emitConfigWrite(ctx, domain, source, next, previousValue);
}

/** Emit host-side change notifications after a config write: always the
 *  `onDidChangeConfiguration` (`config.changed`) event, plus the
 *  `onDidChangeProviders` / `onDidChangeModels` deltas when the written
 *  domain is a provider/model section. No-op without a host event bus. */
function emitConfigWrite(
  ctx: RustCallContext,
  domain: string,
  source: 'set' | 'replace',
  value: unknown,
  previousValue: unknown,
): void {
  const bus = ctx.host.events;
  if (bus === undefined) return;
  bus.emit('onDidChangeConfiguration', { domain, source, value, previousValue });
  if (domain !== 'providers' && domain !== 'models') return;
  const before = new Set(Object.keys(isPlainObject(previousValue) ? previousValue : {}));
  const after = new Set(Object.keys(isPlainObject(value) ? value : {}));
  const event = domain === 'providers' ? 'onDidChangeProviders' : 'onDidChangeModels';
  bus.emit(event, {
    added: [...after].filter((id) => !before.has(id)),
    removed: [...before].filter((id) => !after.has(id)),
    changed: [...after].filter((id) => before.has(id)),
  });
}

const configService: RustServiceRegistry = {
  /** Resolved value for a domain: memory overlay wins, else file + env. */
  async get(ctx) {
    const domain = ctx.args[0] as string;
    if (domain === 'raw') return;
    const state = getState(configPathOf(ctx));
    if (hasOwn(state.memory, domain)) return state.memory[domain];
    const config = loadRuntimeConfigSafe(state.configPath).config as Record<string, unknown>;
    return config[domain];
  },

  /** All resolved domains (`raw` and undefined entries excluded), merged with
   *  the memory overlay. */
  async getAll(ctx) {
    const state = getState(configPathOf(ctx));
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(loadRuntimeConfigSafe(state.configPath).config)) {
      if (key === 'raw' || value === undefined) continue;
      out[key] = value;
    }
    Object.assign(out, state.memory);
    return out;
  },

  /** Layer breakdown for one domain: value / engine default / file / memory. */
  async inspect(ctx) {
    const domain = ctx.args[0] as string;
    const state = getState(configPathOf(ctx));
    const config = loadRuntimeConfigSafe(state.configPath).config as Record<string, unknown>;
    const memoryValue = hasOwn(state.memory, domain) ? state.memory[domain] : undefined;
    return {
      value: hasOwn(state.memory, domain) ? state.memory[domain] : config[domain],
      defaultValue: DEFAULT_CONFIG[domain],
      userValue: readUserConfig(state.configPath)[domain],
      memoryValue,
    };
  },

  /** Merge a patch into a domain. `memory` target stays in-process; the
   *  default `user` target deep-merges into the on-disk config and persists. */
  async set(ctx) {
    const domain = ctx.args[0] as string;
    const patch = ctx.args[1];
    const target = (ctx.args[2] ?? 'user') as 'user' | 'memory';
    const state = getState(configPathOf(ctx));
    if (target === 'memory') {
      const next = deepMerge(
        hasOwn(state.memory, domain) ? state.memory[domain] : undefined,
        patch,
      );
      if (next === undefined) {
        delete state.memory[domain];
      } else {
        state.memory[domain] = next;
      }
      return;
    }
    await writeDomain(ctx, domain, 'set', (base) => deepMerge(base, patch));
    return;
  },

  /** Replace a domain wholesale. Same target semantics as `set`. */
  async replace(ctx) {
    const domain = ctx.args[0] as string;
    const value = ctx.args[1];
    const target = (ctx.args[2] ?? 'user') as 'user' | 'memory';
    const state = getState(configPathOf(ctx));
    if (target === 'memory') {
      if (value === undefined) {
        delete state.memory[domain];
      } else {
        state.memory[domain] = value;
      }
      return;
    }
    await writeDomain(ctx, domain, 'replace', () => value);
    return;
  },

  /** Re-read the on-disk config. Reads are already fresh per call, so this
   *  re-parses (surfacing breakage via diagnostics) and keeps memory. */
  async reload(ctx) {
    const state = getState(configPathOf(ctx));
    loadRuntimeConfigSafe(state.configPath);
    return;
  },

  /** Config file problems, mapped from node-sdk's lenient load: an unusable
   *  file is an error, salvaged sections and env overlay failures are
   *  warnings (same layering as the retired ConfigService). */
  async diagnostics(ctx) {
    const state = getState(configPathOf(ctx));
    const { fileError, fileWarnings, envWarnings } = loadRuntimeConfigSafe(state.configPath);
    const out: { severity: 'warning' | 'error'; message: string }[] = [];
    if (fileError !== undefined) {
      out.push({ severity: 'error', message: fileError.message });
    } else {
      for (const message of fileWarnings) {
        out.push({ severity: 'warning', message });
      }
    }
    for (const message of envWarnings) {
      out.push({ severity: 'warning', message });
    }
    return out;
  },
};

/* ------------------------------------------------------------------ */
/*  bootstrapService — frozen host snapshot (env contract props)       */
/* ------------------------------------------------------------------ */

const nodeRequire = createRequire(import.meta.url);

function resolveClientVersion(): string {
  try {
    const pkg = nodeRequire('@moonshot-ai/klient/package.json') as { version?: string };
    if (typeof pkg?.version === 'string' && pkg.version.length > 0) return pkg.version;
  } catch {
    /* not resolvable in some bundlers — fall back to 'unknown' */
  }
  return 'unknown';
}

const CLIENT_VERSION = resolveClientVersion();

/** Forward-slash join, matching node-sdk's path normalization. */
function joinPath(dir: string, name: string): string {
  return `${dir.replaceAll('\\', '/').replace(/\/+$/, '')}/${name}`;
}

const bootstrapService: RustServiceRegistry = {
  platform: async () => process.platform,
  arch: async () => process.arch,
  cwd: async () => process.cwd(),
  osHomeDir: async () => homedir(),
  homeDir: async (ctx) => ctx.host.homeDir,
  configPath: async (ctx) => configPathOf(ctx),
  clientVersion: async () => CLIENT_VERSION,
  sessionsDir: async (ctx) => joinPath(ctx.host.homeDir, 'sessions'),
  blobsDir: async (ctx) => joinPath(ctx.host.homeDir, 'blobs'),
  storeDir: async (ctx) => joinPath(ctx.host.homeDir, 'store'),
  cacheDir: async (ctx) => joinPath(ctx.host.homeDir, 'cache'),
  logsDir: async (ctx) => joinPath(ctx.host.homeDir, 'logs'),
};

registerService('configService', configService);
registerService('bootstrapService', bootstrapService);
