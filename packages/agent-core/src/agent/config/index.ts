import {
  createProvider,
  UNKNOWN_CAPABILITY,
  type ChatProvider,
  type ModelCapability,
  type ProviderConfig,
} from '@moonshot-ai/kosong';

import {
  applyKimiEnvSamplingParams,
  applyKimiEnvThinkingEffort,
  applyKimiEnvThinkingKeep,
} from '#/config/kimi-env-params';

import type { Agent } from '..';
import { ErrorCodes, KimiError } from '../../errors';
import type { AgentConfigData, AgentConfigUpdateData } from './types';
import { resolveThinkingEffort, type ThinkingEffort } from './thinking';
import type { ModelAlias } from '../../config/schema';
import type { ResolvedRuntimeProvider } from '../../session/provider-manager';

export * from './types';
export { resolveThinkingEffort, type ThinkingEffort } from './thinking';

export class ConfigState {
  private _cwd: string;
  private _modelAlias: string | undefined;
  private _profileName: string | undefined;
  private _thinkingEffort: ThinkingEffort = 'off';
  private _systemPrompt: string = '';

  constructor(protected readonly agent: Agent) {
    this._cwd = agent.kaos.getcwd();
    this._modelAlias = agent.modelProvider?.defaultModel;
  }

  update(changed: AgentConfigUpdateData): void {
    if (Object.keys(changed).length === 0) return;

    this.agent.records.logRecord({
      type: 'config.update',
      ...changed,
    });
    this.agent.replayBuilder.push({
      type: 'config_updated',
      config: changed,
    });
    if (changed.cwd) {
      this._cwd = changed.cwd;
      void this.agent.kaos.chdir(changed.cwd);
    }
    if (changed.modelAlias) {
      this._modelAlias = changed.modelAlias;
    }
    if (changed.profileName) {
      this._profileName = changed.profileName;
    }
    if (changed.thinkingEffort !== undefined) {
      // Resolve through the single source of truth so the always_thinking
      // clamp and any future normalization apply uniformly — whether the
      // level comes from createSession, setThinking RPC, or subagent
      // inheritance.
      this._thinkingEffort = resolveThinkingEffort(
        changed.thinkingEffort,
        this.agent.kimiConfig?.thinking,
        this.currentModel,
      );
    } else if (changed.modelAlias !== undefined) {
      // Re-apply the always_thinking clamp against the new model so a stale
      // 'off' cannot survive a switch onto an always-thinking alias.
      this._thinkingEffort = resolveThinkingEffort(
        this._thinkingEffort,
        this.agent.kimiConfig?.thinking,
        this.currentModel,
      );
    }
    if (changed.systemPrompt !== undefined) {
      this._systemPrompt = changed.systemPrompt;
    }
    if (this.hasProvider && (changed.cwd !== undefined || changed.modelAlias)) {
      this.agent.tools.initializeBuiltinTools();
    }
    this.agent.emitStatusUpdated();
  }

  data(): AgentConfigData {
    const resolved = this.tryResolvedProviderConfig();
    return {
      cwd: this.cwd,
      provider: resolved?.provider,
      modelAlias: this._modelAlias,
      modelCapabilities: resolved?.modelCapabilities ?? UNKNOWN_CAPABILITY,
      profileName: this.profileName,
      thinkingEffort: this.thinkingEffort,
      systemPrompt: this.systemPrompt,
    };
  }

  get cwd(): string {
    return this._cwd;
  }

  get hasModel(): boolean {
    return this._modelAlias !== undefined;
  }

  get hasProvider(): boolean {
    return this.tryResolvedProviderConfig() !== undefined;
  }

  get providerConfig(): ProviderConfig {
    const provider = this.resolvedProviderConfig?.provider;
    if (provider === undefined) {
      throw new KimiError(ErrorCodes.MODEL_NOT_CONFIGURED, 'Provider not set');
    }
    return provider;
  }

  get provider(): ChatProvider {
    // All provider-level request config is applied here so every request built
    // from config.provider — the main loop AND full-history compaction — carries it:
    //   - withThinking: preserve thinking during compaction (#464)
    //   - sampling params: KIMI_MODEL_TEMPERATURE / KIMI_MODEL_TOP_P
    //   - thinking.effort: KIMI_MODEL_THINKING_EFFORT (forces an effort, only while thinking is on)
    //   - thinking.keep: KIMI_MODEL_THINKING_KEEP (only while thinking is on)
    const provider = createProvider(this.providerConfig).withThinking(this.thinkingEffort);
    const withSampling = applyKimiEnvSamplingParams(provider);
    const withEffort = applyKimiEnvThinkingEffort(withSampling, this.thinkingEffort);
    return applyKimiEnvThinkingKeep(withEffort, this.thinkingEffort);
  }

  get model(): string {
    if (this._modelAlias === undefined) {
      throw new KimiError(ErrorCodes.MODEL_NOT_CONFIGURED, 'Model not set');
    }
    return this._modelAlias;
  }

  get modelAlias(): string | undefined {
    return this._modelAlias;
  }

  get thinkingEffort(): ThinkingEffort {
    // Already resolved (with the always_thinking clamp applied) in update();
    // return it verbatim.
    return this._thinkingEffort;
  }

  private get currentModel(): ModelAlias | undefined {
    const alias = this._modelAlias;
    if (alias === undefined) return undefined;
    return this.agent.kimiConfig?.models?.[alias];
  }

  get profileName(): string | undefined {
    return this._profileName;
  }

  get systemPrompt(): string {
    return this._systemPrompt;
  }

  get modelCapabilities(): ModelCapability {
    return this.tryResolvedProviderConfig()?.modelCapabilities ?? UNKNOWN_CAPABILITY;
  }

  get maxOutputSize(): number | undefined {
    return this.tryResolvedProviderConfig()?.maxOutputSize;
  }

  private get resolvedProviderConfig(): ResolvedRuntimeProvider | undefined {
    if (this._modelAlias === undefined) return undefined;
    return this.agent.modelProvider?.resolveProviderConfig(this._modelAlias);
  }

  private tryResolvedProviderConfig(): ResolvedRuntimeProvider | undefined {
    try {
      return this.resolvedProviderConfig;
    } catch {
      return undefined;
    }
  }
}
