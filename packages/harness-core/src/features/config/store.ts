import type { ZodType } from 'zod';

import { shallowRef, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';

import { applySectionEnv, type AnyEnvBindings, type EnvBindings, type GetEnv } from './env';
import { deepEqual, deepMerge, describeUnknownError, isPlainObject } from './pure';
import {
  applySectionToToml,
  camelToSnake,
  cloneRecord,
  defaultFromToml,
  describeTomlSyntaxError,
  parseConfigText,
  serializeConfig,
  transformTomlData,
} from './toml';
import { planConfigWriteback } from './writeback';

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

export interface ConfigStore {
  section<T = unknown>(name: string): ShallowRef<T>;
  get<T = unknown>(name: string): T;
  env(name: string): string | undefined;
  set(name: string, value: unknown, target: ConfigTarget): Promise<void>;
  replace(sections: Readonly<Record<string, unknown>>, target: ConfigTarget): Promise<void>;
  reload(): Promise<void>;
  diagnostics(): readonly ConfigDiagnostic[];
  dispose(): void;
}

export interface ConfigStoreControl extends ConfigStore {
  syncSections(sections: readonly ConfigSectionContribution[]): void;
  syncOverlays(overlays: readonly ConfigOverlayContribution[]): void;
}

interface StagedFile {
  readonly text: string | undefined;
  readonly previous: Record<string, unknown>;
  readonly data: Record<string, unknown>;
  values: Record<string, unknown>;
}

const replaceMerge: ConfigMerge = (_base, patch) => patch;

export function createConfigStore(deps: {
  readonly persist?: ConfigPersist;
  readonly env?: Record<string, string | undefined>;
  readonly onChanged?: (
    section: string,
    value: unknown,
    previousValue: unknown,
    source: ConfigChangeSource,
  ) => void;
}): ConfigStoreControl {
  const sectionsByName = new Map<string, ConfigSectionContribution>();
  const refs = new Map<string, ShallowRef<unknown>>();
  const diagnosticsList: ConfigDiagnostic[] = [];
  let overlays: readonly ConfigOverlayContribution[] = [];
  let rawSnake: Record<string, unknown> = {};
  let fileValues: Record<string, unknown> = {};
  let memory: Record<string, unknown> = {};
  let effectiveCache: Record<string, unknown> | undefined;
  let chain = Promise.resolve();
  let closed = false;

  const getEnv: GetEnv = (name) => (deps.env === undefined ? process.env[name] : deps.env[name]);

  const lookupSection = (name: string): ConfigSectionContribution | undefined => sectionsByName.get(name);

  const pushDiagnostic = (diagnostic: ConfigDiagnostic): void => {
    const duplicate = diagnosticsList.some(
      (existing) =>
        existing.section === diagnostic.section &&
        existing.severity === diagnostic.severity &&
        existing.message === diagnostic.message,
    );
    if (!duplicate) diagnosticsList.push(diagnostic);
  };

  const validateOverlayValue = (name: string, value: unknown): unknown => {
    const section = sectionsByName.get(name);
    return section === undefined ? value : (section.schema.parse(value) as unknown);
  };

  const computeEffective = (): Record<string, unknown> => {
    const effective: Record<string, unknown> = {};
    for (const name of new Set([...Object.keys(fileValues), ...sectionsByName.keys()])) {
      const section = sectionsByName.get(name);
      if (section === undefined) {
        if (fileValues[name] !== undefined) effective[name] = fileValues[name];
        continue;
      }
      const base = Object.prototype.hasOwnProperty.call(fileValues, name)
        ? fileValues[name]
        : section.defaultValue;
      if (section.envBindings === undefined) {
        if (base !== undefined) effective[name] = base;
        continue;
      }
      try {
        const next = applySectionEnv(base, section.envBindings as AnyEnvBindings, getEnv, (oldName, newName) => {
          pushDiagnostic({
            section: name,
            severity: 'warning',
            message: `Environment variable ${oldName} is deprecated; use ${newName} instead.`,
          });
        });
        effective[name] = section.schema.parse(next) as unknown;
      } catch (error) {
        pushDiagnostic({
          section: name,
          severity: 'warning',
          message: `Ignoring env overlay for '${name}': ${describeUnknownError(error)}`,
        });
        if (base !== undefined) effective[name] = base;
      }
    }
    for (const overlay of overlays) {
      try {
        overlay.apply(effective, getEnv, validateOverlayValue);
      } catch (error) {
        pushDiagnostic({
          severity: 'warning',
          message: `Ignoring config environment overlay: ${describeUnknownError(error)}`,
        });
      }
    }
    return effective;
  };

  const effectiveValues = (): Record<string, unknown> => (effectiveCache ??= computeEffective());

  const invalidateEffective = (): void => {
    effectiveCache = undefined;
  };

  const deliveredValue = (name: string): unknown => {
    if (Object.prototype.hasOwnProperty.call(memory, name)) return memory[name];
    return effectiveValues()[name];
  };

  const recompute = (source: ConfigChangeSource, names?: readonly string[]): void => {
    const effective = effectiveValues();
    const targets =
      names ??
      [...new Set([...sectionsByName.keys(), ...Object.keys(effective), ...refs.keys()])];
    for (const name of targets) {
      const value = Object.prototype.hasOwnProperty.call(memory, name) ? memory[name] : effective[name];
      let ref = refs.get(name);
      if (ref === undefined) {
        ref = shallowRef(value);
        refs.set(name, ref);
        deps.onChanged?.(name, value, undefined, source);
        continue;
      }
      if (deepEqual(ref.value, value)) continue;
      const previousValue = ref.value;
      ref.value = value;
      deps.onChanged?.(name, value, previousValue, source);
    }
  };

  const buildFileValues = (data: Record<string, unknown>): Record<string, unknown> => {
    const transformed = transformTomlData(data, lookupSection);
    const values: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(transformed)) {
      const section = sectionsByName.get(name);
      if (section === undefined) {
        values[name] = value;
        continue;
      }
      try {
        values[name] = section.schema.parse(value) as unknown;
      } catch (error) {
        pushDiagnostic({
          section: name,
          severity: 'warning',
          message: `Ignored invalid config section '${name}': ${describeUnknownError(error)}`,
        });
      }
    }
    return values;
  };

  const loadFromDisk = async (source: ConfigChangeSource): Promise<void> => {
    diagnosticsList.length = 0;
    let data: Record<string, unknown> = {};
    if (deps.persist !== undefined) {
      try {
        const text = await deps.persist.load();
        if (text !== undefined) data = parseConfigText(text);
      } catch (error) {
        pushDiagnostic({
          severity: 'error',
          message: `Failed to load config: ${describeTomlSyntaxError(error)}`,
        });
        if (source !== 'load') return;
      }
    }
    rawSnake = data;
    for (const section of sectionsByName.values()) {
      const snakeName = camelToSnake(section.name);
      const rawSection = data[snakeName];
      const deprecations = section.deprecations;
      if (deprecations === undefined || deprecations.length === 0 || !isPlainObject(rawSection)) {
        continue;
      }
      for (const deprecation of deprecations) {
        if (rawSection[deprecation.key] === undefined) continue;
        pushDiagnostic({
          section: section.name,
          severity: 'warning',
          message:
            `[${snakeName}] '${deprecation.key}' is deprecated and no longer used; ` +
            `rename it to '${deprecation.replacement}'.` +
            (deprecation.message === undefined ? '' : ` ${deprecation.message}`),
        });
      }
    }
    for (const section of sectionsByName.values()) {
      if (section.collectDiagnostics === undefined) continue;
      const rawSection = data[camelToSnake(section.name)];
      for (const diagnostic of section.collectDiagnostics(rawSection)) {
        pushDiagnostic(diagnostic);
      }
    }
    fileValues = buildFileValues(data);
    invalidateEffective();
    recompute(source);
  };

  const enqueue = <T,>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(() => (closed ? (undefined as T) : task()));
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const stageOnDisk = async (persist: ConfigPersist): Promise<StagedFile> => {
    let text: string | undefined;
    let previous: Record<string, unknown> = {};
    try {
      text = await persist.load();
      if (text !== undefined) previous = parseConfigText(text);
    } catch (error) {
      pushDiagnostic({
        severity: 'error',
        message: `Failed to load config: ${describeTomlSyntaxError(error)}`,
      });
      throw new Error('refusing to persist config: the config file could not be read');
    }
    return { text, previous, data: cloneRecord(previous), values: buildFileValues(previous) };
  };

  const applyStagedSection = (
    staged: StagedFile,
    name: string,
    section: ConfigSectionContribution | undefined,
    value: unknown,
  ): void => {
    if (value === undefined) {
      applySectionToToml(staged.data, name, undefined, lookupSection);
      delete staged.values[name];
      return;
    }
    let stripped: unknown =
      section?.stripEnv === undefined ? value : section.stripEnv(value, staged.values[name], getEnv);
    if (stripped !== undefined) {
      for (const overlay of overlays) {
        if (overlay.strip === undefined) continue;
        stripped = overlay.strip(name, stripped, staged.data);
        if (stripped === undefined) break;
      }
    }
    if (stripped === undefined) {
      applySectionToToml(staged.data, name, undefined, lookupSection);
      delete staged.values[name];
      return;
    }
    const parsed = section === undefined ? stripped : (section.schema.parse(stripped) as unknown);
    staged.values[name] = parsed;
    applySectionToToml(staged.data, name, parsed, lookupSection);
  };

  const persistStaged = async (
    persist: ConfigPersist,
    staged: StagedFile,
    names: readonly string[],
  ): Promise<void> => {
    const updates = names.map((name) => {
      const snakeKey = camelToSnake(name);
      return {
        snakeKey,
        previousValue: staged.previous[snakeKey],
        nextValue: staged.data[snakeKey],
      };
    });
    const planned =
      staged.text === undefined ? undefined : planConfigWriteback(staged.text, updates, staged.data);
    const nextText = planned ?? serializeConfig(staged.data);
    if (nextText !== staged.text) await persist.save(nextText);
    rawSnake = staged.data;
    fileValues = staged.values;
    invalidateEffective();
    recompute('set', names);
  };

  const requirePersist = (): ConfigPersist => {
    if (deps.persist === undefined) {
      throw new Error('config persist is not configured');
    }
    return deps.persist;
  };

  const mergeFor = (section: ConfigSectionContribution | undefined): ConfigMerge =>
    section === undefined ? deepMerge : ((section.merge ?? replaceMerge) as ConfigMerge);

  return {
    section: <T,>(name: string): ShallowRef<T> => {
      let ref = refs.get(name);
      if (ref === undefined) {
        ref = shallowRef(deliveredValue(name));
        refs.set(name, ref);
      }
      return ref as ShallowRef<T>;
    },
    get: <T,>(name: string): T => deliveredValue(name) as T,
    env: (name) => getEnv(name),
    set: async (name, value, target) => {
      const section = sectionsByName.get(name);
      const merge = mergeFor(section);
      if (target === 'memory') {
        const merged = merge(memory[name], value);
        const validated = section === undefined ? merged : (section.schema.parse(merged) as unknown);
        if (validated === undefined) {
          delete memory[name];
        } else {
          memory[name] = validated;
        }
        recompute('set', [name]);
        return;
      }
      const persist = requirePersist();
      await enqueue(async () => {
        const staged = await stageOnDisk(persist);
        const merged = merge(staged.values[name], value);
        const validated = section === undefined ? merged : (section.schema.parse(merged) as unknown);
        applyStagedSection(staged, name, section, validated);
        await persistStaged(persist, staged, [name]);
      });
    },
    replace: async (sections, target) => {
      const names = Object.keys(sections);
      if (names.length === 0) return;
      if (target === 'memory') {
        for (const name of names) {
          const section = sectionsByName.get(name);
          const value = sections[name];
          if (value === undefined || value === null) {
            delete memory[name];
          } else {
            memory[name] = section === undefined ? value : (section.schema.parse(value) as unknown);
          }
        }
        recompute('set', names);
        return;
      }
      const persist = requirePersist();
      await enqueue(async () => {
        const staged = await stageOnDisk(persist);
        for (const name of names) {
          const value = sections[name];
          applyStagedSection(staged, name, sectionsByName.get(name), value === null ? undefined : value);
        }
        await persistStaged(persist, staged, names);
      });
    },
    reload: () => enqueue(() => loadFromDisk('reload')),
    diagnostics: () => [...diagnosticsList],
    syncSections: (list) => {
      const next = new Map<string, ConfigSectionContribution>();
      for (const item of list) next.set(item.name, item);
      const changed: string[] = [];
      for (const name of [...sectionsByName.keys()]) {
        if (next.has(name)) continue;
        sectionsByName.delete(name);
        changed.push(name);
        const rawValue = rawSnake[camelToSnake(name)];
        if (rawValue === undefined) {
          delete fileValues[name];
        } else {
          fileValues[name] = defaultFromToml(rawValue);
        }
      }
      for (const [name, section] of next) {
        if (sectionsByName.get(name) === section) continue;
        sectionsByName.set(name, section);
        changed.push(name);
        const raw = rawSnake[camelToSnake(name)];
        if (raw === undefined) {
          delete fileValues[name];
          continue;
        }
        try {
          const converted = section.fromToml === undefined ? defaultFromToml(raw) : section.fromToml(raw);
          fileValues[name] = section.schema.parse(converted) as unknown;
        } catch (error) {
          delete fileValues[name];
          pushDiagnostic({
            section: name,
            severity: 'warning',
            message: `Ignored invalid config section '${name}': ${describeUnknownError(error)}`,
          });
        }
      }
      if (changed.length > 0) {
        invalidateEffective();
        recompute('reload', changed);
      }
    },
    syncOverlays: (list) => {
      if (list.length === overlays.length && list.every((item, index) => item === overlays[index])) {
        return;
      }
      overlays = list;
      invalidateEffective();
      recompute('reload');
    },
    dispose: () => {
      closed = true;
    },
  };
}
