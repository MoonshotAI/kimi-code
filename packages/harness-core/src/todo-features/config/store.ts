import type { ZodType } from 'zod';

import type { ShallowRef } from '#/composition-api/index';

import type { EnvBindings, GetEnv } from './env';

export interface ConfigPersist {
  load(): Promise<string | undefined>;
  save(text: string): Promise<void>;
  watch?(onChange: () => void): () => void;
}

export type ConfigTarget = 'memory' | 'user';

export type ConfigChangeSource = 'load' | 'reload' | 'set';

export interface ConfigDiagnostic {
  readonly section?: string;
  readonly severity: 'warning' | 'error';
  readonly message: string;
}

export interface ConfigKeyDeprecation {
  readonly key: string;
  readonly replacement: string;
  readonly message?: string;
}

export type ConfigMerge<T = unknown> = (base: T | undefined, patch: unknown) => T;

export type ConfigStripEnv<T = unknown> = (value: T, raw: unknown, getEnv: GetEnv) => T | undefined;

export type ConfigFromToml = (raw: unknown) => unknown;

export type ConfigToToml = (value: unknown, raw: unknown) => unknown;

export type ConfigCollectDiagnostics = (rawSection: unknown) => readonly ConfigDiagnostic[];

export type ConfigOverlayValidate = (name: string, value: unknown) => unknown;

export interface ConfigOverlayContribution {
  readonly name: string;
  apply(effective: Record<string, unknown>, getEnv: GetEnv, validate: ConfigOverlayValidate): void;
  strip?(name: string, value: unknown, rawSnake: Record<string, unknown>): unknown;
}

export interface ConfigSectionContribution<T = unknown> {
  readonly name: string;
  readonly schema: ZodType<T>;
  readonly defaultValue?: T;
  readonly merge?: ConfigMerge<T>;
  readonly envBindings?: EnvBindings<T>;
  readonly stripEnv?: ConfigStripEnv<T>;
  readonly fromToml?: ConfigFromToml;
  readonly toToml?: ConfigToToml;
  readonly deprecations?: readonly ConfigKeyDeprecation[];
  readonly collectDiagnostics?: ConfigCollectDiagnostics;
}

export interface ConfigInspectValue<T = unknown> {
  readonly value: T | undefined;
  readonly defaultValue: T | undefined;
  readonly userValue: T | undefined;
  readonly memoryValue: T | undefined;
}

export interface ConfigStore {
  section<T = unknown>(name: string): ShallowRef<T>;
  get<T = unknown>(name: string): T;
  inspect<T = unknown>(name: string): ConfigInspectValue<T>;
  env(name: string): string | undefined;
  set(name: string, value: unknown, target: ConfigTarget): Promise<void>;
  replace(sections: Readonly<Record<string, unknown>>, target: ConfigTarget): Promise<void>;
  reload(): Promise<void>;
  diagnostics(): readonly ConfigDiagnostic[];
  dispose(): void;
}
