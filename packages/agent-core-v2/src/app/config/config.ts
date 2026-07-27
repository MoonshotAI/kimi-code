/**
 * `config` domain (L2) — configuration registry and layered global config service.
 *
 * Defines the config service identifiers and section models: the
 * `IConfigRegistry` for section schemas, and the App-scoped `IConfigService`
 * that resolves a value by precedence across layers (defaults → user config →
 * per-run memory overrides) and writes through a `ConfigTarget`. Owners react
 * to edits through two change events — `onDidChangeConfiguration` (a domain was touched) and
 * `onDidSectionChange` (the delivered value actually changed, deep-diffed) —
 * each carrying the delivered `value` and `previousValue`.
 *
 * Sections may bind fields to env vars (`envBindings`), resolved as
 * env > user config > default on every read; an env value that fails its
 * binding's `parse` is ignored. `stripEnvBoundFields` builds the matching
 * write guard for persistable env-bound fields: while a field's env var
 * resolves to a value, `set`/`replace` restores the field's value from the
 * env-free raw base (already `fromToml`-normalized, so legacy key renames are
 * honored) — or drops it when absent there — instead of persisting an echoed
 * env value; otherwise writes pass through untouched. When nothing
 * persistable remains, the write is a no-op for the section — the env-free
 * raw base is kept as-is (unknown forward-compatible fields survive repeated
 * stripped writes) — and the section is cleared only when the base is empty,
 * so registered defaults keep applying.
 */

import type { Event } from '#/_base/event';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import { isPlainObject } from './configPure';

export interface ConfigSchema<T> {
  parse(value: unknown): T;
}

export type ConfigMerge<T> = (base: T | undefined, patch: unknown) => T;

export type EnvBinding =
  | string
  | {
      readonly env: string;
      readonly parse?: (raw: string) => unknown;
      readonly default?: unknown;
    };

export type EnvBindings<T> = EnvBinding | { [K in keyof T]?: EnvBinding | EnvBindings<T[K]> };

export type AnyEnvBindings = EnvBinding | { readonly [key: string]: EnvBinding | AnyEnvBindings };

export function envBindings<T>(_schema: ConfigSchema<T>, bindings: EnvBindings<T>): EnvBindings<T> {
  return bindings;
}

export type ConfigStripEnv<T> = (
  value: T,
  raw?: unknown,
  getEnv?: (name: string) => string | undefined,
) => T | undefined;

function isEnvBinding(value: unknown): value is EnvBinding {
  return typeof value === 'string' || (isPlainObject(value) && 'env' in value);
}

export function stripEnvBoundFields<T>(bindings: EnvBindings<T>): ConfigStripEnv<T> {
  return (value, raw, getEnv) => {
    if (getEnv === undefined || value === null || typeof value !== 'object') return value;
    if (!isPlainObject(bindings) || isEnvBinding(bindings)) return value;
    const base = isPlainObject(raw) ? raw : {};
    let out: Record<string, unknown> | undefined;
    for (const [field, binding] of Object.entries(bindings)) {
      if (binding === undefined || !isEnvBinding(binding)) continue;
      const rawEnv = getEnv(typeof binding === 'string' ? binding : binding.env);
      if (rawEnv === undefined) continue;
      const parse = typeof binding === 'string' ? undefined : binding.parse;
      if (parse !== undefined && parse(rawEnv) === undefined) continue;
      out ??= { ...(value as Record<string, unknown>) };
      if (base[field] !== undefined) {
        out[field] = base[field];
      } else {
        delete out[field];
      }
    }
    if (out === undefined) return value;
    if (Object.keys(out).length > 0) return out as T;
    return (Object.keys(base).length > 0 ? base : undefined) as T | undefined;
  };
}

export type ConfigFromToml = (rawSnake: unknown) => unknown;

export type ConfigToToml = (value: unknown, rawSnake: unknown) => unknown;

export interface ConfigSection<T = unknown> {
  readonly domain: string;
  readonly schema?: ConfigSchema<T>;
  readonly defaultValue?: T;
  readonly merge: ConfigMerge<T>;
  readonly scope: ConfigScope;
  readonly env?: AnyEnvBindings;
  readonly stripEnv?: ConfigStripEnv<T>;
  readonly fromToml?: ConfigFromToml;
  readonly toToml?: ConfigToToml;
}

export interface RegisterSectionOptions<T> {
  readonly defaultValue?: T;
  readonly merge?: ConfigMerge<T>;
  readonly scope?: ConfigScope;
  readonly env?: EnvBindings<T>;
  readonly stripEnv?: ConfigStripEnv<T>;
  readonly fromToml?: ConfigFromToml;
  readonly toToml?: ConfigToToml;
}

export interface ConfigEffectiveOverlay {
  apply(
    effective: Record<string, unknown>,
    getEnv: (name: string) => string | undefined,
    validate: (domain: string, value: unknown) => unknown,
  ): readonly string[];
  strip?(
    domain: string,
    value: unknown,
    rawSnake: Record<string, unknown>,
  ): unknown;
}

export interface IConfigRegistry {
  readonly _serviceBrand: undefined;

  readonly onDidRegisterSection: Event<ConfigSectionRegisteredEvent>;
  readonly onDidRegisterOverlay: Event<ConfigOverlayRegisteredEvent>;
  registerSection<T>(domain: string, schema: ConfigSchema<T>, options?: RegisterSectionOptions<T>): void;
  getSection(domain: string): ConfigSection | undefined;
  listSections(): readonly ConfigSection[];
  registerEffectiveOverlay(overlay: ConfigEffectiveOverlay): void;
  listEffectiveOverlays(): readonly ConfigEffectiveOverlay[];
  validate<T>(domain: string, value: unknown): T;
  merge<T>(domain: string, base: T | undefined, patch: unknown): T;
  defaultValue<T>(domain: string): T | undefined;
}

export interface ConfigSectionRegisteredEvent {
  readonly domain: string;
}

export interface ConfigOverlayRegisteredEvent {
  readonly overlay: ConfigEffectiveOverlay;
}

export const IConfigRegistry: ServiceIdentifier<IConfigRegistry> =
  createDecorator<IConfigRegistry>('configRegistry');

export type ConfigChangeSource = 'load' | 'reload' | 'set';

export interface ConfigChangedEvent {
  readonly domain: string;
  readonly source: ConfigChangeSource;
  readonly value: unknown;
  readonly previousValue: unknown;
}

export interface ConfigSectionChangedEvent {
  readonly domain: string;
  readonly source: ConfigChangeSource;
  readonly value: unknown;
  readonly previousValue: unknown;
}

export interface ConfigDiagnostic {
  readonly domain?: string;
  readonly severity: 'warning' | 'error';
  readonly message: string;
}

export type ResolvedConfig = Record<string, unknown>;

export enum ConfigScope {
  Core = 'core',
  Session = 'session',
  Project = 'project',
}

export enum ConfigTarget {
  User = 'user',
  Memory = 'memory',
}

export interface ConfigInspectValue<T = unknown> {
  readonly value: T | undefined;
  readonly defaultValue: T | undefined;
  readonly userValue: T | undefined;
  readonly memoryValue: T | undefined;
}

export interface IConfigService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly onDidChangeConfiguration: Event<ConfigChangedEvent>;
  readonly onDidSectionChange: Event<ConfigSectionChangedEvent>;
  get<T = unknown>(domain: string): T;
  inspect<T = unknown>(domain: string): ConfigInspectValue<T>;
  getAll(): ResolvedConfig;
  set(domain: string, patch: unknown, target?: ConfigTarget): Promise<void>;
  replace(domain: string, value: unknown, target?: ConfigTarget): Promise<void>;
  reload(): Promise<void>;
  diagnostics(): readonly ConfigDiagnostic[];
}

export const IConfigService: ServiceIdentifier<IConfigService> =
  createDecorator<IConfigService>('configService');
