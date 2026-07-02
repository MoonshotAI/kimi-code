/**
 * `profile` domain (L3) — `IAgentProfileService` implementation.
 *
 * Owns the active agent's model alias, thinking level, system prompt, and
 * active-tool set; resolves the runnable god-object Model through the App-
 * scope `IModelResolver`, persists profile changes through `wireRecord`, and
 * emits status through `eventBus`. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import {
  UNKNOWN_CAPABILITY,
  type GenerationKwargs,
  type ModelCapability,
  type ThinkingEffort,
} from '#/app/llmProtocol';
import { IModelResolver, type KimiModelOverrides, type Model } from '#/app/model';
import picomatch from 'picomatch';

import { ErrorCodes, KimiError } from "#/errors";
import { IBootstrapService } from '#/app/bootstrap';
import { IConfigService } from '#/app/config';
import { resolveThinkingEffort } from './thinking';
import type { LoopControl } from '#/agent/loop/configSection';
import { IHostEnvironment } from '#/app/hostEnvironment';
import { ISessionAgentFileSystem } from '#/session/agentFs';
import { IExecContext } from '#/session/execContext';
import { isMcpToolName } from '#/agent/tool';
import { ISessionWorkspaceContext } from '#/session/workspaceContext';
import type { ResolvedAgentProfile, SystemPromptContext } from '#/agent/profile';

import { IAgentRecordService, type AgentRecord } from '#/agent/record';
import { ITelemetryService } from '#/app/telemetry';
import type { ToolSource } from '#/agent/tool';
import { prepareSystemPromptContext } from './context';
import type {
  ApplyProfileOptions,
  ProfileData,
  ProfileModelContext,
  ProfileServiceOptions,
  ProfileSetModelResult,
  ProfileUpdateData,
} from './profile';
import { IAgentProfileService } from './profile';
import {
  THINKING_SECTION,
  type ThinkingConfig,
} from './configSection';

declare module '#/agent/wireRecord' {
  interface WireRecordMap {
    'config.update': Omit<ProfileUpdateData, 'activeToolNames'>;
    'tools.set_active_tools': {
      names: readonly string[];
    };
  }
}

export class AgentProfileService implements IAgentProfileService {
  declare readonly _serviceBrand: undefined;

  private optionsValue: ProfileServiceOptions = {};
  private cwdValue: string | undefined;
  private modelAliasValue: string | undefined;
  private profileName: string | undefined;
  private thinkingLevelValue: ThinkingEffort = 'off';
  private systemPrompt = '';
  private activeToolNames: readonly string[] | undefined;
  private agentsMdWarning: string | undefined;

  constructor(
    @IAgentRecordService private readonly record: IAgentRecordService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IConfigService private readonly config: IConfigService,
    @IModelResolver private readonly modelFactory: IModelResolver,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @ISessionAgentFileSystem private readonly fs: ISessionAgentFileSystem,
    @IExecContext private readonly execCtx: IExecContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
  ) {
    this.configure({});
    record.define('config.update', {
      resume: (r) => {
        this.apply(stripConfigMeta(r));
      },
      toReplay: (r) => ({ type: 'config_updated', config: stripConfigMeta(r) }),
    });
    record.define('tools.set_active_tools', {
      resume: (r) => {
        this.applyActiveToolNames(r.names);
      },
    });
  }

  configure(options: ProfileServiceOptions): void {
    this.optionsValue = {
      cwd: options.cwd ?? this.optionsValue.cwd,
      chdir: options.chdir ?? this.optionsValue.chdir,
      emitStatusUpdated: options.emitStatusUpdated ?? this.optionsValue.emitStatusUpdated,
    };
    if (this.cwdValue === undefined) {
      this.cwdValue = this.readConfiguredCwd();
    }
  }

  update(changed: ProfileUpdateData): void {
    const { activeToolNames, ...configChanged } = changed;
    if (Object.keys(configChanged).length > 0) {
      this.record.append({ type: 'config.update', ...configChanged });
      this.apply(configChanged);
    }
    if (activeToolNames !== undefined) {
      this.setActiveTools(activeToolNames);
    }
  }

  setModel(alias: string): ProfileSetModelResult {
    const model = this.modelFactory.resolve(alias);
    if (this.modelAlias !== alias) {
      this.update({ modelAlias: alias });
      this.telemetry.track('model_switch', { model: alias });
    }
    return {
      model: alias,
      providerName: model.providerName,
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

  async applyProfile(profile: ResolvedAgentProfile, options?: ApplyProfileOptions): Promise<void> {
    const context = await prepareSystemPromptContext(
      { fs: this.fs, homeDir: this.env.homeDir },
      this.execCtx.cwd,
      this.bootstrap.homeDir,
      {
        additionalDirs: options?.additionalDirs ?? this.workspace.additionalDirs,
      },
    );
    this.useProfile(profile, context);
    const { agentsMdWarning } = context;
    this.agentsMdWarning = agentsMdWarning;
    if (agentsMdWarning !== undefined) {
      this.record.signal({
        type: 'warning',
        message: agentsMdWarning,
        code: 'agents-md-oversized',
      });
    }
  }

  getAgentsMdWarning(): string | undefined {
    return this.agentsMdWarning;
  }

  data(): ProfileData {
    const model = this.tryResolveRawModel();
    return {
      cwd: this.cwd,
      modelAlias: this.modelAlias,
      modelCapabilities: model?.capabilities ?? UNKNOWN_CAPABILITY,
      profileName: this.profileName,
      thinkingLevel: this.thinkingLevel,
      systemPrompt: this.systemPrompt,
      activeToolNames: this.activeToolNames === undefined ? undefined : [...this.activeToolNames],
    };
  }

  resolveModelContext(): ProfileModelContext {
    const modelAlias = this.model;
    const model = this.modelFactory.resolve(modelAlias);
    const loopControl = this.config.get<LoopControl>('loopControl');
    return {
      modelAlias,
      modelCapabilities: model.capabilities,
      maxOutputSize: model.maxOutputSize,
      alwaysThinking: model.alwaysThinking || undefined,
      thinkingLevel: this.thinkingLevel,
      reservedContextSize: loopControl?.reservedContextSize,
      compactionTriggerRatio: loopControl?.compactionTriggerRatio,
    };
  }

  getProvider(): Model {
    const model = this.resolveModel();
    if (model === undefined) {
      throw new KimiError(ErrorCodes.MODEL_NOT_CONFIGURED, 'Model not set');
    }
    return model;
  }

  get provider(): Model {
    return this.getProvider();
  }

  resolveModel(): Model | undefined {
    if (this.modelAlias === undefined) return undefined;
    let model: Model = this.modelFactory.resolve(this.modelAlias);
    model = model.withThinking(this.thinkingLevel);
    const overrides = this.config.get<KimiModelOverrides>('modelOverrides');
    if (overrides !== undefined) {
      const kwargs: GenerationKwargs = {};
      if (overrides.temperature !== undefined) kwargs.temperature = overrides.temperature;
      if (overrides.topP !== undefined) kwargs.top_p = overrides.topP;
      if (Object.keys(kwargs).length > 0) model = model.withGenerationKwargs(kwargs);
    }
    return model;
  }

  getModelCapabilities(): ModelCapability {
    return this.tryResolveRawModel()?.capabilities ?? UNKNOWN_CAPABILITY;
  }

  getMaxOutputSize(): number | undefined {
    return this.tryResolveRawModel()?.maxOutputSize;
  }

  hasModel(): boolean {
    return this.modelAlias !== undefined;
  }

  hasProvider(): boolean {
    return this.tryResolveRawModel() !== undefined;
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
    if (changed.cwd !== undefined) {
      this.cwdValue = changed.cwd;
      void this.optionsValue.chdir?.(changed.cwd);
    }
    if (changed.modelAlias !== undefined) this.modelAliasValue = changed.modelAlias;
    if (changed.profileName !== undefined) this.profileName = changed.profileName;
    if (changed.thinkingLevel !== undefined) {
      this.thinkingLevelValue = resolveThinkingEffort(
        changed.thinkingLevel,
        this.config.get<ThinkingConfig>(THINKING_SECTION),
      );
    }
    if (changed.systemPrompt !== undefined) this.systemPrompt = changed.systemPrompt;
    if (changed.activeToolNames !== undefined) {
      this.applyActiveToolNames(changed.activeToolNames);
    }
    this.emitStatusUpdated();
  }

  private setActiveTools(names: readonly string[]): void {
    this.record.append({ type: 'tools.set_active_tools', names: [...names] });
    this.applyActiveToolNames(names);
  }

  private applyActiveToolNames(names: readonly string[]): void {
    this.activeToolNames = [...names];
  }

  private emitStatusUpdated(): void {
    const custom = this.optionsValue.emitStatusUpdated;
    if (custom !== undefined) {
      custom();
      return;
    }
    if (!this.hasModel()) return;
    this.record.signal({
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
    return this.modelAliasValue;
  }

  private get thinkingLevel(): ThinkingEffort {
    if (this.thinkingLevelValue === 'off' && this.alwaysThinkingModel) {
      return resolveThinkingEffort('on', this.config.get<ThinkingConfig>(THINKING_SECTION));
    }
    return this.thinkingLevelValue;
  }

  private get alwaysThinkingModel(): boolean {
    return this.tryResolveRawModel()?.alwaysThinking === true;
  }

  private tryResolveRawModel(): Model | undefined {
    const alias = this.modelAlias;
    if (alias === undefined) return undefined;
    try {
      return this.modelFactory.resolve(alias);
    } catch {
      return undefined;
    }
  }

  private readConfiguredCwd(): string | undefined {
    const cwd = this.optionsValue.cwd;
    return typeof cwd === 'function' ? cwd() : cwd;
  }
}

function stripConfigMeta(record: AgentRecord<'config.update'>): ProfileUpdateData {
  const { type: _type, time: _time, ...changed } = record;
  return changed;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentProfileService,
  AgentProfileService,
  InstantiationType.Delayed,
  'profile',
);
