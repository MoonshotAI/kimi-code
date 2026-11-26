import {
  isBusinessMembershipRevokedCode,
  type KimiHarness,
  type ManagedAccountProfile,
  type ManagedWorkspace,
  type RefreshProviderModelsOptions,
  type RefreshProviderModelsResponse,
  type Session,
  type ThinkingEffort,
  type WorkspaceTarget,
} from '@moonshot-ai/kimi-code-sdk';

import {
  confirmThenPerformModelSwitch,
  matchedModelSwitchRule,
} from '../commands/config';
import type { SlashCommandHost } from '../commands/dispatch';
import {
  DEFAULT_OAUTH_PROVIDER_NAME,
  OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE,
} from '../constant/kimi-tui';
import { refreshEffortSwitchConfig } from '#/utils/effort-switch-config';
import { refreshModelSwitchConfirmConfig } from '#/utils/model-switch-confirm-config';
import { lazyModelSelection } from '../utils/model-switch';
import { thinkingEffortFromConfig } from '../utils/thinking-config';
import type { AppState, KimiTUIOptions, ManagedWorkspaceSummary } from '../types';

export interface WorkspaceSwitchSummary {
  readonly displayName: string;
  readonly warning?: string;
}

function toManagedWorkspaceSummary(profile: ManagedAccountProfile): ManagedWorkspaceSummary {
  return {
    hasBusinessWorkspace: profile.hasBusinessWorkspace,
    ...(profile.statusWorkspaceLine !== undefined
      ? { statusWorkspaceLine: profile.statusWorkspaceLine }
      : {}),
    ...(profile.planLabel !== undefined ? { planLabel: profile.planLabel } : {}),
  };
}

function resolvePreferredModel(
  startupModel: string | undefined,
  defaultModel: string | undefined,
  availableModels: Readonly<Record<string, unknown>>,
): string | undefined {
  if (startupModel !== undefined && availableModels[startupModel] !== undefined) {
    return startupModel;
  }
  return defaultModel;
}

function switchedWorkspaceDisplayName(
  target: WorkspaceTarget,
  chosen: ManagedWorkspace,
  profile: ManagedAccountProfile | undefined,
): string {
  if (target.kind === 'business') {
    return profile?.workspaceName ?? chosen.name;
  }
  const nickname = profile?.nickname || chosen.name;
  return nickname.length > 0 && nickname !== 'Personal'
    ? `${nickname} · Personal workspace`
    : 'Personal workspace';
}

export interface AuthFlowHost {
  session: Session | undefined;
  readonly harness: KimiHarness;
  readonly options: KimiTUIOptions;
  readonly state?: { readonly appState: AppState };

  setAppState(patch: Partial<AppState>): void;
  setStartupReady(): void;
  resetSessionRuntime(): void;
  setAuthRequired(required: boolean): void;
  appendStartupNotice(extra: string): void;
  hydrateLazyConfigDefaults(includeModel?: boolean): Promise<void>;
}

export class AuthFlowController {
  private workspaceRefreshGeneration = 0;

  constructor(private readonly host: AuthFlowHost) {}

  async refreshAvailableModels(): Promise<void> {
    const config = await this.host.harness.getConfig({ reload: true });
    this.host.setAppState({
      availableModels: config.models ?? {},
      availableProviders: config.providers ?? {},
    });
  }

  enterLoginRequiredStartupState(): void {
    this.workspaceRefreshGeneration += 1;
    this.host.resetSessionRuntime();
    this.host.setAppState({
      sessionId: '',
      model: '',
      thinkingEffort: 'off',
      contextTokens: 0,
      maxContextTokens: 0,
      contextUsage: 0,
      sessionTitle: null,
      managedWorkspace: null,
    });
    this.host.setAuthRequired(true);
    this.host.appendStartupNotice(OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE);
    this.host.setStartupReady();
  }

  captureWorkspaceGeneration(): number {
    return this.workspaceRefreshGeneration;
  }

  applyAccountProfile(
    profile: ManagedAccountProfile,
    expectedGeneration?: number,
  ): ManagedWorkspaceSummary {
    const summary = toManagedWorkspaceSummary(profile);
    if (
      expectedGeneration !== undefined &&
      expectedGeneration !== this.workspaceRefreshGeneration
    ) {
      return summary;
    }
    this.workspaceRefreshGeneration += 1;
    this.host.setAppState({ managedWorkspace: summary });
    return summary;
  }

  clearManagedWorkspace(): void {
    this.workspaceRefreshGeneration += 1;
    this.host.setAppState({ managedWorkspace: null });
  }

  handleBusinessMembershipRevoked(): void {
    this.clearManagedWorkspace();
    this.host.setAuthRequired(true);
  }

  private activeModelUsesManagedOAuth(): boolean {
    const appState = this.host.state?.appState;
    if (appState === undefined) return true;
    const model = appState.model.trim();
    if (model.length === 0) return true;
    const alias = (appState.availableModels as AppState['availableModels'] | undefined)?.[model];
    return alias === undefined || alias.provider === DEFAULT_OAUTH_PROVIDER_NAME;
  }

  async refreshManagedWorkspaceInBackground(): Promise<void> {
    if (typeof this.host.harness.auth.getAccountProfile !== 'function') return;
    const generation = ++this.workspaceRefreshGeneration;
    let status: Awaited<ReturnType<KimiHarness['auth']['status']>>;
    try {
      status = await this.host.harness.auth.status(DEFAULT_OAUTH_PROVIDER_NAME);
    } catch {
      return;
    }
    if (generation !== this.workspaceRefreshGeneration) return;
    const hasToken = status.providers.some(
      (provider) => provider.providerName === DEFAULT_OAUTH_PROVIDER_NAME && provider.hasToken,
    );
    if (!hasToken) {
      this.host.setAppState({ managedWorkspace: null });
      return;
    }
    const res = await this.host.harness.auth.getAccountProfile(DEFAULT_OAUTH_PROVIDER_NAME);
    if (generation !== this.workspaceRefreshGeneration) return;
    if (res.kind === 'error') {
      if (isBusinessMembershipRevokedCode(res.errorCode)) {
        if (this.activeModelUsesManagedOAuth()) {
          this.handleBusinessMembershipRevoked();
        } else {
          this.clearManagedWorkspace();
        }
      }
      return;
    }
    this.host.setAppState({ managedWorkspace: toManagedWorkspaceSummary(res.profile) });
  }

  async switchWorkspace(
    target: WorkspaceTarget,
    chosen: ManagedWorkspace,
  ): Promise<WorkspaceSwitchSummary> {
    const result = await this.host.harness.auth.switchWorkspace(
      target,
      DEFAULT_OAUTH_PROVIDER_NAME,
    );
    if (result.profile !== undefined) {
      this.applyAccountProfile(result.profile);
    } else {
      this.clearManagedWorkspace();
      void this.refreshManagedWorkspaceInBackground();
    }

    const isStreaming =
      this.host.state !== undefined && this.host.state.appState.streamingPhase !== 'idle';
    const warnings: string[] = [];
    if (result.warning !== undefined) warnings.push(result.warning);

    try {
      if (isStreaming) {
        const config = await this.host.harness.getConfig({ reload: true });
        const availableModels = config.models ?? {};
        const availableProviders = config.providers ?? {};
        const currentModel = this.host.state?.appState.model.trim() ?? '';
        const defaultModel = resolvePreferredModel(
          this.host.options.startup.model,
          config.defaultModel,
          availableModels,
        );
        const fallback = defaultModel !== undefined ? availableModels[defaultModel] : undefined;
        if (
          currentModel.length > 0 &&
          availableModels[currentModel] === undefined &&
          defaultModel !== undefined &&
          fallback !== undefined
        ) {
          await this.activateModelAfterLogin(
            defaultModel,
            thinkingEffortFromConfig(config.thinking),
          );
          this.host.setAppState({
            availableModels,
            availableProviders,
            model: defaultModel,
            maxContextTokens: fallback.maxContextSize,
          });
        } else {
          this.host.setAppState({ availableModels, availableProviders });
        }
      } else {
        await this.refreshConfigAfterLogin(undefined, {
          skipWorkspaceRefresh: result.profile !== undefined,
        });
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }

    const warning = warnings.length > 0 ? warnings.join(' ') : undefined;
    return {
      displayName: switchedWorkspaceDisplayName(target, chosen, result.profile),
      ...(warning !== undefined ? { warning } : {}),
    };
  }

  async activateModelAfterLogin(model: string, effort?: string): Promise<boolean> {
    const { host } = this;
    if (host.session !== undefined) {
      const session = host.session;
      const modelChanged = (await session.getStatus()).model !== model;
      await session.setModel(model);
      if (effort !== undefined) {
        await session.setThinking(effort);
      }
      host.setAuthRequired(false);
      return modelChanged;
    }

    const patch: Partial<AppState> = { model };
    if (effort !== undefined) {
      patch.thinkingEffort = effort as ThinkingEffort;
      patch.lazySessionThinking = effort as ThinkingEffort;
    }
    host.setAppState(patch);
    host.setAuthRequired(false);
    return false;
  }

  async refreshConfigAfterLogin(
    effortOverride?: ThinkingEffort,
    options?: { readonly skipWorkspaceRefresh?: boolean },
  ): Promise<boolean | 'gated'> {
    const { host } = this;
    const config = await host.harness.getConfig({ reload: true });
    const availableModels = config.models ?? {};
    const availableProviders = config.providers ?? {};
    const defaultModel = resolvePreferredModel(
      host.options.startup.model,
      config.defaultModel,
      availableModels,
    );
    const selected = defaultModel !== undefined ? availableModels[defaultModel] : undefined;
    try {
      const accessToken = await host.harness.auth.getCachedAccessToken();
      await Promise.all([
        refreshModelSwitchConfirmConfig({ accessToken }),
        refreshEffortSwitchConfig({ accessToken }),
      ]);
    } catch {}
    if (options?.skipWorkspaceRefresh !== true) {
      void this.refreshManagedWorkspaceInBackground();
    }

    if (defaultModel === undefined || selected === undefined) {
      if (host.session === undefined) {
        await host.hydrateLazyConfigDefaults();
      }
      host.setAppState({ availableModels, availableProviders });
      return false;
    }

    const configuredEffort = thinkingEffortFromConfig(config.thinking);
    const slashHost = this.host as unknown as SlashCommandHost;
    host.setAppState({ availableModels, availableProviders });
    if (matchedModelSwitchRule(slashHost, defaultModel) !== undefined) {
      if (host.session === undefined) await host.hydrateLazyConfigDefaults(false);
      const targetDefaultEffort =
        host.session === undefined ? lazyModelSelection(config, defaultModel).thinkingEffort : undefined;
      confirmThenPerformModelSwitch(
        slashHost,
        defaultModel,
        effortOverride ?? configuredEffort ?? targetDefaultEffort ?? slashHost.state.appState.thinkingEffort,
        'session',
      );
      return 'gated';
    }

    const activated = await this.activateModelAfterLogin(defaultModel, configuredEffort);
    if (host.session === undefined) {
      const startupOverridden =
        host.options.startup.model !== undefined && host.options.startup.model !== defaultModel;
      await host.hydrateLazyConfigDefaults(!startupOverridden);
      host.setAppState({
        ...(startupOverridden ? lazyModelSelection(config, defaultModel) : {}),
        availableModels,
        availableProviders,
      });
      return activated;
    }
    const appStatePatch: Partial<AppState> = {
      availableModels,
      availableProviders,
      model: defaultModel,
      maxContextTokens: selected.maxContextSize,
    };
    host.setAppState(appStatePatch);
    return activated;
  }

  async refreshConfigAfterLogout(): Promise<void> {
    this.workspaceRefreshGeneration += 1;
    const config = await this.host.harness.getConfig({ reload: true });
    const availableModels = config.models ?? {};
    const availableProviders = config.providers ?? {};

    if (this.host.session !== undefined) {
      this.host.setAppState({ availableModels, availableProviders, managedWorkspace: null });
      return;
    }

    this.host.setAppState({
      availableModels,
      availableProviders,
      model: '',
      thinkingEffort: 'off',
      maxContextTokens: 0,
      contextUsage: 0,
      contextTokens: 0,
      managedWorkspace: null,
    });
  }

  async refreshProviderModels(
    options?: RefreshProviderModelsOptions,
  ): Promise<RefreshProviderModelsResponse> {
    const result = await this.host.harness.refreshProviderModels(options);
    await this.refreshAvailableModels();
    return result;
  }

  async refreshOAuthProviderModels(): Promise<RefreshProviderModelsResponse> {
    const result = await this.host.harness.refreshProviderModels({ scope: 'oauth' });
    if (result.changed.length > 0) {
      await this.refreshAvailableModels();
    }
    return result;
  }
}
