import type { ZodType } from 'zod';

import { shallowRef, type ShallowRef, type Unsubscribe } from '#/kernel/index';

import { applySectionEnv, type AnyEnvBindings, type EnvBindings, type GetEnv } from './env';
import { deepEqual, describeUnknownError, isPlainObject } from './pure';
import { describeTomlSyntaxError, parseConfigText, serializeConfig } from './toml';
import { planConfigWriteback } from './writeback';

export interface ConfigPersist {
  load(): Promise<string | undefined>;
  save(text: string): Promise<void>;
  watch?(onChange: () => void): Unsubscribe;
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

export interface ConfigSectionContribution<T = unknown> {
  readonly name: string;
  readonly schema: ZodType<T>;
  readonly defaultValue?: T;
  readonly merge?: ConfigMerge<T>;
  readonly envBindings?: EnvBindings<T>;
  readonly stripEnv?: ConfigStripEnv<T>;
  readonly deprecations?: readonly ConfigKeyDeprecation[];
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
  let rawFile: Record<string, unknown> = {};
  let fileValues: Record<string, unknown> = {};
  let memory: Record<string, unknown> = {};
  let chain = Promise.resolve();
  let closed = false;

  const getEnv: GetEnv = (name) => (deps.env === undefined ? process.env[name] : deps.env[name]);

  const pushDiagnostic = (diagnostic: ConfigDiagnostic): void => {
    const duplicate = diagnosticsList.some(
      (existing) =>
        existing.section === diagnostic.section &&
        existing.severity === diagnostic.severity &&
        existing.message === diagnostic.message,
    );
    if (!duplicate) diagnosticsList.push(diagnostic);
  };

  const effectiveFor = (section: ConfigSectionContribution): unknown => {
    const base = Object.prototype.hasOwnProperty.call(fileValues, section.name)
      ? fileValues[section.name]
      : section.defaultValue;
    if (section.envBindings === undefined) return base;
    try {
      const next = applySectionEnv(base, section.envBindings as AnyEnvBindings, getEnv, (oldName, newName) => {
        pushDiagnostic({
          section: section.name,
          severity: 'warning',
          message: `Environment variable ${oldName} is deprecated; use ${newName} instead.`,
        });
      });
      return section.schema.parse(next) as unknown;
    } catch (error) {
      pushDiagnostic({
        section: section.name,
        severity: 'warning',
        message: `Ignoring env overlay for '${section.name}': ${describeUnknownError(error)}`,
      });
      return base;
    }
  };

  const deliveredFor = (section: ConfigSectionContribution): unknown =>
    Object.prototype.hasOwnProperty.call(memory, section.name)
      ? memory[section.name]
      : effectiveFor(section);

  const recompute = (source: ConfigChangeSource, names?: readonly string[]): void => {
    const targets = names ?? [...sectionsByName.keys()];
    for (const name of targets) {
      const section = sectionsByName.get(name);
      if (section === undefined) continue;
      const value = deliveredFor(section);
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
    const values: Record<string, unknown> = {};
    for (const section of sectionsByName.values()) {
      const raw = data[section.name];
      if (raw === undefined) continue;
      try {
        values[section.name] = section.schema.parse(raw) as unknown;
      } catch (error) {
        pushDiagnostic({
          section: section.name,
          severity: 'warning',
          message: `Ignored invalid config section '${section.name}': ${describeUnknownError(error)}`,
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
    rawFile = data;
    for (const section of sectionsByName.values()) {
      const deprecations = section.deprecations;
      if (deprecations === undefined || deprecations.length === 0) continue;
      const rawSection = data[section.name];
      if (!isPlainObject(rawSection)) continue;
      for (const deprecation of deprecations) {
        if (rawSection[deprecation.key] === undefined) continue;
        pushDiagnostic({
          section: section.name,
          severity: 'warning',
          message:
            `[${section.name}] '${deprecation.key}' is deprecated and no longer used; ` +
            `rename it to '${deprecation.replacement}'.` +
            (deprecation.message === undefined ? '' : ` ${deprecation.message}`),
        });
      }
    }
    fileValues = buildFileValues(data);
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
    return { text, previous, data: { ...previous }, values: buildFileValues(previous) };
  };

  const applyStagedSection = (
    staged: StagedFile,
    section: ConfigSectionContribution,
    value: unknown,
  ): void => {
    if (value === undefined) {
      delete staged.data[section.name];
      delete staged.values[section.name];
      return;
    }
    const stripped =
      section.stripEnv === undefined ? value : section.stripEnv(value, staged.previous[section.name], getEnv);
    if (stripped === undefined) {
      delete staged.data[section.name];
      delete staged.values[section.name];
      return;
    }
    const parsed = section.schema.parse(stripped) as unknown;
    staged.data[section.name] = parsed;
    staged.values[section.name] = parsed;
  };

  const persistStaged = async (
    persist: ConfigPersist,
    staged: StagedFile,
    names: readonly string[],
  ): Promise<void> => {
    const updates = names.map((name) => ({
      key: name,
      previousValue: staged.previous[name],
      nextValue: staged.data[name],
    }));
    const planned =
      staged.text === undefined ? undefined : planConfigWriteback(staged.text, updates, staged.data);
    const nextText = planned ?? serializeConfig(staged.data);
    if (nextText !== staged.text) await persist.save(nextText);
    rawFile = staged.data;
    fileValues = staged.values;
    recompute('set', names);
  };

  const requireSection = (name: string): ConfigSectionContribution => {
    const section = sectionsByName.get(name);
    if (section === undefined) {
      throw new Error(`config section '${name}' is not registered`);
    }
    return section;
  };

  const requirePersist = (): ConfigPersist => {
    if (deps.persist === undefined) {
      throw new Error('config persist is not configured');
    }
    return deps.persist;
  };

  return {
    section: <T,>(name: string): ShallowRef<T> => {
      let ref = refs.get(name);
      if (ref === undefined) {
        const registered = sectionsByName.get(name);
        ref = shallowRef(registered === undefined ? undefined : deliveredFor(registered));
        refs.set(name, ref);
      }
      return ref as ShallowRef<T>;
    },
    get: <T,>(name: string): T => {
      const registered = sectionsByName.get(name);
      if (registered === undefined) return undefined as T;
      return deliveredFor(registered) as T;
    },
    env: (name) => getEnv(name),
    set: async (name, value, target) => {
      const section = requireSection(name);
      const merge = (section.merge ?? replaceMerge) as ConfigMerge;
      if (target === 'memory') {
        const merged = merge(memory[name], value);
        const validated = section.schema.parse(merged) as unknown;
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
        const validated = section.schema.parse(merged) as unknown;
        applyStagedSection(staged, section, validated);
        await persistStaged(persist, staged, [name]);
      });
    },
    replace: async (sections, target) => {
      const names = Object.keys(sections);
      if (names.length === 0) return;
      for (const name of names) requireSection(name);
      if (target === 'memory') {
        for (const name of names) {
          const value = sections[name];
          if (value === undefined || value === null) {
            delete memory[name];
          } else {
            memory[name] = sectionsByName.get(name)!.schema.parse(value) as unknown;
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
          applyStagedSection(staged, sectionsByName.get(name)!, value === null ? undefined : value);
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
        delete fileValues[name];
        const ref = refs.get(name);
        if (ref !== undefined && ref.value !== undefined) {
          const previousValue = ref.value;
          ref.value = undefined;
          deps.onChanged?.(name, undefined, previousValue, 'reload');
        }
      }
      for (const [name, section] of next) {
        if (sectionsByName.get(name) === section) continue;
        sectionsByName.set(name, section);
        changed.push(name);
        const raw = rawFile[name];
        if (raw === undefined) continue;
        try {
          fileValues[name] = section.schema.parse(raw) as unknown;
        } catch (error) {
          pushDiagnostic({
            section: name,
            severity: 'warning',
            message: `Ignored invalid config section '${name}': ${describeUnknownError(error)}`,
          });
        }
      }
      if (changed.length > 0) recompute('reload', changed);
    },
    dispose: () => {
      closed = true;
    },
  };
}
