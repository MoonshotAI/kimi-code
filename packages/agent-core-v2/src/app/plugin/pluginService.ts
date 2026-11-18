import { KIMI_CODE_PROVIDER_NAME } from '@moonshot-ai/kimi-code-oauth';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { AsyncEmitter, Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import type { HookDef } from '#/features/externalHooks/internal/types';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IMcpOAuthService } from '#/app/mcpConfig/oauthService';
import { IRegionService } from '#/app/region/region';
import { LifecycleScope } from '#/app/scopes';
import type { PluginToggleEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ISkillDiscovery } from '#/features/skill/catalog/skillDiscovery';
import type { SkillRoot } from '#/features/skill/catalog/types';
import { BugIndicatingError, Error2, ErrorCodes, PluginErrors } from '#/errors';
import { IProviderService } from '#/llm-adapter/provider/provider';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { McpOAuthService } from '#/mcpCore/oauth/service';

import { PluginAvailabilityStore, pluginAvailabilitySourceKey } from './availability';
import { PluginManager } from './manager';
import {
  pluginClientForIdentity,
  type PluginClient,
  type PluginMarketplace,
} from './marketplace';
import {
  type MarketplacePluginInstall,
  PluginMarketplaceService,
} from './marketplaceService';
import {
  type GetPluginInfoInput,
  type InstallPluginInput,
  type PreviewPluginInput,
  IPluginService,
  type RemovePluginInput,
  type SetPluginEnabledInput,
  type SetPluginMcpServerEnabledInput,
} from './plugin';
import { normalizePluginId } from './types';
import type {
  EnabledPluginSessionStart,
  EnabledPluginSystemPrompt,
  PluginCapabilities,
  PluginCommandDef,
  PluginInfo,
  PluginAgentRoot,
  PluginMcpServerEntry,
  PluginMutation,
  PluginMutationSummary,
  PluginReloadEvent,
  PluginSummary,
  PluginUpdateStatus,
  ReloadSummary,
} from './types';

const KIMI_CODE_BASE_URL_ENV = 'KIMI_CODE_BASE_URL';
const KIMI_CODE_OAUTH_HOST_ENV = 'KIMI_CODE_OAUTH_HOST';
const KIMI_OAUTH_HOST_ENV = 'KIMI_OAUTH_HOST';
const NO_ABORT = new AbortController().signal;

interface PluginReloadNotification {
  readonly summary: ReloadSummary;
  readonly delivery: Promise<void>;
}

interface PluginMutationOutcome<T> {
  readonly result: T;
  readonly notification: PluginReloadNotification;
}

export interface ResolvedMarketplacePluginInstallOptions {
  readonly resolved: MarketplacePluginInstall;
  readonly requiredSkill?: string;
}

export class PluginService extends Service implements IPluginService {
  declare readonly _serviceBrand: undefined;

  private readonly homeDir: string;
  private readonly envBaseUrl: string | undefined;
  private readonly envOAuthHost: string | undefined;
  private readonly manager: PluginManager;
  private readonly marketplace: PluginMarketplaceService;
  private readonly availability: PluginAvailabilityStore;
  private readonly client: PluginClient;
  private readonly platform: NodeJS.Platform;
  private initialLoadPromise: Promise<void> | undefined;
  private appliedAvailabilityGeneration = 0;
  private snapshotLoaded = false;
  private loadError: Error | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly mcpSuspensions = new Map<string, number>();
  private readonly onDidReloadEmitter = this._register(new AsyncEmitter<PluginReloadEvent>());
  private readonly onDidMutateEmitter = this._register(new Emitter<PluginMutationSummary>());

  readonly onDidReload: Event<PluginReloadEvent> = this.onDidReloadEmitter.event;
  readonly onDidMutate: Event<PluginMutationSummary> = this.onDidMutateEmitter.event;

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @ISkillDiscovery discovery: ISkillDiscovery,
    @IProviderService private readonly providers: IProviderService,
    @IRegionService regions: IRegionService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IMcpOAuthService private readonly oauth: McpOAuthService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.homeDir = bootstrap.homeDir;
    this.envBaseUrl = bootstrap.getEnv(KIMI_CODE_BASE_URL_ENV);
    this.envOAuthHost =
      bootstrap.getEnv(KIMI_CODE_OAUTH_HOST_ENV) ?? bootstrap.getEnv(KIMI_OAUTH_HOST_ENV);
    this.availability = new PluginAvailabilityStore(this.homeDir);
    this.client = pluginClientForIdentity(bootstrap.clientIdentity.platform);
    this.platform = bootstrap.platform;
    this.manager = new PluginManager({
      kimiHomeDir: this.homeDir,
      client: this.client,
      platform: this.platform,
      availability: this.availability,
      discoverSkills: (roots) => discovery.discover(roots),
    });
    this.marketplace = new PluginMarketplaceService(bootstrap, providers, regions, this.availability);
  }

  listPlugins(): Promise<readonly PluginSummary[]> {
    return this.runManagementRead(async () => this.manager.summaries());
  }

  async withMcpServersSuspended<T>(id: string, task: () => Promise<T>): Promise<T> {
    const key = normalizePluginId(id);
    let suspended = false;
    try {
      await this.runNotifiedMutation(async () => {
        this.mcpSuspensions.set(key, (this.mcpSuspensions.get(key) ?? 0) + 1);
        suspended = true;
        return { result: undefined, notification: await this.reloadAndNotify() };
      });
      return await task();
    } finally {
      if (suspended) {
        await this.runNotifiedMutation(async () => {
          const remaining = (this.mcpSuspensions.get(key) ?? 1) - 1;
          if (remaining === 0) this.mcpSuspensions.delete(key);
          else this.mcpSuspensions.set(key, remaining);
          return { result: undefined, notification: await this.reloadAndNotify() };
        });
      }
    }
  }

  installPlugin(
    input: InstallPluginInput,
    resolvedInstall?: ResolvedMarketplacePluginInstallOptions,
  ): Promise<PluginSummary> {
    return this.runNotifiedMutation(async () => {
      const { record, summary } =
        'source' in input
          ? await this.manager.installAndReload(input.source, { origin: 'custom' })
          : await (async () => {
              const resolved =
                resolvedInstall?.resolved ??
                (await this.marketplace.resolveInstall(
                  input.marketplaceId,
                  input.expectedVersion,
                  input.expectedSha256,
                  input.marketplaceSource,
                ));
              await this.availability.refresh();
              const installation = {
                id: resolved.expectedPluginId,
                origin: 'marketplace' as const,
                catalogId: resolved.catalogId,
                marketplaceSource: resolved.marketplaceSource === undefined
                  ? undefined
                  : pluginAvailabilitySourceKey(resolved.marketplaceSource),
              };
              if (!this.availability.supports(installation, this.client, this.platform)) {
                throw new Error2(
                  ErrorCodes.VALIDATION_FAILED,
                  `Marketplace plugin "${resolved.catalogId}" does not support ${this.client} on ${this.platform}`,
                  { details: { marketplaceId: resolved.catalogId, client: this.client, platform: this.platform } },
                );
              }
              return this.manager.installAndReload(resolved.source, {
                expectedSha256: resolved.sha256sum,
                expectedPluginId: resolved.expectedPluginId,
                origin: resolved.origin,
                catalogId: resolved.catalogId,
                marketplaceSource: resolved.marketplaceSource === undefined
                  ? undefined
                  : pluginAvailabilitySourceKey(resolved.marketplaceSource),
                migrateFrom: input.migrateFrom,
                requiredSkill: resolvedInstall?.requiredSkill,
                fetchImpl: resolved.fetchImpl,
              });
            })();
      const info = this.manager.info(record.id);
      if (info === undefined)
        throw new BugIndicatingError(`Plugin "${record.id}" missing right after install`);
      const notification = this.notifyReload(summary, {
        mutation: { kind: 'install', id: record.id },
      });
      return { result: info, notification };
    });
  }

  setPluginEnabled(input: SetPluginEnabledInput): Promise<void> {
    return this.runNotifiedMutation(async () => {
      const id = normalizePluginId(input.id);
      await this.manager.setEnabled(id, input.enabled);
      const notification = await this.reloadAndNotify({
        mutation: { kind: input.enabled ? 'enable' : 'disable', id },
      });
      const event: PluginToggleEvent = {
        plugin_id: id,
        enabled: input.enabled,
        enabled_plugins: this.enabledPluginIds()?.join(','),
      };
      this.telemetry.track2('plugin_toggle', event);
      return { result: undefined, notification };
    });
  }

  setPluginMcpServerEnabled(input: SetPluginMcpServerEnabledInput): Promise<void> {
    return this.runNotifiedMutation(async () => {
      await this.manager.setMcpServerEnabled(input.id, input.server, input.enabled);
      const notification = await this.reloadAndNotify({
        mutation: { kind: 'mcp-server', id: input.id },
      });
      return { result: undefined, notification };
    });
  }

  async removePlugin(input: RemovePluginInput): Promise<void> {
    const id = normalizePluginId(input.id);
    let removedServers: readonly PluginMcpServerEntry[] = [];
    await this.runNotifiedMutation(async () => {
      removedServers = this.manager.mcpServerEntries().filter((entry) => entry.pluginId === id);
      await this.manager.remove(input.id);
      const notification = await this.reloadAndNotify({
        mutation: { kind: 'remove', id: input.id },
      });
      return { result: undefined, notification };
    });
    for (const entry of removedServers) {
      if (!('url' in entry.config)) continue;
      try {
        await this.oauth.cancelAuthorizationFromConfiguration(undefined, entry.name, entry.config.url);
        await this.oauth.invalidateFromConfiguration(undefined, entry.name, entry.config.url);
      } catch (error) {
        this.log.warn('plugin oauth credential cleanup failed', {
          pluginId: id,
          name: entry.name,
          error,
        });
      }
    }
  }

  reloadPlugins(): Promise<ReloadSummary> {
    const reload = this.awaitReloadDelivery(
      this.enqueueMutation(async () => {
        try {
          const notification = await this.reloadAndNotify();
          return { result: notification.summary, notification };
        } catch (error) {
          this.loadError = error instanceof Error ? error : new Error(String(error));
          throw new Error2(
            PluginErrors.codes.PLUGIN_LOAD_FAILED,
            `Failed to reload plugins: ${this.loadError.message}`,
            { cause: this.loadError, details: { kimiHomeDir: this.homeDir } },
          );
        }
      }),
    );
    this.initialLoadPromise ??= reload.then(
      () => undefined,
      () => undefined,
    );
    return reload;
  }

  reconcileAvailability(marketplace: PluginMarketplace): Promise<void> {
    return this.runNotifiedMutation(async () => {
      await this.availability.update(marketplace);
      if (this.availability.generation === this.appliedAvailabilityGeneration) {
        return {
          result: undefined,
          notification: {
            summary: { added: [], removed: [], errors: [] },
            delivery: Promise.resolve(),
          },
        };
      }
      const notification = await this.reloadAndNotify();
      return { result: undefined, notification };
    });
  }

  private async reloadAndNotify(options?: {
    readonly mutation: PluginMutation;
  }): Promise<PluginReloadNotification> {
    return this.notifyReload(await this.manager.reload(), options);
  }

  private notifyReload(
    summary: ReloadSummary,
    options?: { readonly mutation: PluginMutation },
  ): PluginReloadNotification {
    this.appliedAvailabilityGeneration = this.availability.generation;
    this.snapshotLoaded = true;
    this.loadError = undefined;
    const delivery = this.onDidReloadEmitter.fireAsyncConcurrent(summary, NO_ABORT);
    if (options?.mutation !== undefined)
      this.onDidMutateEmitter.fire({ ...summary, mutation: options.mutation });
    return { summary, delivery };
  }

  private runNotifiedMutation<T>(operation: () => Promise<PluginMutationOutcome<T>>): Promise<T> {
    return this.awaitReloadDelivery(this.runSerializedOperation(operation));
  }

  private async awaitReloadDelivery<T>(operation: Promise<PluginMutationOutcome<T>>): Promise<T> {
    const { result, notification } = await operation;
    await notification.delivery;
    return result;
  }

  getPluginInfo(input: GetPluginInfoInput): Promise<PluginInfo> {
    return this.runManagementRead(async () => {
      const info = this.manager.info(input.id, input.locale);
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

  previewPlugin(input: PreviewPluginInput): Promise<PluginCapabilities> {
    return this.runManagementRead(async () => {
      const resolved = await this.marketplace.resolveInstall(
        input.marketplaceId,
        input.expectedVersion,
        input.expectedSha256,
      );
      if (resolved.sha256sum === undefined) {
        throw new Error2(
          ErrorCodes.VALIDATION_FAILED,
          `Marketplace plugin "${input.marketplaceId}" preview requires a SHA-256 digest`,
          { details: { marketplaceId: input.marketplaceId } },
        );
      }
      return this.manager.inspect(resolved.source, {
        expectedSha256: resolved.sha256sum,
        expectedPluginId: resolved.expectedPluginId,
        locale: input.locale,
        fetchImpl: resolved.fetchImpl,
      });
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

  pluginAgentRoots(): Promise<readonly PluginAgentRoot[]> {
    return this.runConsumptionRead([], async () => this.manager.pluginAgentRoots());
  }

  enabledSessionStarts(): Promise<readonly EnabledPluginSessionStart[]> {
    return this.runConsumptionRead([], async () => this.manager.enabledSessionStarts());
  }

  enabledSystemPrompts(): Promise<readonly EnabledPluginSystemPrompt[]> {
    return this.runConsumptionRead([], async () => this.manager.enabledSystemPrompts());
  }

  enabledMcpServers(): Promise<Record<string, McpServerConfig>> {
    return this.runConsumptionRead({}, async () => {
      const pluginServers = this.manager.enabledMcpServers();
      for (const entry of this.manager.mcpServerEntries()) {
        if (this.mcpSuspensions.has(entry.pluginId)) delete pluginServers[entry.name];
      }
      if (!Object.values(pluginServers).some((server) => server.transport === 'stdio')) {
        return pluginServers;
      }
      const managedEnv = await this.managedKimiCodeEnvForPlugins();
      return withManagedKimiPluginEnv(pluginServers, managedEnv);
    });
  }

  mcpServerEntries(): Promise<readonly PluginMcpServerEntry[]> {
    return this.runManagementRead(async () => {
      const entries = this.manager.mcpServerEntries().map((entry) =>
        this.mcpSuspensions.has(entry.pluginId)
          ? { ...entry, config: { ...entry.config, enabled: false } }
          : entry,
      );
      if (!entries.some((entry) => entry.config.transport === 'stdio')) {
        return entries;
      }
      const managedEnv = await this.managedKimiCodeEnvForPlugins();
      return withManagedKimiPluginEnvOnEntries(entries, managedEnv);
    });
  }

  enabledHooks(): Promise<readonly HookDef[]> {
    return this.runConsumptionRead([], async () => this.manager.enabledHooks());
  }

  hasLoadedSnapshot(): boolean {
    return this.snapshotLoaded;
  }

  enabledPluginIds(): readonly string[] | undefined {
    if (!this.snapshotLoaded) return undefined;
    return this.manager
      .summaries()
      .filter((plugin) => plugin.enabled && plugin.state === 'ok')
      .map((plugin) => plugin.id)
      .toSorted();
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
    if (!this.snapshotLoaded) return fallback;
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
      this.snapshotLoaded = true;
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
    const baseUrl = envBaseUrl !== undefined ? envBaseUrl.replace(/\/+$/, '') : provider?.baseUrl;
    const oauthHost = hasEnvOverride ? envOAuthHost : provider?.oauth?.oauthHost;
    const env: Record<string, string> = {};
    if (baseUrl !== undefined) env[KIMI_CODE_BASE_URL_ENV] = baseUrl;
    if (oauthHost !== undefined) env[KIMI_CODE_OAUTH_HOST_ENV] = oauthHost;
    return env;
  }
}

export function installResolvedMarketplacePlugin(
  plugins: IPluginService,
  input: Extract<InstallPluginInput, { readonly marketplaceId: string }>,
  resolved: MarketplacePluginInstall,
  requiredSkill?: string,
): Promise<PluginSummary> {
  const service = plugins as {
    installPlugin(
      input: InstallPluginInput,
      options?: ResolvedMarketplacePluginInstallOptions,
    ): Promise<PluginSummary>;
  };
  return service.installPlugin(input, { resolved, requiredSkill });
}

function withManagedKimiPluginEnv(
  pluginServers: Record<string, McpServerConfig>,
  managedEnv: Record<string, string>,
): Record<string, McpServerConfig> {
  if (Object.keys(managedEnv).length === 0) return pluginServers;
  const out: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(pluginServers)) {
    out[name] =
      server.transport === 'stdio' ? { ...server, env: { ...server.env, ...managedEnv } } : server;
  }
  return out;
}

function withManagedKimiPluginEnvOnEntries(
  entries: readonly PluginMcpServerEntry[],
  managedEnv: Record<string, string>,
): readonly PluginMcpServerEntry[] {
  if (Object.keys(managedEnv).length === 0) return entries;
  return entries.map((entry) =>
    entry.config.transport === 'stdio'
      ? { ...entry, config: { ...entry.config, env: { ...entry.config.env, ...managedEnv } } }
      : entry,
  );
}

registerScopedService(
  LifecycleScope.App,
  IPluginService,
  PluginService,
  ScopeActivation.OnScopeCreated,
  'plugin',
);
