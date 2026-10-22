import { createFeature, type Feature } from '#/app/index';
import {
  createCollection,
  createFacadeToken,
  shallowRef,
  useCleanup,
  useCollection,
  useContribute,
  useExpose,
  useFire,
  useInject,
  useReady,
  watch,
  type RuntimeEvent,
  type ShallowRef,
} from '#/kernel/index';

import { applySectionEnv, type AnyEnvBindings, type GetEnv } from './env';
import { deepEqual, deepMerge, describeUnknownError, isPlainObject } from './pure';
import type {
  ConfigChangeSource,
  ConfigDiagnostic,
  ConfigInspectValue,
  ConfigMerge,
  ConfigOverlayContribution,
  ConfigPersist,
  ConfigSectionContribution,
  ConfigStore,
  ConfigTarget,
} from './store';
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

export const ConfigSections = createCollection<ConfigSectionContribution>('config.sections');

export const ConfigOverlays = createCollection<ConfigOverlayContribution>('config.overlays');

export const ConfigRef = createFacadeToken<ConfigStore>('config');

export function useConfigSection<T>(section: ConfigSectionContribution<T>): void {
  useContribute(ConfigSections, section as ConfigSectionContribution);
}

export function useConfigOverlay(contribution: ConfigOverlayContribution): void {
  useContribute(ConfigOverlays, contribution);
}

export function useConfig(): Readonly<ShallowRef<ConfigStore | undefined>> {
  return useInject(ConfigRef);
}

export interface ConfigChangedEvent extends RuntimeEvent {
  readonly type: 'config.changed';
  readonly section: string;
  readonly value: unknown;
  readonly previousValue: unknown;
  readonly source: ConfigChangeSource;
}

interface StagedFile {
  readonly text: string | undefined;
  readonly previous: Record<string, unknown>;
  readonly data: Record<string, unknown>;
  values: Record<string, unknown>;
}

const replaceMerge: ConfigMerge = (_base, patch) => patch;

export function createConfig(deps: {
  readonly persist?: ConfigPersist;
  readonly env?: Record<string, string | undefined>;
}): Feature<void, { app: ConfigChangedEvent }> {
  return createFeature<{ app: ConfigChangedEvent }>('config', {
    app() {
      const fire = useFire();
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

      const _getEnv: GetEnv = (name) => (deps.env === undefined ? process.env[name] : deps.env[name]);

      const _lookupSection = (name: string): ConfigSectionContribution | undefined =>
        sectionsByName.get(name);

      const _pushDiagnostic = (diagnostic: ConfigDiagnostic): void => {
        const duplicate = diagnosticsList.some(
          (existing) =>
            existing.section === diagnostic.section &&
            existing.severity === diagnostic.severity &&
            existing.message === diagnostic.message,
        );
        if (!duplicate) diagnosticsList.push(diagnostic);
      };

      const _validateOverlayValue = (name: string, value: unknown): unknown => {
        const section = sectionsByName.get(name);
        return section === undefined ? value : (section.schema.parse(value) as unknown);
      };

      const _computeEffective = (): Record<string, unknown> => {
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
            const next = applySectionEnv(base, section.envBindings as AnyEnvBindings, _getEnv, (oldName, newName) => {
              _pushDiagnostic({
                section: name,
                severity: 'warning',
                message: `Environment variable ${oldName} is deprecated; use ${newName} instead.`,
              });
            });
            effective[name] = section.schema.parse(next) as unknown;
          } catch (error) {
            _pushDiagnostic({
              section: name,
              severity: 'warning',
              message: `Ignoring env overlay for '${name}': ${describeUnknownError(error)}`,
            });
            if (base !== undefined) effective[name] = base;
          }
        }
        for (const overlay of overlays) {
          try {
            overlay.apply(effective, _getEnv, _validateOverlayValue);
          } catch (error) {
            _pushDiagnostic({
              severity: 'warning',
              message: `Ignoring config environment overlay: ${describeUnknownError(error)}`,
            });
          }
        }
        return effective;
      };

      const _effectiveValues = (): Record<string, unknown> => (effectiveCache ??= _computeEffective());

      const _invalidateEffective = (): void => {
        effectiveCache = undefined;
      };

      const _deliveredValue = (name: string): unknown => {
        if (Object.prototype.hasOwnProperty.call(memory, name)) return memory[name];
        return _effectiveValues()[name];
      };

      const _recompute = (source: ConfigChangeSource, names?: readonly string[]): void => {
        const effective = _effectiveValues();
        const targets =
          names ??
          [...new Set([...sectionsByName.keys(), ...Object.keys(effective), ...refs.keys()])];
        for (const name of targets) {
          const value = Object.prototype.hasOwnProperty.call(memory, name) ? memory[name] : effective[name];
          let ref = refs.get(name);
          if (ref === undefined) {
            ref = shallowRef(value);
            refs.set(name, ref);
            fire({ type: 'config.changed', section: name, value, previousValue: undefined, source });
            continue;
          }
          if (deepEqual(ref.value, value)) continue;
          const previousValue = ref.value;
          ref.value = value;
          fire({ type: 'config.changed', section: name, value, previousValue, source });
        }
      };

      const _buildFileValues = (data: Record<string, unknown>): Record<string, unknown> => {
        const transformed = transformTomlData(data, _lookupSection);
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
            _pushDiagnostic({
              section: name,
              severity: 'warning',
              message: `Ignored invalid config section '${name}': ${describeUnknownError(error)}`,
            });
          }
        }
        return values;
      };

      const _loadFromDisk = async (source: ConfigChangeSource): Promise<void> => {
        diagnosticsList.length = 0;
        let data: Record<string, unknown> = {};
        if (deps.persist !== undefined) {
          try {
            const text = await deps.persist.load();
            if (text !== undefined) data = parseConfigText(text);
          } catch (error) {
            _pushDiagnostic({
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
            _pushDiagnostic({
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
            _pushDiagnostic(diagnostic);
          }
        }
        fileValues = _buildFileValues(data);
        _invalidateEffective();
        _recompute(source);
      };

      const _enqueue = <T,>(task: () => Promise<T>): Promise<T> => {
        const run = chain.then(() => (closed ? (undefined as T) : task()));
        chain = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      };

      const _stageOnDisk = async (persist: ConfigPersist): Promise<StagedFile> => {
        let text: string | undefined;
        let previous: Record<string, unknown> = {};
        try {
          text = await persist.load();
          if (text !== undefined) previous = parseConfigText(text);
        } catch (error) {
          _pushDiagnostic({
            severity: 'error',
            message: `Failed to load config: ${describeTomlSyntaxError(error)}`,
          });
          throw new Error('refusing to persist config: the config file could not be read');
        }
        return { text, previous, data: cloneRecord(previous), values: _buildFileValues(previous) };
      };

      const _applyStagedSection = (
        staged: StagedFile,
        name: string,
        section: ConfigSectionContribution | undefined,
        value: unknown,
      ): void => {
        if (value === undefined) {
          applySectionToToml(staged.data, name, undefined, _lookupSection);
          delete staged.values[name];
          return;
        }
        let stripped: unknown =
          section?.stripEnv === undefined ? value : section.stripEnv(value, staged.values[name], _getEnv);
        if (stripped !== undefined) {
          for (const overlay of overlays) {
            if (overlay.strip === undefined) continue;
            stripped = overlay.strip(name, stripped, staged.data);
            if (stripped === undefined) break;
          }
        }
        if (stripped === undefined) {
          applySectionToToml(staged.data, name, undefined, _lookupSection);
          delete staged.values[name];
          return;
        }
        const parsed = section === undefined ? stripped : (section.schema.parse(stripped) as unknown);
        staged.values[name] = parsed;
        applySectionToToml(staged.data, name, parsed, _lookupSection);
      };

      const _persistStaged = async (
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
        _invalidateEffective();
        _recompute('set', names);
      };

      const _requirePersist = (): ConfigPersist => {
        if (deps.persist === undefined) {
          throw new Error('config persist is not configured');
        }
        return deps.persist;
      };

      const _mergeFor = (section: ConfigSectionContribution | undefined): ConfigMerge =>
        section === undefined ? deepMerge : ((section.merge ?? replaceMerge) as ConfigMerge);

      const section = <T,>(name: string): ShallowRef<T> => {
        let ref = refs.get(name);
        if (ref === undefined) {
          ref = shallowRef(_deliveredValue(name));
          refs.set(name, ref);
        }
        return ref as ShallowRef<T>;
      };

      const get = <T,>(name: string): T => _deliveredValue(name) as T;

      const inspect = <T,>(name: string): ConfigInspectValue<T> => ({
        value: _deliveredValue(name) as T | undefined,
        defaultValue: sectionsByName.get(name)?.defaultValue as T | undefined,
        userValue: fileValues[name] as T | undefined,
        memoryValue: memory[name] as T | undefined,
      });

      const env = (name: string): string | undefined => _getEnv(name);

      const set = async (name: string, value: unknown, target: ConfigTarget): Promise<void> => {
        const sectionContribution = sectionsByName.get(name);
        const merge = _mergeFor(sectionContribution);
        if (target === 'memory') {
          const merged = merge(memory[name], value);
          const validated =
            sectionContribution === undefined ? merged : (sectionContribution.schema.parse(merged) as unknown);
          if (validated === undefined) {
            delete memory[name];
          } else {
            memory[name] = validated;
          }
          _recompute('set', [name]);
          return;
        }
        const persist = _requirePersist();
        await _enqueue(async () => {
          const staged = await _stageOnDisk(persist);
          const merged = merge(staged.values[name], value);
          const validated =
            sectionContribution === undefined ? merged : (sectionContribution.schema.parse(merged) as unknown);
          _applyStagedSection(staged, name, sectionContribution, validated);
          await _persistStaged(persist, staged, [name]);
        });
      };

      const replace = async (
        sections: Readonly<Record<string, unknown>>,
        target: ConfigTarget,
      ): Promise<void> => {
        const names = Object.keys(sections);
        if (names.length === 0) return;
        if (target === 'memory') {
          for (const name of names) {
            const sectionContribution = sectionsByName.get(name);
            const value = sections[name];
            if (value === undefined || value === null) {
              delete memory[name];
            } else {
              memory[name] =
                sectionContribution === undefined ? value : (sectionContribution.schema.parse(value) as unknown);
            }
          }
          _recompute('set', names);
          return;
        }
        const persist = _requirePersist();
        await _enqueue(async () => {
          const staged = await _stageOnDisk(persist);
          for (const name of names) {
            const value = sections[name];
            _applyStagedSection(staged, name, sectionsByName.get(name), value === null ? undefined : value);
          }
          await _persistStaged(persist, staged, names);
        });
      };

      const reload = (): Promise<void> => _enqueue(() => _loadFromDisk('reload'));

      const diagnostics = (): readonly ConfigDiagnostic[] => [...diagnosticsList];

      const dispose = (): void => {
        closed = true;
      };

      const _syncSections = (list: readonly ConfigSectionContribution[]): void => {
        const next = new Map<string, ConfigSectionContribution>();
        for (const item of list) next.set(item.name, item);
        const changed: string[] = [];
        for (const name of sectionsByName.keys()) {
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
        for (const [name, sectionContribution] of next) {
          if (sectionsByName.get(name) === sectionContribution) continue;
          sectionsByName.set(name, sectionContribution);
          changed.push(name);
          const raw = rawSnake[camelToSnake(name)];
          if (raw === undefined) {
            delete fileValues[name];
            continue;
          }
          try {
            const converted =
              sectionContribution.fromToml === undefined
                ? defaultFromToml(raw)
                : sectionContribution.fromToml(raw);
            fileValues[name] = sectionContribution.schema.parse(converted) as unknown;
          } catch (error) {
            delete fileValues[name];
            _pushDiagnostic({
              section: name,
              severity: 'warning',
              message: `Ignored invalid config section '${name}': ${describeUnknownError(error)}`,
            });
          }
        }
        if (changed.length > 0) {
          _invalidateEffective();
          _recompute('reload', changed);
        }
      };

      const _syncOverlays = (list: readonly ConfigOverlayContribution[]): void => {
        if (list.length === overlays.length && list.every((item, index) => item === overlays[index])) {
          return;
        }
        overlays = list;
        _invalidateEffective();
        _recompute('reload');
      };

      const contributed = useCollection(ConfigSections);
      watch(
        contributed,
        (list) => {
          _syncSections(list);
        },
        { immediate: true },
      );
      const contributedOverlays = useCollection(ConfigOverlays);
      watch(
        contributedOverlays,
        (list) => {
          _syncOverlays(list);
        },
        { immediate: true },
      );
      useReady(reload());
      useExpose(ConfigRef, {
        section,
        get,
        inspect,
        env,
        set,
        replace,
        reload,
        diagnostics,
        dispose,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = deps.persist?.watch?.(() => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          void reload();
        }, 150);
      });
      if (off !== undefined) {
        useCleanup(() => {
          if (timer !== undefined) clearTimeout(timer);
          off();
        });
      }
      useCleanup(dispose);
    },
  });
}
