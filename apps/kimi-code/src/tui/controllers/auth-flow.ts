import {
  type KimiHarness,
  type RefreshProviderModelsOptions,
  type RefreshProviderModelsResponse,
  type Session,
  type ThinkingEffort,
} from '@moonshot-ai/kimi-code-sdk';

import {
  confirmThenPerformModelSwitch,
  matchedModelSwitchRule,
} from '../commands/config';
import type { SlashCommandHost } from '../commands/dispatch';
import { OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE } from '../constant/kimi-tui';
import { refreshEffortSwitchConfig } from '#/utils/effort-switch-config';
import { refreshModelSwitchConfirmConfig } from '#/utils/model-switch-confirm-config';
import { lazyModelSelection } from '../utils/model-switch';
import { thinkingEffortFromConfig } from '../utils/thinking-config';
import type { AppState, KimiTUIOptions } from '../types';

export interface AuthFlowHost {
  session: Session | undefined;
  readonly harness: KimiHarness;
  readonly options: KimiTUIOptions;

  setAppState(patch: Partial<AppState>): void;
  setStartupReady(): void;
  resetSessionRuntime(): void;
  setAuthRequired(required: boolean): void;
  appendStartupNotice(extra: string): void;
  hydrateLazyConfigDefaults(includeModel?: boolean): Promise<void>;
}

export class AuthFlowController {
  constructor(private readonly host: AuthFlowHost) {}

  async refreshAvailableModels(): Promise<void> {
    const config = await this.host.harness.getConfig({ reload: true });
    this.host.setAppState({
      availableModels: config.models ?? {},
      availableProviders: config.providers ?? {},
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
    this.host.setAuthRequired(true);
    this.host.appendStartupNotice(OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE);
    this.host.setStartupReady();
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

  async refreshConfigAfterLogin(effortOverride?: ThinkingEffort): Promise<boolean | 'gated'> {
    const { host } = this;
    const config = await host.harness.getConfig({ reload: true });
    const availableModels = config.models ?? {};
    const availableProviders = config.providers ?? {};
    const defaultModel = host.options.startup.model ?? config.defaultModel;
    const selected = defaultModel !== undefined ? availableModels[defaultModel] : undefined;
    try {
      const accessToken = await host.harness.auth.getCachedAccessToken();
      await Promise.all([
        refreshModelSwitchConfirmConfig({ accessToken }),
        refreshEffortSwitchConfig({ accessToken }),
      ]);
    } catch {}

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
      await host.hydrateLazyConfigDefaults();
      host.setAppState({ availableModels, availableProviders });
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
    const config = await this.host.harness.getConfig({ reload: true });
    const availableModels = config.models ?? {};
    const availableProviders = config.providers ?? {};

    if (this.host.session !== undefined) {
      this.host.setAppState({ availableModels, availableProviders });
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
