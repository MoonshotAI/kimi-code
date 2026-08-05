/**
 * `config` domain — configuration registry and layered global config service.
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
 * env-free raw base (already `fromToml`-normalized) — or drops it when absent
 * there — instead of persisting an echoed env value; otherwise writes pass
 * through untouched. When nothing
 * persistable remains, the write is a no-op for the section — the env-free
 * raw base is kept as-is (unknown forward-compatible fields survive repeated
 * stripped writes) — and the section is cleared only when the base is empty,
 * so registered defaults keep applying.
 *
 * Sections declare key renames through `deprecations` and env-var renames
 * through a binding's `deprecatedEnv`: a deprecated TOML key is ignored (its
 * value no longer applies) and a deprecated env var still resolves as a
 * fallback; both surface warning `ConfigDiagnostic`s while in use.
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
      /**
       * Deprecated former name of `env`. Still honored (with a deprecation
       * warning) when `env` itself is absent or fails to parse, so existing
       * setups keep working until the user renames the variable.
       */
      readonly deprecatedEnv?: string;
      readonly parse?: (raw: string) => unknown;
      readonly default?: unknown;
    };

/**
 * A declared config-key rename: `key` (snake_case, as written on disk) is
 * deprecated in favor of `replacement`. While the old key is present in the
 * user's config file the service reports a warning diagnostic; the old value
 * is NOT honored — only `replacement` (or the section default) applies.
 */
export interface ConfigKeyDeprecation {
  readonly key: string;
  readonly replacement: string;
  /** Optional extra guidance appended to the generated warning message. */
  readonly message?: string;
}

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
      if (!resolvesFromEnv(binding, getEnv)) continue;
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

/**
 * Whether a leaf binding currently resolves from the environment: the primary
 * var wins when set and parseable, then the deprecated fallback (same rule as
 * the read path in `configService`'s `resolveBinding`).
 */
function resolvesFromEnv(binding: EnvBinding, getEnv: (name: string) => string | undefined): boolean {
  const parse = typeof binding === 'string' ? undefined : binding.parse;
  const names =
    typeof binding === 'string'
      ? [binding]
      : binding.deprecatedEnv === undefined
        ? [binding.env]
        : [binding.env, binding.deprecatedEnv];
  return names.some((name) => {
    const raw = getEnv(name);
    return raw !== undefined && (parse === undefined || parse(raw) !== undefined);
  });
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
  readonly deprecations?: readonly ConfigKeyDeprecation[];
}

export interface RegisterSectionOptions<T> {
  readonly defaultValue?: T;
  readonly merge?: ConfigMerge<T>;
  readonly scope?: ConfigScope;
  readonly env?: EnvBindings<T>;
  readonly stripEnv?: ConfigStripEnv<T>;
  readonly fromToml?: ConfigFromToml;
  readonly toToml?: ConfigToToml;
  readonly deprecations?: readonly ConfigKeyDeprecation[];
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
  /**
   * Fired when the diagnostics list changes (load / reload / env overlay
   * re-application), carrying the full current list — including an empty
   * list when the last diagnostic clears.
   */
  readonly onDidChangeDiagnostics: Event<readonly ConfigDiagnostic[]>;
  get<T = unknown>(domain: string): T;
  inspect<T = unknown>(domain: string): ConfigInspectValue<T>;
  getAll(): ResolvedConfig;
  set(domain: string, patch: unknown, target?: ConfigTarget): Promise<void>;
  /**
   * Replace one domain wholesale; `undefined` (or `null`, the wire encoding
   * of clear — JSON transports cannot carry `undefined`) removes the domain.
   */
  replace(domain: string, value: unknown, target?: ConfigTarget): Promise<void>;
  /**
   * Replace several domains in ONE atomic write: a domain mapped to
   * `undefined` (or `null`, see {@link replace}) is cleared, domains absent
   * from `sections` are left untouched.
   */
  replaceSections(
    sections: Readonly<Record<string, unknown>>,
    target?: ConfigTarget,
  ): Promise<void>;
  reload(): Promise<void>;
  diagnostics(): readonly ConfigDiagnostic[];
}

export const IConfigService: ServiceIdentifier<IConfigService> =
  createDecorator<IConfigService>('configService');
