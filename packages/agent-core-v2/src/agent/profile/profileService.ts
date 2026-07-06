/**
 * `profile` domain (L3) — `IAgentProfileService` implementation.
 *
 * Owns the active agent's model alias, thinking level, system prompt, and
 * active-tool set; resolves the runnable god-object Model through the App-
 * scope `IModelResolver`, persists the persistent config slice (`cwd` /
 * `modelAlias` / `profileName` / resolved `thinkingLevel` / `systemPrompt`) in
 * the `wire` `ProfileModel` through the `config.update` Op and the persisted
 * active-tool set in the `wire` `ActiveToolsModel` through the
 * `tools.set_active_tools` Op (`wire.dispatch`), and reads both through
 * `wire.getModel`. The effective active-tool set read by consumers is the
 * persisted base (`ActiveToolsModel`, rebuilt by `wire.replay`) overlaid with
 * the ephemeral per-tool deltas from `addActiveTool` / `removeActiveTool`
 * (used by `userTool`; intentionally not persisted, re-derived on resume); the
 * live overlay is cached in a field and falls back to the Model when unset, so
 * no restore-ordering coupling with `userTool` arises. The `agent.status.updated`
 * / `warning` signals now ride the `wire` signal channel (interface-merged into
 * `SignalMap`; `agent.status.updated` canonical in `usageOps`). `chdir` and
 * `emitStatusUpdated` run live-only after the dispatch, so `wire.replay`
 * rebuilds the Models silently.
 * Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import {
  UNKNOWN_CAPABILITY,
  type GenerationKwargs,
  type ModelCapability,
  type ThinkingEffort,
} from '#/app/llmProtocol';
import {
  DEFAULT_AGENT_PROFILE_NAME,
  IAgentProfileCatalogService,
} from '#/app/agentProfileCatalog';
import { IModelResolver, type KimiModelOverrides, type Model } from '#/app/model';
import picomatch from 'picomatch';

import { ErrorCodes, KimiError } from "#/errors";
import { IBootstrapService } from '#/app/bootstrap';
import { IConfigService } from '#/app/config';
import { resolveThinkingEffort } from './thinking';
import type { LoopControl } from '#/agent/loop/configSection';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionContext } from '#/session/sessionContext';
import { isMcpToolName } from '#/agent/tool';
import { ISessionWorkspaceContext } from '#/session/workspaceContext';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog';
import type { ResolvedAgentProfile, SystemPromptContext } from '#/agent/profile';

import type { WarningEvent } from '@moonshot-ai/protocol';
import { ITelemetryService } from '#/app/telemetry';
import type { ToolSource } from '#/agent/tool';
import { IAgentWireService, type IWireService } from '#/wire';
import { IEventBus } from '#/app/event';
import { prepareSystemPromptContext } from './context';
import type {
  ApplyProfileOptions,
  BindAgentInput,
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
import {
  ActiveToolsModel,
  configUpdate,
  ProfileModel,
  setActiveTools,
  type ActiveToolsState,
  type ConfigUpdatePayload,
  type ProfileModelState,
} from './profileOps';

declare module '#/agent/wireRecord' {
  interface WireRecordMap {
    'tools.set_active_tools': {
      names: readonly string[];
    };
  }
}

declare module '#/wire' {
  interface SignalMap {
    // `warning` is owned by `profile` (the agents-md-oversized notice); it is the
    // sole emitter, so the declaration lives here rather than in another domain.
    warning: Omit<WarningEvent, 'type'>;
  }
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    // `warning` is owned by `profile`; mirrors the `SignalMap` declaration above.
    warning: Omit<WarningEvent, 'type'>;
  }
}

export class AgentProfileService implements IAgentProfileService {
  declare readonly _serviceBrand: undefined;

  private optionsValue: ProfileServiceOptions = {};
  // Live overlay of ephemeral per-tool deltas (`addActiveTool` /
  // `removeActiveTool`) on top of the persisted `ActiveToolsModel`. `undefined`
  // means "no overlay — read the Model". Reset on every full `setActiveTools`.
  private activeToolNamesOverlay: readonly string[] | undefined;
  private agentsMdWarning: string | undefined;

  // Effective active-tool set: the live overlay when present, else the persisted
  // base rebuilt by `wire.replay`. `undefined` means every tool is active.
  private get activeToolNames(): ActiveToolsState {
    return (
      this.activeToolNamesOverlay ??
      (this.wire.getModel(ActiveToolsModel) as ActiveToolsState)
    );
  }

  constructor(
    @IAgentWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IConfigService private readonly config: IConfigService,
    @IModelResolver private readonly modelFactory: IModelResolver,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IAgentProfileCatalogService private readonly catalog: IAgentProfileCatalogService,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
  ) {
    this.configure({});
  }

  configure(options: ProfileServiceOptions): void {
    this.optionsValue = {
      cwd: options.cwd ?? this.optionsValue.cwd,
      chdir: options.chdir ?? this.optionsValue.chdir,
      emitStatusUpdated: options.emitStatusUpdated ?? this.optionsValue.emitStatusUpdated,
    };
  }

  update(changed: ProfileUpdateData): void {
    const { activeToolNames, ...configChanged } = changed;
    if (Object.keys(configChanged).length > 0) {
      this.wire.dispatch(configUpdate(this.resolveConfigPayload(configChanged)));
      this.afterConfigDispatch(configChanged);
    }
    if (activeToolNames !== undefined) {
      this.setActiveTools(activeToolNames);
    }
  }

  async bind(input: BindAgentInput): Promise<void> {
    const profile = this.catalog.get(input.profile);
    if (profile === undefined) {
      throw new Error(`Unknown agent profile: "${input.profile}"`);
    }
    // Resolve eagerly so an unknown model id fails the bind here rather than on
    // the first turn.
    this.modelFactory.resolve(input.model);

    const context = await this.buildSystemPromptContext(input.cwd);
    const systemPrompt = profile.systemPrompt(context);
    const { agentsMdWarning } = context;
    this.agentsMdWarning = agentsMdWarning;

    this.update({
      cwd: input.cwd,
      profileName: profile.name,
      modelAlias: input.model,
      thinkingLevel: input.thinking,
      systemPrompt,
      activeToolNames: profile.tools,
    });

    if (agentsMdWarning !== undefined) {
      this.eventBus.publish({
        type: 'warning',
        message: agentsMdWarning,
        code: 'agents-md-oversized',
      });
      this.wire.signal({
        type: 'warning',
        message: agentsMdWarning,
        code: 'agents-md-oversized',
      });
    }
  }

  async setModel(alias: string): Promise<ProfileSetModelResult> {
    const model = this.modelFactory.resolve(alias);
    if (this.profileName === undefined) {
      await this.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: alias });
      this.telemetry.track('model_switch', { model: alias });
    } else if (this.modelAlias !== alias) {
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
      this.sessionContext.cwd,
      this.bootstrap.homeDir,
      {
        additionalDirs: options?.additionalDirs ?? this.workspace.additionalDirs,
      },
    );
    this.useProfile(profile, context);
    const { agentsMdWarning } = context;
    this.agentsMdWarning = agentsMdWarning;
    if (agentsMdWarning !== undefined) {
      this.eventBus.publish({
        type: 'warning',
        message: agentsMdWarning,
        code: 'agents-md-oversized',
      });
      this.wire.signal({
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

  isRunnable(): boolean {
    return this.profileName !== undefined && this.hasModel();
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
    // Ephemeral overlay: not persisted; re-derived on resume by `userTool`.
    this.activeToolNamesOverlay = [...activeToolNames, name];
  }

  removeActiveTool(name: string): void {
    const activeToolNames = this.activeToolNames;
    if (activeToolNames === undefined || !activeToolNames.includes(name)) return;
    // Ephemeral overlay: not persisted; re-derived on resume by `userTool`.
    this.activeToolNamesOverlay = activeToolNames.filter((candidate) => candidate !== name);
  }

  private resolveConfigPayload(
    changed: Omit<ProfileUpdateData, 'activeToolNames'>,
  ): ConfigUpdatePayload {
    const payload: { -readonly [K in keyof ConfigUpdatePayload]: ConfigUpdatePayload[K] } = {};
    if (changed.cwd !== undefined) payload.cwd = changed.cwd;
    if (changed.modelAlias !== undefined) payload.modelAlias = changed.modelAlias;
    if (changed.profileName !== undefined) payload.profileName = changed.profileName;
    if (changed.thinkingLevel !== undefined) {
      payload.thinkingLevel = resolveThinkingEffort(
        changed.thinkingLevel,
        this.config.get<ThinkingConfig>(THINKING_SECTION),
      );
    }
    if (changed.systemPrompt !== undefined) payload.systemPrompt = changed.systemPrompt;
    return payload;
  }

  private afterConfigDispatch(changed: Omit<ProfileUpdateData, 'activeToolNames'>): void {
    if (changed.cwd !== undefined) {
      void this.optionsValue.chdir?.(changed.cwd);
    }
    this.emitStatusUpdated();
  }

  private setActiveTools(names: readonly string[]): void {
    // Full replace: drop the ephemeral overlay (subsequent reads fall back to the
    // Model) and persist the new base set through the wire.
    this.activeToolNamesOverlay = undefined;
    this.wire.dispatch(setActiveTools({ names: [...names] }));
  }

  private emitStatusUpdated(): void {
    const custom = this.optionsValue.emitStatusUpdated;
    if (custom !== undefined) {
      custom();
      return;
    }
    if (!this.hasModel()) return;
    this.eventBus.publish({
      type: 'agent.status.updated',
      model: this.modelAlias,
      maxContextTokens: this.getModelCapabilities().max_context_tokens,
    });
    this.wire.signal({
      type: 'agent.status.updated',
      model: this.modelAlias,
      maxContextTokens: this.getModelCapabilities().max_context_tokens,
    });
  }

  private get profileState(): ProfileModelState {
    return this.wire.getModel(ProfileModel);
  }

  private get cwd(): string {
    return this.profileState.cwd ?? this.readConfiguredCwd() ?? '';
  }

  private get model(): string {
    const modelAlias = this.modelAlias;
    if (modelAlias === undefined) {
      throw new KimiError(ErrorCodes.MODEL_NOT_CONFIGURED, 'Model not set');
    }
    return modelAlias;
  }

  private get modelAlias(): string | undefined {
    return this.profileState.modelAlias;
  }

  private get profileName(): string | undefined {
    return this.profileState.profileName;
  }

  private get systemPrompt(): string {
    return this.profileState.systemPrompt;
  }

  private get thinkingLevel(): ThinkingEffort {
    const stored = this.profileState.thinkingLevel;
    if (stored === 'off' && this.alwaysThinkingModel) {
      return resolveThinkingEffort('on', this.config.get<ThinkingConfig>(THINKING_SECTION));
    }
    return stored;
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

  private async buildSystemPromptContext(cwd?: string): Promise<SystemPromptContext> {
    const effectiveCwd = cwd ?? this.sessionContext.cwd;
    const base = await prepareSystemPromptContext(
      { fs: this.fs, homeDir: this.env.homeDir },
      effectiveCwd,
      this.bootstrap.homeDir,
      { additionalDirs: this.workspace.additionalDirs },
    );
    const skills = await this.resolveSkillListing();
    return {
      ...base,
      cwd: effectiveCwd,
      osKind: this.env.osKind,
      shellName: this.env.shellName,
      shellPath: this.env.shellPath,
      now: new Date().toISOString(),
      skills,
    };
  }

  private async resolveSkillListing(): Promise<string> {
    try {
      await this.skillCatalog.ready;
      return this.skillCatalog.catalog.getModelSkillListing();
    } catch {
      return '';
    }
  }

  private readConfiguredCwd(): string | undefined {
    const cwd = this.optionsValue.cwd;
    return typeof cwd === 'function' ? cwd() : cwd;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentProfileService,
  AgentProfileService,
  InstantiationType.Delayed,
  'profile',
);
