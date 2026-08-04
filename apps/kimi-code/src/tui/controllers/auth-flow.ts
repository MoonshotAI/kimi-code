import {
  removeProviderFromConfig,
  type CreateSessionOptions,
  type KimiConfig,
  type KimiHarness,
  type OAuthRef,
  type Session,
  type ThinkingEffort,
} from '@moonshot-ai/kimi-code-sdk';

import { createKimiCodeUserAgent } from '#/cli/version';

import type { SkillListSession } from '../commands';

import { OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE } from '../constant/kimi-tui';
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

type MutableCreateSessionOptions = {
  -readonly [P in keyof CreateSessionOptions]: CreateSessionOptions[P];
};

export interface AuthFlowHost {
  state: TUIState;
  session: Session | undefined;
  readonly harness: KimiHarness;
  readonly options: KimiTUIOptions;
  readonly engineV2: boolean;

  setAppState(patch: Partial<AppState>): void;
  setStartupReady(): void;
  resetSessionRuntime(): void;
  setSession(session: Session): Promise<void>;
  syncRuntimeState(session?: Session): Promise<void>;
  closeSession(reason: string): Promise<void>;
  appendStartupNotice(extra: string): void;
  hydrateLazyConfigDefaults(): Promise<void>;
  readonly sessionEventHandler: SessionEventHandler;
  fetchSessions(): Promise<void>;
  updateTerminalTitle(): void;
  refreshSkillCommands(session?: SkillListSession): Promise<void>;
  refreshPluginCommands(session?: Session): Promise<void>;
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

  async activateModelAfterLogin(model: string, effort?: string): Promise<void> {
    const { host } = this;
    if (host.session !== undefined) {
      await host.session.setModel(model);
      if (effort !== undefined) {
        await host.session.setThinking(effort);
      }
      return;
    }

    if (host.engineV2) {
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
      return;
    }

    const options: MutableCreateSessionOptions = {
      workDir: host.state.appState.workDir,
      model,
      thinking: effort,
      permission: host.options.startup.auto
        ? 'auto'
        : host.options.startup.yolo
          ? 'yolo'
          : undefined,
      planMode: host.state.appState.planMode ? true : undefined,
      // The post-login session is still the startup session: carry the
      // --agent/--agent-file binding resolved at launch.
      agentProfile: host.options.startup.agentProfile,
      agentFiles: host.options.startup.agentFiles?.length
        ? [...host.options.startup.agentFiles]
        : undefined,
    };
    if (host.state.appState.additionalDirs.length > 0) {
      options.additionalDirs = [...host.state.appState.additionalDirs];
    }
    const session = await host.harness.createSession(options);
    await host.setSession(session);
    host.setAppState({
      sessionId: session.id,
      sessionTitle: session.summary?.title ?? null,
    });
    await host.syncRuntimeState(session);
    host.sessionEventHandler.startSubscription();
    void host.fetchSessions();
    host.updateTerminalTitle();
    void host.refreshSkillCommands(host.session);
    void host.refreshPluginCommands(host.session);
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
    const availableModels = config.models ?? {};
    const availableProviders = config.providers ?? {};
    const defaultModel = host.options.startup.model ?? config.defaultModel;
    const selected = defaultModel !== undefined ? availableModels[defaultModel] : undefined;

    if (defaultModel === undefined || selected === undefined) {
      if (host.session === undefined && host.engineV2) {
        // Session-less v2: hydrate permission/plan defaults even without a
        // default model.
        await host.hydrateLazyConfigDefaults();
      }
      host.setAppState({ availableModels, availableProviders });
      return;
    }

    await this.activateModelAfterLogin(defaultModel, thinkingEffortFromConfig(config.thinking));
    if (host.session === undefined && host.engineV2) {
      // Session-less v2: also hydrate permission/plan defaults from the
      // refreshed config, same as startup.
      await host.hydrateLazyConfigDefaults();
      host.setAppState({ availableModels, availableProviders });
      return;
    }
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
      availableModels: config.models ?? {},
      availableProviders: config.providers ?? {},
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
    const result = await refreshAllProviderModels(this.buildRefreshHost(), { scope });
    if (result.changed.length > 0) {
      await this.refreshAvailableModels();
    }
    return result;
  }

  /**
   * Build the refresh orchestrator's persistence host. When the harness can
   * persist several config sections as ONE atomic write (the v2 engine's
   * `replaceSections`), the orchestrator's two-phase contract (removeProvider
   * then setConfig) is absorbed the same way the v2 engine's own refresh path
   * does it: the removal is staged in memory only, and the following
   * setConfig persists the complete records in a single write — so a process
   * exit mid-refresh can never leave config.toml in a "provider removed, not
   * yet restored" state. The v1 harness keeps the legacy host (two
   * whole-document writes, each atomic on its own).
   */
  private buildRefreshHost(): RefreshProviderHost {
    const { host } = this;
    const resolveOAuthToken = async (providerName: string, oauthRef?: OAuthRef): Promise<string> => {
      const tokenProvider = host.harness.auth.resolveOAuthTokenProvider(providerName, oauthRef);
      return tokenProvider.getAccessToken();
    };
    const userAgent = createKimiCodeUserAgent();
    if (!host.harness.supportsAtomicSectionReplace()) {
      return {
        getConfig: () => host.harness.getConfig({ reload: true }),
        removeProvider: (id) => host.harness.removeProvider(id),
        setConfig: (patch) => host.harness.setConfig(patch),
        resolveOAuthToken,
        userAgent,
      };
    }
    let staged: KimiConfig | undefined;
    const requireStaged = (): KimiConfig => {
      if (staged === undefined) {
        throw new Error('refresh host: getConfig must be called before writes');
      }
      return staged;
    };
    return {
      getConfig: async () => {
        staged = await host.harness.getConfig({ reload: true });
        return staged;
      },
      removeProvider: (id) => {
        staged = removeProviderFromConfig(requireStaged(), id);
        return Promise.resolve(staged);
      },
      setConfig: async (patch) => {
        // The orchestrator always passes complete records (built from a full
        // clone), so the Partial-shaped patch is a full KimiConfig overlay.
        staged = { ...requireStaged(), ...patch } as KimiConfig;
        // Object.entries keeps keys whose value is `undefined`, so a cleared
        // section (e.g. a dangling defaultModel) is expressed as a removal in
        // the atomic write; sections absent from the patch stay untouched.
        await host.harness.replaceConfigSections(Object.fromEntries(Object.entries(patch)));
        return staged;
      },
      resolveOAuthToken,
      userAgent,
    };
  }
}
