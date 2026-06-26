/**
 * `config` domain (L2) — `IConfigRegistry` and `IConfigService` implementations.
 *
 * Owns the section registry and the global config file state; reads config
 * paths through `environment` and logs through `log`. Bound at Core scope.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'pathe';

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { atomicWrite } from '#/_base/utils/fs';
import { IEnvironmentService } from '#/environment';
import { ILogService } from '#/log';

import {
  type ConfigChangedEvent,
  type ConfigDiagnostic,
  type ConfigMerge,
  type ConfigSchema,
  type ConfigSection,
  type ConfigChangeSource,
  type RegisterSectionOptions,
  type ResolvedConfig,
  IConfigRegistry,
  IConfigService,
} from './config';
import { deepMerge, describeUnknownError, isPlainObject } from './configPure';

export class ConfigRegistry implements IConfigRegistry {
  declare readonly _serviceBrand: undefined;
  private readonly sections = new Map<string, ConfigSection>();

  registerSection<T>(
    domain: string,
    schema: ConfigSchema<T>,
    options: RegisterSectionOptions<T> = {},
  ): void {
    if (this.sections.has(domain)) {
      throw new Error(`ConfigRegistry: section '${domain}' is already registered`);
    }
    this.sections.set(domain, {
      domain,
      schema: schema as ConfigSchema<unknown>,
      defaultValue: options.defaultValue,
      merge: (options.merge ?? deepMerge) as ConfigMerge<unknown>,
    });
  }

  getSection(domain: string): ConfigSection | undefined {
    return this.sections.get(domain);
  }

  listSections(): readonly ConfigSection[] {
    return [...this.sections.values()];
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
  private readonly _onDidChange = this._register(new Emitter<ConfigChangedEvent>());
  readonly onDidChange: Event<ConfigChangedEvent> = this._onDidChange.event;
  readonly ready = Promise.resolve();

  private raw: ResolvedConfig = {};
  private effective: ResolvedConfig = {};
  private readonly diagnosticsList: ConfigDiagnostic[] = [];

  constructor(
    @IConfigRegistry private readonly registry: IConfigRegistry,
    @IEnvironmentService private readonly env: IEnvironmentService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.loadSync('load');
  }

  get<T = unknown>(domain: string): T {
    return this.effective[domain] as T;
  }

  getAll(): ResolvedConfig {
    return { ...this.effective };
  }

  diagnostics(): readonly ConfigDiagnostic[] {
    return [...this.diagnosticsList];
  }

  async set(domain: string, patch: unknown): Promise<void> {
    const currentRaw = this.raw;
    const base = currentRaw[domain];
    const next = this.registry.merge(domain, base, patch);
    const validated = this.registry.validate(domain, next);
    const nextRaw: ResolvedConfig = {
      ...currentRaw,
      [domain]: validated,
    };

    await mkdir(dirname(this.env.configPath), { recursive: true, mode: 0o700 });
    await atomicWrite(this.env.configPath, `${stringifyToml(nextRaw)}\n`);
    this.applyRaw(nextRaw, 'set', [domain]);
  }

  async replace(domain: string, value: unknown): Promise<void> {
    const validated = this.registry.validate(domain, value);
    const nextRaw: ResolvedConfig = {
      ...this.raw,
      [domain]: validated,
    };

    await mkdir(dirname(this.env.configPath), { recursive: true, mode: 0o700 });
    await atomicWrite(this.env.configPath, `${stringifyToml(nextRaw)}\n`);
    this.applyRaw(nextRaw, 'set', [domain]);
  }

  reload(): Promise<void> {
    this.loadSync('reload');
    return Promise.resolve();
  }

  private loadSync(source: ConfigChangeSource): void {
    this.diagnosticsList.length = 0;
    let raw: ResolvedConfig = {};
    try {
      raw = this.readRawFileSync();
    } catch (error) {
      this.diagnosticsList.push({
        severity: 'error',
        message: describeUnknownError(error),
      });
      this.log.warn('config load failed', { error: describeUnknownError(error) });
    }
    this.applyRaw(raw, source);
  }

  private readRawFileSync(): ResolvedConfig {
    if (!existsSync(this.env.configPath)) {
      return {};
    }
    const text = readFileSync(this.env.configPath, 'utf-8');
    if (text.trim().length === 0) {
      return {};
    }
    try {
      const parsed = parseToml(text);
      return isPlainObject(parsed) ? parsed : {};
    } catch (error) {
      throw new Error(`Failed to parse ${this.env.configPath}: ${describeUnknownError(error)}`, {
        cause: error,
      });
    }
  }

  private applyRaw(raw: ResolvedConfig, source: ConfigChangeSource, domains?: readonly string[]): void {
    const previous = this.raw;
    this.raw = raw;
    this.effective = this.buildEffective(raw);
    const changedDomains = domains ?? [...new Set([...Object.keys(previous), ...Object.keys(raw)])];
    for (const domain of changedDomains) {
      this._onDidChange.fire({ domain, source });
    }
  }

  private buildEffective(raw: ResolvedConfig): ResolvedConfig {
    const effective: ResolvedConfig = {};
    for (const [domain, value] of Object.entries(raw)) {
      try {
        effective[domain] = this.registry.validate(domain, value);
      } catch (error) {
        this.diagnosticsList.push({
          domain,
          severity: 'warning',
          message: `Ignored invalid config section '${domain}': ${describeUnknownError(error)}`,
        });
      }
    }
    for (const section of this.registry.listSections()) {
      if (effective[section.domain] === undefined && section.defaultValue !== undefined) {
        effective[section.domain] = section.defaultValue;
      }
    }
    return effective;
  }
}

registerScopedService(LifecycleScope.Core, IConfigRegistry, ConfigRegistry, InstantiationType.Delayed, 'config');
registerScopedService(LifecycleScope.Core, IConfigService, ConfigService, InstantiationType.Delayed, 'config');
