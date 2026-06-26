import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import {
  createProvider,
  UNKNOWN_CAPABILITY,
  type ChatProvider,
  type ModelCapability,
  type ProviderConfig,
} from '@moonshot-ai/kosong';
import picomatch from 'picomatch';

import { ErrorCodes, KimiError } from "#/errors";
import { resolveThinkingEffort, type ThinkingEffort } from '#/config/thinking';
import type { KimiConfig } from '#/config';
import {
  applyKimiEnvSamplingParams,
  applyKimiEnvThinkingKeep,
} from '#/config/kimi-env-params';
import { isMcpToolName } from '#/mcp/tool-naming';
import type { ResolvedAgentProfile, SystemPromptContext } from '#/profile';
import type { ResolvedRuntimeProvider } from '#/session/provider-manager';

import { IEventBus } from '#/eventBus';
import { IReplayBuilderService } from '#/replayBuilder';
import { ITelemetryService } from '#/telemetry';
import type { ToolSource } from '#/toolRegistry';
import { IWireRecord } from '#/wireRecord';
import type {
  ProfileData,
  ProfileModelContext,
  ProfileServiceOptions,
  ProfileSetModelResult,
  ProfileUpdateData,
} from './profile';
import { IProfileService } from './profile';

declare module '#/wireRecord' {
  interface WireRecordMap {
    'config.update': Omit<ProfileUpdateData, 'activeToolNames'>;
    'tools.set_active_tools': {
      names: readonly string[];
    };
  }
}

export class ProfileService implements IProfileService {
  declare readonly _serviceBrand: undefined;

  private optionsValue: ProfileServiceOptions = {};
  private cwdValue: string | undefined;
  private modelAliasValue: string | undefined;
  private profileName: string | undefined;
  private thinkingLevelValue: ThinkingEffort = 'off';
  private systemPrompt = '';
  private activeToolNames: readonly string[] | undefined;

  constructor(
    options: ProfileServiceOptions = {},
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IEventBus private readonly events: IEventBus,
    @IReplayBuilderService private readonly replayBuilder: IReplayBuilderService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    this.configure(options);
    wireRecord.register('config.update', (record) => {
      const { type: _type, time: _time, ...changed } = record;
      this.apply(changed);
    });
    wireRecord.register('tools.set_active_tools', (record) => {
      this.applyActiveToolNames(record.names);
      this.initializeBuiltinTools();
    });
  }

  configure(options: ProfileServiceOptions): void {
    this.optionsValue = {
      cwd: options.cwd ?? this.optionsValue.cwd,
      chdir: options.chdir ?? this.optionsValue.chdir,
      modelProvider: options.modelProvider ?? this.optionsValue.modelProvider,
      config: options.config ?? this.optionsValue.config,
      initializeBuiltinTools:
        options.initializeBuiltinTools ?? this.optionsValue.initializeBuiltinTools,
      emitStatusUpdated: options.emitStatusUpdated ?? this.optionsValue.emitStatusUpdated,
    };
    if (this.cwdValue === undefined) {
      this.cwdValue = this.readConfiguredCwd();
    }
    if (this.modelAliasValue === undefined) {
      this.modelAliasValue = this.optionsValue.modelProvider?.defaultModel;
    }
  }

  update(changed: ProfileUpdateData): void {
    const { activeToolNames, ...configChanged } = changed;
    if (Object.keys(configChanged).length > 0) {
      this.wireRecord.append({ type: 'config.update', ...configChanged });
      this.apply(configChanged);
    }
    if (activeToolNames !== undefined) {
      this.setActiveTools(activeToolNames);
    }
  }

  setModel(model: string): ProfileSetModelResult {
    const resolved = this.optionsValue.modelProvider?.resolveProviderConfig(model);
    if (this.modelAlias !== model) {
      this.update({ modelAlias: model });
      this.telemetry.track('model_switch', { model });
    }
    return {
      model,
      providerName: resolved?.providerName,
    };
  }

  setThinking(level: string): void {
    const wasEnabled = this.thinkingLevel !== 'off';
    this.update({ thinkingLevel: level });
    const enabled = this.thinkingLevel !== 'off';
    if (enabled !== wasEnabled) {
      this.telemetry.track('thinking_toggle', { enabled });
    }
  }

  getModel(): string {
    return this.modelAlias ?? '';
  }

  useProfile(profile: ResolvedAgentProfile, context: SystemPromptContext): void {
    this.update({
      profileName: profile.name,
      systemPrompt: profile.systemPrompt(context),
    });
    this.setActiveTools(profile.tools);
  }

  data(): ProfileData {
    const resolved = this.tryResolvedProviderConfig();
    return {
      cwd: this.cwd,
      provider: resolved?.provider,
      modelAlias: this.modelAlias,
      modelCapabilities: resolved?.modelCapabilities ?? UNKNOWN_CAPABILITY,
      profileName: this.profileName,
      thinkingLevel: this.thinkingLevel,
      systemPrompt: this.systemPrompt,
      activeToolNames: this.activeToolNames === undefined ? undefined : [...this.activeToolNames],
    };
  }

  resolveModelContext(): ProfileModelContext {
    const modelAlias = this.model;
    const resolved = this.optionsValue.modelProvider?.resolveProviderConfig(modelAlias);
    if (resolved === undefined) {
      throw new KimiError(ErrorCodes.MODEL_NOT_CONFIGURED, 'Provider not set');
    }
    const config = this.config();
    return {
      provider: resolved.provider,
      modelAlias,
      modelCapabilities: resolved.modelCapabilities,
      maxOutputSize: resolved.maxOutputSize,
      alwaysThinking: resolved.alwaysThinking,
      thinkingLevel: this.thinkingLevel,
      reservedContextSize: config?.loopControl?.reservedContextSize,
      compactionTriggerRatio: config?.loopControl?.compactionTriggerRatio,
    };
  }

  getProvider(): ChatProvider {
    const provider = createProvider(this.providerConfig).withThinking(this.thinkingLevel);
    return applyKimiEnvThinkingKeep(applyKimiEnvSamplingParams(provider), this.thinkingLevel);
  }

  get provider(): ChatProvider {
    return this.getProvider();
  }

  getModelCapabilities(): ModelCapability {
    return this.tryResolvedProviderConfig()?.modelCapabilities ?? UNKNOWN_CAPABILITY;
  }

  getMaxOutputSize(): number | undefined {
    return this.tryResolvedProviderConfig()?.maxOutputSize;
  }

  hasModel(): boolean {
    return this.modelAlias !== undefined;
  }

  hasProvider(): boolean {
    return this.tryResolvedProviderConfig() !== undefined;
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  getActiveToolNames(): readonly string[] | undefined {
    return this.activeToolNames;
  }

  isToolActive(name: string, source: ToolSource = 'builtin'): boolean {
    const activeToolNames = this.activeToolNames;
    if (activeToolNames === undefined) return true;
    if (source !== 'mcp') return activeToolNames.includes(name);
    return activeToolNames
      .filter((pattern) => isMcpToolName(pattern))
      .some((pattern) => picomatch.isMatch(name, pattern));
  }

  addActiveTool(name: string): void {
    const activeToolNames = this.activeToolNames;
    if (activeToolNames === undefined || activeToolNames.includes(name)) return;
    this.applyActiveToolNames([...activeToolNames, name]);
  }

  removeActiveTool(name: string): void {
    const activeToolNames = this.activeToolNames;
    if (activeToolNames === undefined || !activeToolNames.includes(name)) return;
    this.applyActiveToolNames(activeToolNames.filter((candidate) => candidate !== name));
  }

  private apply(changed: ProfileUpdateData): void {
    this.replayBuilder.push({ type: 'config_updated', config: changed });
    if (changed.cwd !== undefined) {
      this.cwdValue = changed.cwd;
      void this.optionsValue.chdir?.(changed.cwd);
    }
    if (changed.modelAlias !== undefined) this.modelAliasValue = changed.modelAlias;
    if (changed.profileName !== undefined) this.profileName = changed.profileName;
    if (changed.thinkingLevel !== undefined) {
      this.thinkingLevelValue = resolveThinkingEffort(
        changed.thinkingLevel,
        this.config()?.thinking,
      );
    }
    if (changed.systemPrompt !== undefined) this.systemPrompt = changed.systemPrompt;
    if (changed.activeToolNames !== undefined) {
      this.applyActiveToolNames(changed.activeToolNames);
    }
    if (this.hasProvider() && (changed.cwd !== undefined || changed.modelAlias !== undefined)) {
      this.optionsValue.initializeBuiltinTools?.();
    }
    this.emitStatusUpdated();
  }

  private setActiveTools(names: readonly string[]): void {
    this.wireRecord.append({ type: 'tools.set_active_tools', names: [...names] });
    this.applyActiveToolNames(names);
    this.initializeBuiltinTools();
  }

  private applyActiveToolNames(names: readonly string[]): void {
    this.activeToolNames = [...names];
  }

  private initializeBuiltinTools(): void {
    if (!this.hasProvider()) return;
    this.optionsValue.initializeBuiltinTools?.();
  }

  private emitStatusUpdated(): void {
    const custom = this.optionsValue.emitStatusUpdated;
    if (custom !== undefined) {
      custom();
      return;
    }
    if (!this.hasModel()) return;
    this.events.emit({
      type: 'agent.status.updated',
      model: this.modelAlias,
      maxContextTokens: this.getModelCapabilities().max_context_tokens,
    });
  }

  private get cwd(): string {
    return this.cwdValue ?? this.readConfiguredCwd() ?? '';
  }

  private get model(): string {
    const modelAlias = this.modelAlias;
    if (modelAlias === undefined) {
      throw new KimiError(ErrorCodes.MODEL_NOT_CONFIGURED, 'Model not set');
    }
    return modelAlias;
  }

  private get modelAlias(): string | undefined {
    return this.modelAliasValue ?? this.optionsValue.modelProvider?.defaultModel;
  }

  private get providerConfig(): ProviderConfig {
    const provider = this.resolvedProviderConfig?.provider;
    if (provider === undefined) {
      throw new KimiError(ErrorCodes.MODEL_NOT_CONFIGURED, 'Provider not set');
    }
    return provider;
  }

  private get thinkingLevel(): ThinkingEffort {
    if (this.thinkingLevelValue === 'off' && this.alwaysThinkingModel) {
      return resolveThinkingEffort('on', this.config()?.thinking);
    }
    return this.thinkingLevelValue;
  }

  private get alwaysThinkingModel(): boolean {
    return this.tryResolvedProviderConfig()?.alwaysThinking === true;
  }

  private get resolvedProviderConfig(): ResolvedRuntimeProvider | undefined {
    const modelAlias = this.modelAlias;
    if (modelAlias === undefined) return undefined;
    return this.optionsValue.modelProvider?.resolveProviderConfig(modelAlias);
  }

  private tryResolvedProviderConfig(): ResolvedRuntimeProvider | undefined {
    try {
      return this.resolvedProviderConfig;
    } catch {
      return undefined;
    }
  }

  config(): KimiConfig | undefined {
    const config = this.optionsValue.config;
    return typeof config === 'function' ? config() : config;
  }

  private readConfiguredCwd(): string | undefined {
    const cwd = this.optionsValue.cwd;
    return typeof cwd === 'function' ? cwd() : cwd;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IProfileService,
  ProfileService,
  InstantiationType.Delayed,
  'profile',
);
