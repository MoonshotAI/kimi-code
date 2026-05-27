import type { KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';
import type { SkillListSession } from '../commands';

import { OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE } from '../constant/kimi-tui';
import type { SessionEventHandler } from './session-event-handler';
import { combineStartupNotice } from '../utils/startup';
import type { AppState } from '../types';
import type { KimiTUIOptions, TUIState } from '../kimi-tui';

export interface AuthFlowHost {
  state: TUIState;
  session: Session | undefined;
  readonly harness: KimiHarness;
  readonly options: KimiTUIOptions;

  setAppState(patch: Partial<AppState>): void;
  resetSessionRuntime(): void;
  setSession(session: Session): Promise<void>;
  syncRuntimeState(session?: Session): Promise<void>;
  closeSession(reason: string): Promise<void>;
  readonly sessionEventHandler: SessionEventHandler;
  fetchSessions(): Promise<void>;
  refreshSessionTitle(): void;
  refreshSkillCommands(session?: SkillListSession): Promise<void>;
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
      thinking: false,
      contextTokens: 0,
      maxContextTokens: 0,
      contextUsage: 0,
      sessionTitle: null,
    });
    this.host.state.startupNotice = combineStartupNotice(
      this.host.state.startupNotice,
      OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE,
    );
    this.host.state.startupState = 'ready';
  }

  async activateModelAfterLogin(model: string, thinking?: boolean): Promise<void> {
    const { host } = this;
    const level = thinking === undefined ? undefined : thinking ? 'on' : 'off';
    if (host.session !== undefined) {
      await host.session.setModel(model);
      if (level !== undefined) {
        await host.session.setThinking(level);
      }
      return;
    }

    const session = await host.harness.createSession({
      workDir: host.state.appState.workDir,
      model,
      thinking: level,
      permission: host.options.startup.yolo ? 'yolo' : undefined,
      planMode: host.state.appState.planMode ? true : undefined,
    });
    await host.setSession(session);
    host.setAppState({
      sessionId: session.id,
      sessionTitle: session.summary?.title ?? null,
    });
    await host.syncRuntimeState(session);
    host.sessionEventHandler.startSubscription();
    void host.fetchSessions();
    host.refreshSessionTitle();
    void host.refreshSkillCommands(host.session);
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
  }

  async refreshConfigAfterLogin(): Promise<void> {
    const { host } = this;
    const config = await host.harness.getConfig({ reload: true });
    const availableModels = config.models ?? {};
    const availableProviders = config.providers ?? {};
    const defaultModel = host.options.startup.model ?? config.defaultModel;
    const selected = defaultModel !== undefined ? availableModels[defaultModel] : undefined;

    if (defaultModel === undefined || selected === undefined) {
      host.setAppState({ availableModels, availableProviders });
      return;
    }

    await this.activateModelAfterLogin(defaultModel, config.defaultThinking);
    const appStatePatch: Partial<AppState> = {
      availableModels,
      availableProviders,
      model: defaultModel,
      maxContextTokens: selected.maxContextSize,
    };
    if (config.defaultThinking !== undefined) {
      appStatePatch.thinking = config.defaultThinking;
    }
    host.setAppState(appStatePatch);
  }

  async refreshConfigAfterLogout(): Promise<void> {
    const config = await this.host.harness.getConfig({ reload: true });
    this.host.setAppState({
      availableModels: config.models ?? {},
      availableProviders: config.providers ?? {},
      model: '',
      thinking: false,
      maxContextTokens: 0,
      contextUsage: 0,
      contextTokens: 0,
    });
  }
}
