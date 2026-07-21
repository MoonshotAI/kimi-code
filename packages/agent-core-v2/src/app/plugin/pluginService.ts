/**
 * `plugin` domain (L3) — `IPluginService` implementation.
 *
 * Manages the App-wide plugin catalog through the filesystem-backed
 * `PluginManager`, roots plugin storage at `bootstrap`, counts plugin skills
 * through `skillDiscovery`, and resolves managed endpoint settings through
 * `provider` plus the startup snapshot from `bootstrap`. Exposes plugin
 * contributions through the hook, MCP, and skill contracts. Bound at App scope.
 */

import { KIMI_CODE_PROVIDER_NAME } from '@moonshot-ai/kimi-code-oauth';

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Error2, PluginErrors } from '#/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IProviderService } from '#/kosong/provider/provider';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import type { HookDef } from '#/agent/externalHooks/types';
import type { McpServerConfig } from '#/agent/mcp/config-schema';
import type { SkillRoot } from '#/app/skillCatalog/types';

import { PluginManager } from './manager';
import {
  type GetPluginInfoInput,
  type InstallPluginInput,
  IPluginService,
  type RemovePluginInput,
  type SetPluginEnabledInput,
  type SetPluginMcpServerEnabledInput,
} from './plugin';
import type {
  EnabledPluginSessionStart,
  PluginCommandDef,
  PluginInfo,
  PluginSummary,
  PluginUpdateStatus,
  ReloadSummary,
} from './types';

const KIMI_CODE_BASE_URL_ENV = 'KIMI_CODE_BASE_URL';
const KIMI_CODE_OAUTH_HOST_ENV = 'KIMI_CODE_OAUTH_HOST';
const KIMI_OAUTH_HOST_ENV = 'KIMI_OAUTH_HOST';

export class PluginService extends Disposable implements IPluginService {
  declare readonly _serviceBrand: undefined;

  private readonly homeDir: string;
  private readonly envBaseUrl: string | undefined;
  private readonly envOAuthHost: string | undefined;
  private readonly manager: PluginManager;
  private initialLoadPromise: Promise<void> | undefined;
  private hasLoadedSnapshot = false;
  private loadError: Error | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly onDidReloadEmitter = this._register(new Emitter<ReloadSummary>());

  readonly onDidReload: Event<ReloadSummary> = this.onDidReloadEmitter.event;

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @ISkillDiscovery discovery: ISkillDiscovery,
    @IProviderService private readonly providers: IProviderService,
  ) {
    super();
    this.homeDir = bootstrap.homeDir;
    this.envBaseUrl = bootstrap.getEnv(KIMI_CODE_BASE_URL_ENV);
    this.envOAuthHost =
      bootstrap.getEnv(KIMI_CODE_OAUTH_HOST_ENV) ?? bootstrap.getEnv(KIMI_OAUTH_HOST_ENV);
    this.manager = new PluginManager({
      kimiHomeDir: this.homeDir,
      discoverSkills: (roots) => discovery.discover(roots),
    });
  }

  listPlugins(): Promise<readonly PluginSummary[]> {
    return this.runManagementRead(async () => this.manager.summaries());
  }

  installPlugin(input: InstallPluginInput): Promise<PluginSummary> {
    return this.runSerializedOperation(async () => {
      const record = await this.manager.install(input.source);
      const info = this.manager.info(record.id);
      if (info === undefined) throw new Error(`Plugin "${record.id}" missing right after install`);
      return info;
    });
  }

  setPluginEnabled(input: SetPluginEnabledInput): Promise<void> {
    return this.runSerializedOperation(async () => {
      await this.manager.setEnabled(input.id, input.enabled);
    });
  }

  setPluginMcpServerEnabled(input: SetPluginMcpServerEnabledInput): Promise<void> {
    return this.runSerializedOperation(async () => {
      await this.manager.setMcpServerEnabled(input.id, input.server, input.enabled);
    });
  }

  removePlugin(input: RemovePluginInput): Promise<void> {
    return this.runSerializedOperation(async () => {
      await this.manager.remove(input.id);
    });
  }

  reloadPlugins(): Promise<ReloadSummary> {
    const reload = this.enqueueMutation(async () => {
      try {
        const summary = await this.manager.reload();
        this.hasLoadedSnapshot = true;
        this.loadError = undefined;
        this.onDidReloadEmitter.fire(summary);
        return summary;
      } catch (error) {
        this.loadError = error instanceof Error ? error : new Error(String(error));
        throw new Error2(
          PluginErrors.codes.PLUGIN_LOAD_FAILED,
          `Failed to reload plugins: ${this.loadError.message}`,
          { cause: this.loadError, details: { kimiHomeDir: this.homeDir } },
        );
      }
    });
    this.initialLoadPromise ??= reload.then(
      () => undefined,
      () => undefined,
    );
    return reload;
  }

  getPluginInfo(input: GetPluginInfoInput): Promise<PluginInfo> {
    return this.runManagementRead(async () => {
      const info = this.manager.info(input.id);
      if (info === undefined) {
        throw new Error2(
          PluginErrors.codes.PLUGIN_NOT_FOUND,
          `Plugin "${input.id}" is not installed`,
          { details: { id: input.id } },
        );
      }
      return info;
    });
  }

  listPluginCommands(): Promise<readonly PluginCommandDef[]> {
    return this.runSerializedOperation(async () => this.manager.enabledCommands());
  }

  checkUpdates(): Promise<readonly PluginUpdateStatus[]> {
    return this.runManagementRead(async () => this.manager.checkUpdates());
  }

  pluginSkillRoots(): Promise<readonly SkillRoot[]> {
    return this.runConsumptionRead([], async () => this.manager.pluginSkillRoots());
  }

  enabledSessionStarts(): Promise<readonly EnabledPluginSessionStart[]> {
    return this.runConsumptionRead([], async () => this.manager.enabledSessionStarts());
  }

  enabledMcpServers(): Promise<Record<string, McpServerConfig>> {
    return this.runConsumptionRead({}, async () => {
      const pluginServers = this.manager.enabledMcpServers();
      if (!Object.values(pluginServers).some((server) => server.transport === 'stdio')) {
        return pluginServers;
      }
      const managedEnv = await this.managedKimiCodeEnvForPlugins();
      return withManagedKimiPluginEnv(pluginServers, managedEnv);
    });
  }

  enabledHooks(): Promise<readonly HookDef[]> {
    return this.runConsumptionRead([], async () => this.manager.enabledHooks());
  }

  private runSerializedOperation<T>(operation: () => Promise<T>): Promise<T> {
    void this.startInitialLoad();
    return this.enqueueMutation(async () => {
      this.assertLoaded();
      return operation();
    });
  }

  private async runManagementRead<T>(operation: () => Promise<T>): Promise<T> {
    await this.waitForPendingMutations();
    this.assertLoaded();
    return operation();
  }

  private async runConsumptionRead<T>(fallback: T, operation: () => Promise<T>): Promise<T> {
    await this.waitForPendingMutations();
    if (!this.hasLoadedSnapshot) return fallback;
    return operation();
  }

  private async waitForPendingMutations(): Promise<void> {
    void this.startInitialLoad();
    await this.mutationQueue;
  }

  private startInitialLoad(): Promise<void> {
    this.initialLoadPromise ??= this.enqueueMutation(async () => {
      await this.loadOnce();
    });
    return this.initialLoadPromise;
  }

  private async loadOnce(): Promise<void> {
    try {
      await this.manager.load();
      this.hasLoadedSnapshot = true;
      this.loadError = undefined;
    } catch (error) {
      this.loadError = error instanceof Error ? error : new Error(String(error));
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertLoaded(): void {
    if (this.loadError === undefined) return;
    throw new Error2(
      PluginErrors.codes.PLUGIN_LOAD_FAILED,
      `Plugin state failed to load: ${this.loadError.message}. ` +
        `Fix the file at ${this.homeDir}/plugins/installed.json and run /plugins reload.`,
      { cause: this.loadError, details: { kimiHomeDir: this.homeDir } },
    );
  }

  private async managedKimiCodeEnvForPlugins(): Promise<Record<string, string>> {
    await this.providers.ready;
    const provider = this.providers.get(KIMI_CODE_PROVIDER_NAME);
    const envBaseUrl = this.envBaseUrl;
    const envOAuthHost = this.envOAuthHost;
    const hasEnvOverride = envBaseUrl !== undefined || envOAuthHost !== undefined;
    const baseUrl =
      envBaseUrl !== undefined ? envBaseUrl.replace(/\/+$/, '') : provider?.baseUrl;
    const oauthHost = hasEnvOverride ? envOAuthHost : provider?.oauth?.oauthHost;
    const env: Record<string, string> = {};
    if (baseUrl !== undefined) env[KIMI_CODE_BASE_URL_ENV] = baseUrl;
    if (oauthHost !== undefined) env[KIMI_CODE_OAUTH_HOST_ENV] = oauthHost;
    return env;
  }
}

function withManagedKimiPluginEnv(
  pluginServers: Record<string, McpServerConfig>,
  managedEnv: Record<string, string>,
): Record<string, McpServerConfig> {
  if (Object.keys(managedEnv).length === 0) return pluginServers;
  const out: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(pluginServers)) {
    out[name] =
      server.transport === 'stdio'
        ? { ...server, env: { ...server.env, ...managedEnv } }
        : server;
  }
  return out;
}

registerScopedService(
  LifecycleScope.App,
  IPluginService,
  PluginService,
  InstantiationType.Eager,
  'plugin',
);
