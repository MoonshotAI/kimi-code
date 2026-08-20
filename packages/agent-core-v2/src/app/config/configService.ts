import { type CollectionView } from '#/_base/di/collection';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { BugIndicatingError, Error2, ErrorCodes, onUnexpectedError } from '#/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ILogService } from '#/_base/log/log';
import {
  IAtomicTomlDocumentStore,
  type IAtomicDocumentStore,
} from '#/persistence/interface/atomicDocumentStore';

import {
  type AnyEnvBindings,
  type ConfigChangedEvent,
  type ConfigDiagnostic,
  type ConfigSectionChangedEvent,
  type ConfigEffectiveOverlay,
  type ConfigInspectValue,
  type ConfigMerge,
  type ConfigOverlayRegisteredEvent,
  type ConfigSchema,
  type ConfigSection,
  type ConfigSectionRegisteredEvent,
  type ConfigChangeSource,
  type EnvBinding,
  type RegisterSectionOptions,
  type ResolvedConfig,
  ConfigScope,
  ConfigTarget,
  IConfigRegistry,
  IConfigService,
} from './config';
import { deepEqual, deepMerge, describeUnknownError, isPlainObject } from './configPure';
import {
  ConfigSectionContribution,
  getConfigSectionContributions,
} from './configSectionContributions';
import { getConfigOverlayContributions } from './configOverlayContributions';
import { collectKeyDeprecations } from './deprecations';
import { migrateThinkingEffortMaxToHigh } from './migrations';
import {
  applySectionToToml,
  camelToSnake,
  cloneRecord,
  describeTomlSyntaxError,
  TomlError,
  transformTomlData,
} from './toml';

const CONFIG_SCOPE = '';

type GetEnv = (name: string) => string | undefined;

type OnDeprecatedEnv = (oldName: string, newName: string) => void;

function isEnvBinding(value: unknown): value is EnvBinding {
  return typeof value === 'string' || (isPlainObject(value) && 'env' in value);
}

function parseBoundRaw(binding: EnvBinding, raw: string): unknown {
  return typeof binding === 'string' ? raw : binding.parse ? binding.parse(raw) : raw;
}

function resolveBinding(
  binding: EnvBinding,
  getEnv: GetEnv,
  existing: unknown,
  onDeprecatedEnv?: OnDeprecatedEnv,
): unknown {
  if (typeof binding !== 'string') {
    const raw = getEnv(binding.env);
    if (raw !== undefined) {
      const parsed = parseBoundRaw(binding, raw);
      if (parsed !== undefined) return parsed;
    }
    if (binding.deprecatedEnv !== undefined) {
      const deprecatedRaw = getEnv(binding.deprecatedEnv);
      if (deprecatedRaw !== undefined) {
        const parsed = parseBoundRaw(binding, deprecatedRaw);
        if (parsed !== undefined) {
          onDeprecatedEnv?.(binding.deprecatedEnv, binding.env);
          return parsed;
        }
      }
    }
  } else {
    const raw = getEnv(binding);
    if (raw !== undefined) return raw;
  }
  if (typeof binding === 'object' && binding.default !== undefined && existing === undefined) {
    return binding.default;
  }
  return existing;
}

function applyEnvBindings(
  target: Record<string, unknown>,
  bindings: AnyEnvBindings,
  getEnv: GetEnv,
  onDeprecatedEnv?: OnDeprecatedEnv,
): void {
  for (const [key, binding] of Object.entries(bindings)) {
    if (isEnvBinding(binding)) {
      const resolved = resolveBinding(binding, getEnv, target[key], onDeprecatedEnv);
      if (resolved !== undefined) target[key] = resolved;
    } else if (binding !== undefined) {
      const child: Record<string, unknown> = isPlainObject(target[key])
        ? { ...target[key] }
        : {};
      target[key] = child;
      applyEnvBindings(child, binding as AnyEnvBindings, getEnv, onDeprecatedEnv);
      if (Object.keys(child).length === 0) {
        delete target[key];
      }
    }
  }
}

function applySectionEnv(
  base: unknown,
  env: AnyEnvBindings,
  getEnv: GetEnv,
  onDeprecatedEnv?: OnDeprecatedEnv,
): unknown {
  if (isEnvBinding(env)) {
    return resolveBinding(env, getEnv, base, onDeprecatedEnv);
  }
  const target: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  applyEnvBindings(target, env, getEnv, onDeprecatedEnv);
  return target;
}

function isSameSection(
  existing: ConfigSection,
  schema: ConfigSchema<unknown>,
  options: RegisterSectionOptions<unknown>,
): boolean {
  return (
    existing.schema === schema &&
    existing.merge === (options.merge ?? deepMerge) &&
    existing.scope === (options.scope ?? ConfigScope.Core) &&
    existing.env === (options.env as ConfigSection['env']) &&
    existing.stripEnv === (options.stripEnv as ConfigSection['stripEnv']) &&
    existing.fromToml === options.fromToml &&
    existing.toToml === options.toToml &&
    deepEqual(existing.defaultValue, options.defaultValue) &&
    deepEqual(existing.deprecations, options.deprecations)
  );
}

export class ConfigRegistry extends Disposable implements IConfigRegistry {
  declare readonly _serviceBrand: undefined;
  private readonly sections = new Map<string, ConfigSection>();
  private readonly overlays: ConfigEffectiveOverlay[] = [];
  private readonly _onDidRegisterSection = this._register(
    new Emitter<ConfigSectionRegisteredEvent>(),
  );
  readonly onDidRegisterSection: Event<ConfigSectionRegisteredEvent> =
    this._onDidRegisterSection.event;
  private readonly _onDidUnregisterSection = this._register(
    new Emitter<ConfigSectionRegisteredEvent>(),
  );
  readonly onDidUnregisterSection: Event<ConfigSectionRegisteredEvent> =
    this._onDidUnregisterSection.event;
  private readonly _onDidRegisterOverlay = this._register(
    new Emitter<ConfigOverlayRegisteredEvent>(),
  );
  readonly onDidRegisterOverlay: Event<ConfigOverlayRegisteredEvent> =
    this._onDidRegisterOverlay.event;
  private readonly foldDomains = new Set<string>();

  constructor(
    @ConfigSectionContribution view?: CollectionView<ConfigSectionContribution>,
  ) {
    super();
    for (const c of getConfigSectionContributions()) {
      this.registerSection(c.domain, c.schema, c.options);
    }
    for (const overlay of getConfigOverlayContributions()) {
      this.registerEffectiveOverlay(overlay);
    }
    if (view === undefined) return;
    for (const item of view.items) {
      this.addContribution(item);
    }
    this._register(
      view.onDidChange((change) => {
        for (const contribution of change.removed) {
          this.removeContribution(contribution);
        }
        for (const contribution of change.added) {
          this.addContribution(contribution);
        }
      }),
    );
  }

  private addContribution(contribution: ConfigSectionContribution): void {
    const before = this.sections.get(contribution.domain);
    try {
      this.registerSection(contribution.domain, contribution.schema, contribution.options);
    } catch (error) {
      onUnexpectedError(error);
      return;
    }
    if (before === undefined && this.sections.get(contribution.domain) !== undefined) {
      this.foldDomains.add(contribution.domain);
    }
  }

  private removeContribution(contribution: ConfigSectionContribution): void {
    if (!this.foldDomains.delete(contribution.domain)) return;
    this.unregisterSection(contribution.domain);
  }

  registerSection<T>(
    domain: string,
    schema: ConfigSchema<T>,
    options: RegisterSectionOptions<T> = {},
  ): void {
    const existing = this.sections.get(domain);
    if (existing !== undefined) {
      if (
        isSameSection(
          existing,
          schema as ConfigSchema<unknown>,
          options as RegisterSectionOptions<unknown>,
        )
      ) {
        return;
      }
      throw new BugIndicatingError(`ConfigRegistry: section '${domain}' is already registered`);
    }
    this.sections.set(domain, {
      domain,
      schema: schema as ConfigSchema<unknown>,
      defaultValue: options.defaultValue,
      merge: (options.merge ?? deepMerge) as ConfigMerge<unknown>,
      scope: options.scope ?? ConfigScope.Core,
      env: options.env as ConfigSection['env'],
      stripEnv: options.stripEnv as ConfigSection['stripEnv'],
      fromToml: options.fromToml,
      toToml: options.toToml,
      deprecations: options.deprecations,
    });
    this._onDidRegisterSection.fire({ domain });
  }

  unregisterSection(domain: string): void {
    if (!this.sections.delete(domain)) return;
    this._onDidUnregisterSection.fire({ domain });
  }

  getSection(domain: string): ConfigSection | undefined {
    return this.sections.get(domain);
  }

  listSections(): readonly ConfigSection[] {
    return [...this.sections.values()];
  }

  registerEffectiveOverlay(overlay: ConfigEffectiveOverlay): void {
    this.overlays.push(overlay);
    this._onDidRegisterOverlay.fire({ overlay });
  }

  listEffectiveOverlays(): readonly ConfigEffectiveOverlay[] {
    return [...this.overlays];
  }

  validate<T>(domain: string, value: unknown): T {
    const schema = this.sections.get(domain)?.schema;
    return (schema === undefined ? value : schema.parse(value)) as T;
  }

  merge<T>(domain: string, base: T | undefined, patch: unknown): T {
    const merge = this.sections.get(domain)?.merge ?? deepMerge;
    return merge(base, patch) as T;
  }

  defaultValue<T>(domain: string): T | undefined {
    return this.sections.get(domain)?.defaultValue as T | undefined;
  }
}

export class ConfigService extends Disposable implements IConfigService {
  declare readonly _serviceBrand: undefined;
  private readonly _onDidChangeConfiguration = this._register(new Emitter<ConfigChangedEvent>());
  readonly onDidChangeConfiguration: Event<ConfigChangedEvent> = this._onDidChangeConfiguration.event;
  private readonly _onDidSectionChange = this._register(new Emitter<ConfigSectionChangedEvent>());
  readonly onDidSectionChange: Event<ConfigSectionChangedEvent> = this._onDidSectionChange.event;
  private readonly _onDidChangeDiagnostics = this._register(
    new Emitter<readonly ConfigDiagnostic[]>(),
  );
  readonly onDidChangeDiagnostics: Event<readonly ConfigDiagnostic[]> =
    this._onDidChangeDiagnostics.event;
  readonly ready: Promise<void>;

  private stateChain: Promise<unknown> = Promise.resolve();

  private rawSnake: ResolvedConfig = {};
  private raw: ResolvedConfig = {};
  private validated: ResolvedConfig = {};
  private effective: ResolvedConfig = {};
  private memory: ResolvedConfig = {};
  private delivered: ResolvedConfig = {};
  private readonly diagnosticsList: ConfigDiagnostic[] = [];
  private lastDiagnosticsSnapshot = '[]';
  private readonly configKey: string;
  private tainted = false;

  constructor(
    @IConfigRegistry private readonly registry: IConfigRegistry,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
    @IAtomicTomlDocumentStore private readonly documentStore: IAtomicDocumentStore,
  ) {
    super();
    this.configKey = this.bootstrap.configKey;
    this._register(this.registry.onDidRegisterSection((e) => this.revalidateDomain(e.domain)));
    this._register(this.registry.onDidUnregisterSection((e) => this.devalidateDomain(e.domain)));
    this._register(this.registry.onDidRegisterOverlay(() => this.reapplyOverlays()));
    const { configKey } = this;
    const { homeDir } = this.bootstrap;
    this.ready = (async () => {
      await migrateThinkingEffortMaxToHigh(this.documentStore, configKey, homeDir);
      await this.load('load');
    })();
    this._register(
      this.documentStore.watch(CONFIG_SCOPE, this.configKey)(() => {
        void this.reload();
      }),
    );
  }

  get<T = unknown>(domain: string): T {
    if (Object.prototype.hasOwnProperty.call(this.memory, domain)) {
      return this.memory[domain] as T;
    }
    return this.freshEffective()[domain] as T;
  }

  inspect<T = unknown>(domain: string): ConfigInspectValue<T> {
    const memoryValue = this.memory[domain] as T | undefined;
    return {
      value: this.get<T>(domain),
      defaultValue: this.registry.defaultValue<T>(domain),
      userValue: this.raw[domain] as T | undefined,
      memoryValue,
    };
  }

  getAll(): ResolvedConfig {
    return { ...this.freshEffective(), ...this.memory };
  }

  private freshEffective(): ResolvedConfig {
    const effective: ResolvedConfig = { ...this.validated };
    this.applySectionEnvBindings(effective, false);
    this.applyEnvOverlay(effective, false);
    return effective;
  }

  diagnostics(): readonly ConfigDiagnostic[] {
    return [...this.diagnosticsList];
  }

  /** Append a diagnostic, skipping exact duplicates (rebuilds re-run the same checks). */
  private pushDiagnostic(diagnostic: ConfigDiagnostic): void {
    const duplicate = this.diagnosticsList.some(
      (existing) =>
        existing.domain === diagnostic.domain &&
        existing.severity === diagnostic.severity &&
        existing.message === diagnostic.message,
    );
    if (!duplicate) this.diagnosticsList.push(diagnostic);
  }

  private emitDiagnosticsIfChanged(): void {
    const snapshot = JSON.stringify(this.diagnosticsList);
    if (snapshot === this.lastDiagnosticsSnapshot) return;
    this.lastDiagnosticsSnapshot = snapshot;
    this._onDidChangeDiagnostics.fire(this.diagnostics());
  }

  async set(
    domain: string,
    patch: unknown,
    target: ConfigTarget = ConfigTarget.User,
  ): Promise<void> {
    await this.ready;
    if (target === ConfigTarget.Memory) {
      const next = this.registry.merge(domain, this.memory[domain], patch);
      const validated = this.registry.validate(domain, next);
      if (validated === undefined) {
        delete this.memory[domain];
      } else {
        this.memory[domain] = validated;
      }
      this.commit('set', [domain]);
      return;
    }
    await this.enqueueStateTransition(async () => {
      this.assertPersistable();
      await this.persist(domain, (stagedRaw, stagedRawSnake) => {
        const next = this.registry.merge(domain, stagedRaw[domain], patch);
        const validated = this.registry.validate(domain, next);
        const stripped = this.stripEnv(domain, validated, stagedRaw, stagedRawSnake);
        if (stripped === undefined) {
          delete stagedRaw[domain];
        } else {
          this.registry.validate(domain, stripped);
          stagedRaw[domain] = stripped;
        }
      });
      this.rebuildEffective('set', [domain]);
    });
  }

  async replace(
    domain: string,
    value: unknown,
    target: ConfigTarget = ConfigTarget.User,
  ): Promise<void> {
    await this.ready;
    const effectiveValue = value === null ? undefined : value;
    if (target === ConfigTarget.Memory) {
      if (effectiveValue === undefined) {
        delete this.memory[domain];
      } else {
        this.memory[domain] = this.registry.validate(domain, effectiveValue);
      }
      this.commit('set', [domain]);
      return;
    }
    await this.enqueueStateTransition(async () => {
      this.assertPersistable();
      await this.persist(domain, (stagedRaw, stagedRawSnake) => {
        const stripped = this.stripEnv(domain, effectiveValue, stagedRaw, stagedRawSnake);
        if (stripped === undefined) {
          delete stagedRaw[domain];
        } else {
          stagedRaw[domain] = this.registry.validate(domain, stripped);
        }
      });
      this.rebuildEffective('set', [domain]);
    });
  }

  async replaceSections(
    sections: Readonly<Record<string, unknown>>,
    target: ConfigTarget = ConfigTarget.User,
  ): Promise<void> {
    await this.ready;
    const domains = Object.keys(sections);
    if (domains.length === 0) return;
    if (target === ConfigTarget.Memory) {
      const staged: ResolvedConfig = { ...this.memory };
      for (const domain of domains) {
        const value = sections[domain];
        if (value === undefined || value === null) {
          delete staged[domain];
        } else {
          staged[domain] = this.registry.validate(domain, value);
        }
      }
      this.memory = staged;
      this.commit('set', domains);
      return;
    }
    await this.enqueueStateTransition(async () => {
      this.assertPersistable();
      await this.persistDomains(domains, (stagedRaw, stagedRawSnake) => {
        for (const domain of domains) {
          const value = sections[domain] === null ? undefined : sections[domain];
          const stripped = this.stripEnv(domain, value, stagedRaw, stagedRawSnake);
          if (stripped === undefined) {
            delete stagedRaw[domain];
          } else {
            stagedRaw[domain] = this.registry.validate(domain, stripped);
          }
        }
      });
      this.rebuildEffective('set', domains);
    });
  }

  private stripEnv(
    domain: string,
    value: unknown,
    raw: ResolvedConfig,
    rawSnake: ResolvedConfig,
  ): unknown {
    let result = value;
    const section = this.registry.getSection(domain);
    if (section?.stripEnv !== undefined) {
      const getEnv = (name: string): string | undefined => this.bootstrap.getEnv(name);
      result = section.stripEnv(result, raw[domain], getEnv);
    }
    if (result === undefined) return result;
    for (const overlay of this.registry.listEffectiveOverlays()) {
      if (overlay.strip === undefined) continue;
      result = overlay.strip(domain, result, rawSnake);
      if (result === undefined) return result;
    }
    return result;
  }

  async reload(): Promise<void> {
    await this.ready;
    await this.enqueueStateTransition(() => this.load('reload'));
  }

  private enqueueStateTransition<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.stateChain.then(() => fn());
    this.stateChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(source: ConfigChangeSource): Promise<void> {
    this.diagnosticsList.length = 0;
    let fileData: ResolvedConfig = {};
    let failed = false;
    try {
      const data = await this.documentStore.get<ResolvedConfig>(CONFIG_SCOPE, this.configKey);
      fileData = data !== undefined && isPlainObject(data) ? data : {};
    } catch (error) {
      failed = true;
      const message =
        error instanceof TomlError
          ? `Failed to parse ${this.bootstrap.configPath}: ${describeTomlSyntaxError(error)}`
          : describeUnknownError(error);
      this.pushDiagnostic({ severity: 'error', message });
      this.log.warn('config load failed', { error: describeUnknownError(error) });
      if (source !== 'load') {
        this.tainted = true;
        this.emitDiagnosticsIfChanged();
        return;
      }
    }
    this.tainted = failed;
    const nextRawSnake = cloneRecord(fileData);
    for (const diagnostic of collectKeyDeprecations(nextRawSnake, this.registry.listSections())) {
      this.pushDiagnostic(diagnostic);
    }
    if (source !== 'load' && JSON.stringify(nextRawSnake) === JSON.stringify(this.rawSnake)) {
      const scratch = { ...this.validated };
      this.applySectionEnvBindings(scratch, true);
      this.applyEnvOverlay(scratch);
      this.emitDiagnosticsIfChanged();
      return;
    }
    this.rawSnake = nextRawSnake;
    this.raw = transformTomlData(fileData, this.registry);
    this.rebuildEffective(source);
  }

  private rebuildEffective(
    source: ConfigChangeSource = 'reload',
    domains?: readonly string[],
  ): void {
    const previous = this.effective;
    this.validated = this.buildValidated(this.raw);
    const next = { ...this.validated };
    this.applySectionEnvBindings(next, true);
    this.applyEnvOverlay(next);
    this.effective = next;

    const candidates = new Set(
      domains ?? [...Object.keys(previous), ...Object.keys(next)],
    );
    for (const domain of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (!deepEqual(previous[domain], next[domain])) candidates.add(domain);
    }
    this.commit(source, [...candidates]);
    this.emitDiagnosticsIfChanged();
  }

  private deliveredValue(domain: string): unknown {
    return Object.prototype.hasOwnProperty.call(this.memory, domain)
      ? this.memory[domain]
      : this.effective[domain];
  }

  private commit(source: ConfigChangeSource, domains: readonly string[]): void {
    for (const domain of domains) {
      const previousValue = this.delivered[domain];
      const value = this.deliveredValue(domain);
      this._onDidChangeConfiguration.fire({ domain, source, value, previousValue });
      if (!deepEqual(value, previousValue)) {
        this._onDidSectionChange.fire({ domain, source, value, previousValue });
      }
      this.delivered[domain] = value;
    }
  }

  private buildValidated(raw: ResolvedConfig): ResolvedConfig {
    const validated: ResolvedConfig = {};
    for (const [domain, value] of Object.entries(raw)) {
      try {
        validated[domain] = this.registry.validate(domain, value);
      } catch (error) {
        this.pushDiagnostic({
          domain,
          severity: 'warning',
          message: `Ignored invalid config section '${domain}': ${describeUnknownError(error)}`,
        });
      }
    }
    for (const section of this.registry.listSections()) {
      if (validated[section.domain] === undefined && section.defaultValue !== undefined) {
        validated[section.domain] = section.defaultValue;
      }
    }
    return validated;
  }

  private applySectionEnvBindings(effective: ResolvedConfig, reportErrors: boolean): void {
    const getEnv = (name: string): string | undefined => this.bootstrap.getEnv(name);
    for (const section of this.registry.listSections()) {
      if (section.env === undefined) continue;
      try {
        const base = effective[section.domain];
        const onDeprecatedEnv: OnDeprecatedEnv | undefined = reportErrors
          ? (oldName, newName) => {
              this.pushDiagnostic({
                domain: section.domain,
                severity: 'warning',
                message: `Environment variable ${oldName} is deprecated; use ${newName} instead.`,
              });
            }
          : undefined;
        const next = applySectionEnv(base, section.env, getEnv, onDeprecatedEnv);
        effective[section.domain] = this.registry.validate(section.domain, next);
      } catch (error) {
        if (reportErrors) {
          this.pushDiagnostic({
            domain: section.domain,
            severity: 'warning',
            message: `Ignoring env overlay for '${section.domain}': ${describeUnknownError(error)}`,
          });
        }
      }
    }
  }

  private applyEnvOverlay(effective: ResolvedConfig, reportErrors = true): void {
    const getEnv = (name: string): string | undefined => this.bootstrap.getEnv(name);
    const validate = (domain: string, value: unknown): unknown =>
      this.registry.validate(domain, value);
    for (const overlay of this.registry.listEffectiveOverlays()) {
      try {
        overlay.apply(effective, getEnv, validate);
      } catch (error) {
        if (reportErrors) {
          this.pushDiagnostic({
            severity: 'warning',
            message: `Ignoring config environment overlay: ${describeUnknownError(error)}`,
          });
        }
      }
    }
  }

  private reapplyOverlays(): void {
    const before = this.effective;
    this.validated = this.buildValidated(this.raw);
    const next = { ...this.validated };
    this.applySectionEnvBindings(next, true);
    this.applyEnvOverlay(next);
    this.effective = next;
    this.commit('reload', [...new Set([...Object.keys(before), ...Object.keys(next)])]);
    this.emitDiagnosticsIfChanged();
  }

  private revalidateDomain(domain: string): void {
    const section = this.registry.getSection(domain);
    if (section === undefined) return;

    if (section.fromToml !== undefined) {
      const rawSnakeValue = this.rawSnake[camelToSnake(domain)];
      if (rawSnakeValue !== undefined) {
        this.raw[domain] = section.fromToml(rawSnakeValue);
      }
    }

    if (this.raw[domain] !== undefined) {
      try {
        const validatedValue = this.registry.validate(domain, this.raw[domain]);
        this.validated[domain] = validatedValue;
        this.effective[domain] = validatedValue;
      } catch {
        return;
      }
    } else if (section.defaultValue !== undefined && this.effective[domain] === undefined) {
      this.validated[domain] = section.defaultValue;
      this.effective[domain] = section.defaultValue;
    } else {
      return;
    }

    this.applyEnvOverlay(this.effective);
    if (section.env !== undefined) {
      const getEnv = (name: string): string | undefined => this.bootstrap.getEnv(name);
      try {
        const onDeprecatedEnv: OnDeprecatedEnv = (oldName, newName) => {
          this.pushDiagnostic({
            domain,
            severity: 'warning',
            message: `Environment variable ${oldName} is deprecated; use ${newName} instead.`,
          });
        };
        const next = applySectionEnv(this.effective[domain], section.env, getEnv, onDeprecatedEnv);
        this.effective[domain] = this.registry.validate(domain, next);
      } catch (error) {
        this.pushDiagnostic({
          domain,
          severity: 'warning',
          message: `Ignoring env overlay for '${domain}': ${describeUnknownError(error)}`,
        });
      }
    }
    this.commit('reload', [domain]);
    this.emitDiagnosticsIfChanged();
  }

  private devalidateDomain(domain: string): void {
    if (this.registry.getSection(domain) !== undefined) return;

    const snakeKey = camelToSnake(domain);
    const rawSnakeValue = this.rawSnake[snakeKey];
    if (rawSnakeValue === undefined) {
      delete this.raw[domain];
      delete this.validated[domain];
      delete this.effective[domain];
    } else {
      const raw = transformTomlData({ [snakeKey]: rawSnakeValue }, this.registry)[domain];
      this.raw[domain] = raw;
      this.validated[domain] = raw;
      this.effective[domain] = raw;
    }

    this.applyEnvOverlay(this.effective);
    this.commit('reload', [domain]);
  }

  private assertPersistable(): void {
    if (!this.tainted) return;
    throw new Error2(
      ErrorCodes.CONFIG_PERSIST_BLOCKED,
      `Refusing to persist config: ${this.bootstrap.configPath} could not be read; fix the file and reload before writing.`,
    );
  }

  private async persist(
    domain: string,
    rebase: (stagedRaw: ResolvedConfig, stagedRawSnake: ResolvedConfig) => void,
  ): Promise<void> {
    await this.persistDomains([domain], rebase);
  }

  private async persistDomains(
    domains: readonly string[],
    rebase: (stagedRaw: ResolvedConfig, stagedRawSnake: ResolvedConfig) => void,
  ): Promise<void> {
    this.assertPersistable();
    let onDisk: ResolvedConfig = {};
    try {
      const data = await this.documentStore.get<ResolvedConfig>(CONFIG_SCOPE, this.configKey);
      onDisk = data !== undefined && isPlainObject(data) ? data : {};
    } catch (error) {
      const message =
        error instanceof TomlError
          ? `Failed to parse ${this.bootstrap.configPath}: ${describeTomlSyntaxError(error)}`
          : describeUnknownError(error);
      this.pushDiagnostic({ severity: 'error', message });
      this.emitDiagnosticsIfChanged();
      this.log.warn('config persist aborted: re-read failed', {
        error: describeUnknownError(error),
      });
      this.tainted = true;
      throw new Error2(
        ErrorCodes.CONFIG_PERSIST_BLOCKED,
        `Refusing to persist config: ${this.bootstrap.configPath} could not be read; fix the file and reload before writing.`,
        { cause: error },
      );
    }
    const stagedRawSnake = cloneRecord(onDisk);
    const stagedRaw = transformTomlData(onDisk, this.registry);
    rebase(stagedRaw, stagedRawSnake);
    for (const domain of domains) {
      applySectionToToml(stagedRawSnake, domain, stagedRaw[domain], this.registry);
    }
    await this.documentStore.set(CONFIG_SCOPE, this.configKey, stagedRawSnake);
    this.rawSnake = stagedRawSnake;
    this.raw = stagedRaw;
  }
}

registerScopedService(
  LifecycleScope.App,
  IConfigRegistry,
  ConfigRegistry,
  ScopeActivation.OnScopeCreated,
  'config',
);
registerScopedService(
  LifecycleScope.App,
  IConfigService,
  ConfigService,
  ScopeActivation.OnScopeCreated,
  'config',
);
