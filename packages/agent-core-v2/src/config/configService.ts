/**
 * `config` domain (L2) — `IConfigRegistry`, `IConfigService`, and
 * `IAgentConfigService` implementations.
 *
 * Owns the in-memory config store, the section registry, and the per-agent
 * config view; reads the environment through `environment`, resolves the agent
 * cwd through `kaos`, records through `records`, and logs through `log`. Bound
 * at Core (registry and service) and Agent (agent view) scopes.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IEnvironmentService } from '#/environment/environment';
import { IAgentKaos } from '#/kaos/kaos';
import { ILogService } from '#/log/log';
import { IAgentRecords } from '#/records/records';

import {
  type ConfigChangedEvent,
  type ConfigSection,
  IAgentConfigService,
  IConfigRegistry,
  IConfigService,
} from './config';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, patch: unknown): T {
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

export class ConfigRegistry implements IConfigRegistry {
  declare readonly _serviceBrand: undefined;
  private readonly sections = new Map<string, unknown>();

  registerSection(domain: string, schema: unknown): void {
    if (this.sections.has(domain)) {
      throw new Error(`ConfigRegistry: section '${domain}' is already registered`);
    }
    this.sections.set(domain, schema);
  }

  getSection(domain: string): ConfigSection | undefined {
    const schema = this.sections.get(domain);
    return schema === undefined ? undefined : { domain, schema };
  }

  merge(base: unknown, patch: unknown): unknown {
    return deepMerge(base, patch);
  }
}

export class ConfigService extends Disposable implements IConfigService {
  declare readonly _serviceBrand: undefined;
  private readonly _onDidChange = this._register(new Emitter<ConfigChangedEvent>());
  readonly onDidChange: Event<ConfigChangedEvent> = this._onDidChange.event;
  private readonly root = new Map<string, unknown>();

  constructor(
    @IConfigRegistry _registry: IConfigRegistry,
    @IEnvironmentService _env: IEnvironmentService,
    @ILogService _log: ILogService,
  ) {
    super();
  }

  get<T = unknown>(domain: string): T {
    return this.root.get(domain) as T;
  }

  set(domain: string, patch: unknown): Promise<void> {
    const current = this.root.get(domain);
    const next = deepMerge(current ?? {}, patch);
    this.root.set(domain, next);
    this._onDidChange.fire({ domain });
    return Promise.resolve();
  }
}

interface AgentSection {
  readonly modelAlias?: string;
  readonly thinkingLevel?: string;
  readonly systemPrompt?: string;
  readonly provider?: string;
}

export class AgentConfigService implements IAgentConfigService {
  declare readonly _serviceBrand: undefined;
  private modelAliasValue: string | undefined;
  private thinkingLevelValue: string | undefined;
  private systemPromptValue: string | undefined;
  private providerValue: string | undefined;
  private readonly cwdValue: string;

  constructor(
    @IConfigService config: IConfigService,
    @IAgentRecords _records: IAgentRecords,
    @IAgentKaos agentKaos: IAgentKaos,
  ) {
    const section = config.get<AgentSection>('agent');
    this.modelAliasValue = section?.modelAlias;
    this.thinkingLevelValue = section?.thinkingLevel;
    this.systemPromptValue = section?.systemPrompt;
    this.providerValue = section?.provider;
    this.cwdValue = agentKaos.cwd;
  }

  get modelAlias(): string | undefined {
    return this.modelAliasValue;
  }
  get thinkingLevel(): string | undefined {
    return this.thinkingLevelValue;
  }
  get systemPrompt(): string | undefined {
    return this.systemPromptValue;
  }
  get provider(): string | undefined {
    return this.providerValue;
  }
  get cwd(): string {
    return this.cwdValue;
  }

  setModel(alias: string): Promise<void> {
    this.modelAliasValue = alias;
    return Promise.resolve();
  }
  setThinking(level: string): Promise<void> {
    this.thinkingLevelValue = level;
    return Promise.resolve();
  }
}

registerScopedService(LifecycleScope.Core, IConfigRegistry, ConfigRegistry, InstantiationType.Delayed, 'config');
registerScopedService(LifecycleScope.Core, IConfigService, ConfigService, InstantiationType.Delayed, 'config');
registerScopedService(LifecycleScope.Agent, IAgentConfigService, AgentConfigService, InstantiationType.Delayed, 'config');
