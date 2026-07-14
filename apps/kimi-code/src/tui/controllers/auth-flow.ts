import type { SkillListSession } from '../commands';

import { createKimiCodeUserAgent } from '#/cli/version';
import type { CoreHarness, CoreSession } from '#/core/index';
import { OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE } from '../constant/kimi-tui';
import {
  defaultModelView,
  modelsView,
  providersView,
  thinkingView,
} from '../utils/core-config-view';
import {
  refreshAllProviderModels,
  type RefreshProviderHost,
  type RefreshProviderScope,
  type RefreshResult,
} from '../utils/refresh-providers';
import { thinkingEffortFromConfig } from '../utils/thinking-config';
import type { SessionEventHandler } from './session-event-handler';
import type { AppState, KimiTUIOptions } from '../types';
import type { TUIState } from '../tui-state';

export interface AuthFlowHost {
  state: TUIState;
  session: CoreSession | undefined;
  readonly harness: CoreHarness;
  readonly options: KimiTUIOptions;

  setAppState(patch: Partial<AppState>): void;
  setStartupReady(): void;
  resetSessionRuntime(): void;
  setSession(session: CoreSession): Promise<void>;
  syncRuntimeState(session?: CoreSession): Promise<void>;
  closeSession(reason: string): Promise<void>;
  appendStartupNotice(extra: string): void;
  readonly sessionEventHandler: SessionEventHandler;
  fetchSessions(): Promise<void>;
  updateTerminalTitle(): void;
  refreshSkillCommands(session?: SkillListSession): Promise<void>;
  refreshPluginCommands(session?: CoreSession): Promise<void>;
}

export class AuthFlowController {
  constructor(private readonly host: AuthFlowHost) {}

  async refreshAvailableModels(): Promise<void> {
    const config = await this.host.harness.getConfig({ reload: true });
    this.host.setAppState({
      availableModels: modelsView(config),
      availableProviders: providersView(config),
    });
  }

  enterLoginRequiredStartupState(): void {
    this.host.resetSessionRuntime();
    this.host.setAppState({
      sessionId: '',
      model: '',
      thinkingEffort: 'off',
      contextTokens: 0,
      maxContextTokens: 0,
      contextUsage: 0,
      sessionTitle: null,
    });
    this.host.appendStartupNotice(OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE);
    this.host.setStartupReady();
  }

  /**
   * Apply a model choice. With a live session this switches the session's
   * model; without one (session-less startup, or login completing before the
   * first message) it only records the choice in appState — the lazy session
   * creation on the first message picks it up.
   */
  async activateModelSelection(model: string, effort?: string): Promise<void> {
    const { host } = this;
    if (host.session !== undefined) {
      await host.session.setModel(model);
      if (effort !== undefined) {
        await host.session.setThinking(effort);
      }
      return;
    }

    const patch: Partial<AppState> = { model };
    if (effort !== undefined) {
      patch.thinkingEffort = effort;
    }
    const selected = host.state.appState.availableModels[model];
    if (selected !== undefined) {
      patch.maxContextTokens = selected.maxContextSize;
    }
    host.setAppState(patch);
  }

  async clearActiveSessionAfterLogout(): Promise<void> {
    await this.host.closeSession('logged out');
    this.host.resetSessionRuntime();
    this.host.setAppState({
      sessionId: '',
      model: '',
      sessionTitle: null,
    });
    await this.host.refreshSkillCommands();
    await this.host.refreshPluginCommands();
  }

  async refreshConfigAfterLogin(): Promise<void> {
    const { host } = this;
    const config = await host.harness.getConfig({ reload: true });
    const availableModels = modelsView(config);
    const availableProviders = providersView(config);
    const defaultModel = host.options.startup.model ?? defaultModelView(config);
    const selected = defaultModel !== undefined ? availableModels[defaultModel] : undefined;

    if (defaultModel === undefined || selected === undefined) {
      host.setAppState({ availableModels, availableProviders });
      return;
    }

    await this.activateModelSelection(defaultModel, thinkingEffortFromConfig(thinkingView(config)));
    const appStatePatch: Partial<AppState> = {
      availableModels,
      availableProviders,
      model: defaultModel,
      maxContextTokens: selected.maxContextSize,
    };
    host.setAppState(appStatePatch);
  }

  async refreshConfigAfterLogout(): Promise<void> {
    const config = await this.host.harness.getConfig({ reload: true });
    this.host.setAppState({
      availableModels: modelsView(config),
      availableProviders: providersView(config),
      model: '',
      thinkingEffort: 'off',
      maxContextTokens: 0,
      contextUsage: 0,
      contextTokens: 0,
    });
  }

  /**
   * Re-fetch model lists from every provider whose upstream supports it
   * (managed OAuth, open platforms, custom registries) and update local
   * config.  Runs best-effort: individual provider failures are collected
   * and returned instead of thrown.
   */
  async refreshProviderModels(): Promise<RefreshResult> {
    return this.refreshProviderModelsWithScope('all');
  }

  async refreshOAuthProviderModels(): Promise<RefreshResult> {
    return this.refreshProviderModelsWithScope('oauth');
  }

  private async refreshProviderModelsWithScope(scope: RefreshProviderScope): Promise<RefreshResult> {
    const { host } = this;
    const hostAdapter: RefreshProviderHost = {
      getConfig: () => host.harness.getConfig({ reload: true }),
      removeProvider: (id) => host.harness.removeProvider(id),
      setConfig: (patch) => host.harness.setConfig(patch),
      resolveOAuthToken: async (providerName, oauthRef) => {
        const tokenProvider = host.harness.auth.resolveOAuthTokenProvider(providerName, oauthRef);
        return tokenProvider.getAccessToken();
      },
      userAgent: createKimiCodeUserAgent(),
    };
    const result = await refreshAllProviderModels(hostAdapter, { scope });
    if (result.changed.length > 0) {
      await this.refreshAvailableModels();
    }
    return result;
  }
}
