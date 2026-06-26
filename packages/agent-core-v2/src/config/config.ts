/**
 * `config` domain (L2) — configuration registry, global config service, and
 * session-level runtime config service.
 *
 * Defines the config service identifiers and section models: the
 * `IConfigRegistry` for section schemas, the Core-scoped `IConfigService` used
 * to read and mutate global config, and the Session-scoped
 * `ISessionConfigService` for the active session's runtime config.
 */

import type { Event } from '#/_base/event';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ConfigSchema<T> {
  parse(value: unknown): T;
}

export type ConfigMerge<T> = (base: T | undefined, patch: unknown) => T;

export interface ConfigSection<T = unknown> {
  readonly domain: string;
  readonly schema?: ConfigSchema<T>;
  readonly defaultValue?: T;
  readonly merge: ConfigMerge<T>;
}

export interface RegisterSectionOptions<T> {
  readonly defaultValue?: T;
  readonly merge?: ConfigMerge<T>;
}

export interface IConfigRegistry {
  readonly _serviceBrand: undefined;

  registerSection<T>(domain: string, schema: ConfigSchema<T>, options?: RegisterSectionOptions<T>): void;
  getSection(domain: string): ConfigSection | undefined;
  listSections(): readonly ConfigSection[];
  validate<T>(domain: string, value: unknown): T;
  merge<T>(domain: string, base: T | undefined, patch: unknown): T;
  defaultValue<T>(domain: string): T | undefined;
}

export const IConfigRegistry: ServiceIdentifier<IConfigRegistry> =
  createDecorator<IConfigRegistry>('configRegistry');

export type ConfigChangeSource = 'load' | 'reload' | 'set';

export interface ConfigChangedEvent {
  readonly domain: string;
  readonly source: ConfigChangeSource;
}

export interface ConfigDiagnostic {
  readonly domain?: string;
  readonly severity: 'warning' | 'error';
  readonly message: string;
}

export type ResolvedConfig = Record<string, unknown>;

export interface IConfigService {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly onDidChange: Event<ConfigChangedEvent>;

  get<T = unknown>(domain: string): T;
  getAll(): ResolvedConfig;
  set(domain: string, patch: unknown): Promise<void>;
  replace(domain: string, value: unknown): Promise<void>;
  reload(): Promise<void>;
  diagnostics(): readonly ConfigDiagnostic[];
}

export const IConfigService: ServiceIdentifier<IConfigService> =
  createDecorator<IConfigService>('configService');

export interface SessionConfigSection {
  readonly modelAlias?: string;
  readonly thinkingLevel?: string;
  readonly systemPrompt?: string;
  readonly provider?: string;
}

export type SessionConfigPatch = Partial<
  Pick<SessionConfigSection, 'modelAlias' | 'thinkingLevel' | 'systemPrompt'>
>;

export interface SessionConfigChangedEvent {
  readonly changed: readonly (keyof SessionConfigSection)[];
}

export interface ISessionConfigService {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly onDidChange: Event<SessionConfigChangedEvent>;

  readonly modelAlias: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly systemPrompt: string | undefined;
  readonly provider: string | undefined;

  update(patch: SessionConfigPatch): Promise<void>;
  setModel(alias: string): Promise<void>;
  setThinking(level: string): Promise<void>;
}

export const ISessionConfigService: ServiceIdentifier<ISessionConfigService> =
  createDecorator<ISessionConfigService>('sessionConfigService');
