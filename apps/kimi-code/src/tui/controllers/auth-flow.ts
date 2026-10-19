import {
  type KimiHarness,
  type RefreshProviderModelsResponse,
  type Session,
  type ThinkingEffort,
} from '@moonshot-ai/kimi-code-sdk';

import { OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE } from '../constant/kimi-tui';
import { thinkingEffortFromConfig } from '../utils/thinking-config';
import type { AppState, KimiTUIOptions } from '../types';

export interface AuthFlowHost {
  session: Session | undefined;
  readonly harness: KimiHarness;
  readonly options: KimiTUIOptions;

  setAppState(patch: Partial<AppState>): void;
  setStartupReady(): void;
  resetSessionRuntime(): void;
  appendStartupNotice(extra: string): void;
  hydrateLazyConfigDefaults(): Promise<void>;
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
    this.host.appendStartupNotice(OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE);
    this.host.setStartupReady();
  }

  /**
   * Apply a model pick to the runtime. Returns whether the activation made
   * the engine emit `model_switch` — it reached an already-live session AND
   * changed the bound alias (both engines track the event only on an actual
   * alias change). `false` when no live session existed (session creation is
   * deferred to the first prompt) or the alias was already bound, so callers
   * mirroring the engine's telemetry must stay the producer for exactly
   * those paths. Thinking-effort changes are orthogonal: the engine's
   * `thinking_toggle` fires from `setThinking` regardless of this flag.
   */
  async activateModelAfterLogin(model: string, effort?: string): Promise<boolean> {
    const { host } = this;
    if (host.session !== undefined) {
      const session = host.session;
      const modelChanged = (await session.getStatus()).model !== model;
      await session.setModel(model);
      if (effort !== undefined) {
        await session.setThinking(effort);
      }
      return modelChanged;
    }

    // Lazy session creation (v2 engine): configure the model only; the
    // session is created on the first message. The effort is carried as the
    // first session's thinking override so a session-only choice (Alt+S)
    // made before any session exists is applied on creation.
    const patch: Partial<AppState> = { model };
    if (effort !== undefined) {
      patch.thinkingEffort = effort as ThinkingEffort;
      patch.lazySessionThinking = effort as ThinkingEffort;
    }
    host.setAppState(patch);
    return false;
  }

  /**
   * Re-read config and reactivate the persisted model after login or a
   * config-refreshing command. Returns whatever the activation reports (see
   * {@link activateModelAfterLogin}); `false` when no activation ran.
   */
  async refreshConfigAfterLogin(): Promise<boolean> {
    const { host } = this;
    const config = await host.harness.getConfig({ reload: true });
    const availableModels = config.models ?? {};
    const availableProviders = config.providers ?? {};
    const defaultModel = host.options.startup.model ?? config.defaultModel;
    const selected = defaultModel !== undefined ? availableModels[defaultModel] : undefined;

    if (defaultModel === undefined || selected === undefined) {
      if (host.session === undefined) {
        // Session-less v2: hydrate permission/plan defaults even without a
        // default model.
        await host.hydrateLazyConfigDefaults();
      }
      host.setAppState({ availableModels, availableProviders });
      return false;
    }

    const activated = await this.activateModelAfterLogin(
      defaultModel,
      thinkingEffortFromConfig(config.thinking),
    );
    if (host.session === undefined) {
      // Session-less v2: also hydrate permission/plan defaults from the
      // refreshed config, same as startup.
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

  /**
   * Re-fetch model lists from every provider whose upstream supports it
   * (managed OAuth, open platforms, custom registries) and update local
   * config.  Runs best-effort: individual provider failures are collected
   * and returned instead of thrown.
   */
  async refreshProviderModels(): Promise<RefreshProviderModelsResponse> {
    const result = await this.host.harness.refreshProviderModels();
    if (result.changed.length > 0) {
      await this.refreshAvailableModels();
    }
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
