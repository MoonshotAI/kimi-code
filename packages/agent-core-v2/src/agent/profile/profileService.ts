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
 * / `warning` events now ride `IEventBus` (`agent.status.updated` canonical in
 * `usageOps`). `chdir` and
 * `emitStatusUpdated` run live-only after the dispatch, so `wire.replay`
 * rebuilds the Models silently; the same live-only path mirrors the resolved
 * model protocol into the ambient telemetry context (`provider_type` /
 * `protocol`) whenever the model alias changes.
 * Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { UNKNOWN_CAPABILITY, type ModelCapability } from '#/app/llmProtocol/capability';
import { type GenerationKwargs } from '#/app/llmProtocol/kimiOptions';
import { type ThinkingEffort } from '#/app/llmProtocol/thinkingEffort';
import { DEFAULT_AGENT_PROFILE_NAME, IAgentProfileCatalogService } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { type Model } from '#/app/model/modelInstance';
import { type KimiModelOverrides } from '#/app/model/modelOverrides';
import { IModelResolver } from '#/app/model/modelResolver';
import picomatch from 'picomatch';

import { ErrorCodes, Error2 } from "#/errors";
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { resolveThinkingEffort, resolveThinkingKeep } from './thinking';
import type { LoopControl } from '#/agent/loop/configSection';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { isMcpToolName, type ToolSource } from '#/tool/toolContract';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import type { ResolvedAgentProfile, SystemPromptContext } from '#/agent/profile/profile';

import type { WarningEvent } from '@moonshot-ai/protocol';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { IAgentWireService } from '#/wire/tokens';
import type { PayloadOf } from '#/wire/types';
import type { IWireService } from '#/wire/wireService';
import { IEventBus } from '#/app/event/eventBus';
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
  type ProfileModelState,
} from './profileOps';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    warning: WarningEvent;
  }
}

export class AgentProfileService implements IAgentProfileService {
  declare readonly _serviceBrand: undefined;

  private optionsValue: ProfileServiceOptions = {};
  private activeToolNamesOverlay: readonly string[] | undefined;
  private agentsMdWarning: string | undefined;

  private get activeToolNames(): ActiveToolsState {
    return (
      this.activeToolNamesOverlay ??
      (this.wire.getModel(ActiveToolsModel) as ActiveToolsState)
    );
  }

  private activeProfile: ResolvedAgentProfile | undefined;

  constructor(
    @IAgentWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentTelemetryContextService private readonly telemetryContext: IAgentTelemetryContextService,
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
    if (
      changed.profileName !== undefined &&
      this.activeProfile?.name !== changed.profileName
    ) {
      this.activeProfile = undefined;
    }
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
    const model = this.modelFactory.resolve(input.model);

    const context = await this.buildSystemPromptContext(input.cwd);
    const systemPrompt = profile.systemPrompt(context);
    this.activeProfile = profile;
    this.cacheAgentsMdWarning(context);

    const thinkingLevel = resolveThinkingEffort(
      input.thinking,
      this.config.get<ThinkingConfig>(THINKING_SECTION),
      model,
    );

    this.update({
      cwd: input.cwd,
      profileName: profile.name,
      systemPrompt,
    });
    this.setActiveTools(profile.tools);
    this.wire.dispatch(configUpdate({ modelAlias: input.model, thinkingEffort: thinkingLevel }));
    this.afterConfigDispatch({ modelAlias: input.model, thinkingLevel });

    this.publishAgentsMdWarning();
  }

  async setModel(alias: string): Promise<ProfileSetModelResult> {
    const model = this.modelFactory.resolve(alias);
    if (this.profileName === undefined) {
      await this.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: alias });
      this.telemetry.track2('model_switch', { model: alias });
    } else if (this.modelAlias !== alias) {
      this.update({ modelAlias: alias });
      this.telemetry.track2('model_switch', { model: alias });
    }
    return {
      model: alias,
      providerName: model.providerName,
    };
  }

  setThinking(level: string): void {
    const previousEffort = this.thinkingLevel;
    this.update({ thinkingLevel: level });
    const effort = this.thinkingLevel;
    if (effort !== previousEffort) {
      this.telemetry.track2('thinking_toggle', {
        enabled: effort !== 'off',
        effort,
        from: previousEffort,
      });
    }
  }

  getModel(): string {
    return this.modelAlias ?? '';
  }

  useProfile(profile: ResolvedAgentProfile, context: SystemPromptContext): void {
    this.activeProfile = profile;
    this.update({
      profileName: profile.name,
      systemPrompt: profile.systemPrompt(context),
    });
    this.setActiveTools(profile.tools);
  }

  async applyProfile(profile: ResolvedAgentProfile, options?: ApplyProfileOptions): Promise<void> {
    const context = await this.buildSystemPromptContext(undefined, options);
    this.useProfile(profile, context);
    this.cacheAgentsMdWarning(context);
    this.publishAgentsMdWarning();
  }

  async refreshSystemPrompt(): Promise<void> {
    const profile = this.resolveActiveProfile();
    if (profile === undefined) return;

    const context = await this.buildSystemPromptContext(this.cwd);
    this.activeProfile = profile;
    this.update({
      profileName: profile.name,
      systemPrompt: profile.systemPrompt(context),
    });
    this.cacheAgentsMdWarning(context);
    this.publishAgentsMdWarning();
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
      throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'Model not set');
    }
    return model;
  }

  get provider(): Model {
    return this.getProvider();
  }

  resolveModel(): Model | undefined {
    if (this.modelAlias === undefined) return undefined;
    let model: Model = this.modelFactory.resolve(this.modelAlias);
    const thinkingLevel = this.thinkingLevel;
    const thinkingConfig = this.config.get<ThinkingConfig>(THINKING_SECTION);
    const forcedKimiThinkingEffort =
      model.protocol === 'kimi' && thinkingLevel !== 'off'
        ? normalizeKimiThinkingEffort(thinkingConfig?.effort)
        : undefined;
    const kwargs: GenerationKwargs = {};
    if (model.protocol === 'kimi') {
      kwargs.prompt_cache_key = this.sessionContext.sessionId;
    } else if (model.protocol === 'anthropic') {
      model = model.withProviderOptions({
        metadata: { user_id: this.sessionContext.sessionId },
      });
    }
    const overrides = this.config.get<KimiModelOverrides>('modelOverrides');
    if (overrides !== undefined) {
      if (overrides.temperature !== undefined) kwargs.temperature = overrides.temperature;
      if (overrides.topP !== undefined) kwargs.top_p = overrides.topP;
    }
    const keep = resolveThinkingKeep(
      overrides?.thinkingKeep,
      thinkingConfig?.keep,
      thinkingLevel,
    );
    if (keep !== undefined) {
      if (model.protocol === 'kimi' && forcedKimiThinkingEffort === undefined) {
        kwargs.extra_body = { thinking: { keep } };
      } else if (model.protocol === 'anthropic') {
        model = model.withThinkingKeep(keep);
      }
    }
    if (Object.keys(kwargs).length > 0) model = model.withGenerationKwargs(kwargs);
    model = model.withThinking(forcedKimiThinkingEffort ?? thinkingLevel);
    if (forcedKimiThinkingEffort !== undefined) {
      const thinking: { type: 'enabled'; effort: string; keep?: string } = {
        type: 'enabled',
        effort: forcedKimiThinkingEffort,
      };
      if (keep !== undefined) thinking.keep = keep;
      model = model.withGenerationKwargs({ extra_body: { thinking } });
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
    this.activeToolNamesOverlay = [...activeToolNames, name];
  }

  removeActiveTool(name: string): void {
    const activeToolNames = this.activeToolNames;
    if (activeToolNames === undefined || !activeToolNames.includes(name)) return;
    this.activeToolNamesOverlay = activeToolNames.filter((candidate) => candidate !== name);
  }

  private resolveConfigPayload(
    changed: Omit<ProfileUpdateData, 'activeToolNames'>,
  ): PayloadOf<typeof configUpdate> {
    const payload: {
      -readonly [K in keyof PayloadOf<typeof configUpdate>]: PayloadOf<typeof configUpdate>[K];
    } = {};
    if (changed.cwd !== undefined) payload.cwd = changed.cwd;
    if (changed.modelAlias !== undefined) payload.modelAlias = changed.modelAlias;
    if (changed.profileName !== undefined) payload.profileName = changed.profileName;
    if (changed.thinkingLevel !== undefined) {
      const model = this.resolveModelForThinking(changed.modelAlias);
      payload.thinkingEffort = resolveThinkingEffort(
        changed.thinkingLevel,
        this.config.get<ThinkingConfig>(THINKING_SECTION),
        model,
      );
    }
    if (changed.systemPrompt !== undefined) payload.systemPrompt = changed.systemPrompt;
    return payload;
  }

  private afterConfigDispatch(changed: Omit<ProfileUpdateData, 'activeToolNames'>): void {
    if (changed.cwd !== undefined) {
      void this.optionsValue.chdir?.(changed.cwd);
    }
    if (changed.modelAlias !== undefined) {
      const protocol = this.tryResolveRawModel()?.protocol;
      this.telemetryContext.set({ provider_type: protocol, protocol });
    }
    this.emitStatusUpdated();
  }

  private setActiveTools(names: readonly string[]): void {
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
      throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'Model not set');
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
      return resolveThinkingEffort(
        stored,
        this.config.get<ThinkingConfig>(THINKING_SECTION),
        this.tryResolveRawModel(),
      );
    }
    return stored;
  }

  private get alwaysThinkingModel(): boolean {
    return this.tryResolveRawModel()?.alwaysThinking === true;
  }

  private tryResolveRawModel(): Model | undefined {
    const alias = this.modelAlias;
    return this.resolveModelForThinking(alias);
  }

  private resolveModelForThinking(alias: string | undefined): Model | undefined {
    if (alias === undefined) return undefined;
    try {
      return this.modelFactory.resolve(alias);
    } catch {
      return undefined;
    }
  }

  private resolveActiveProfile(): ResolvedAgentProfile | undefined {
    if (this.activeProfile !== undefined) return this.activeProfile;
    const profileName = this.profileName;
    if (profileName === undefined) return undefined;
    return this.catalog.get(profileName);
  }

  private cacheAgentsMdWarning(context: Pick<SystemPromptContext, 'agentsMdWarning'>): void {
    this.agentsMdWarning = context.agentsMdWarning;
  }

  private publishAgentsMdWarning(): void {
    const warning = this.agentsMdWarning;
    if (warning === undefined) return;
    this.eventBus.publish({
      type: 'warning',
      message: warning,
      code: 'agents-md-oversized',
    });
  }

  private async buildSystemPromptContext(
    cwd?: string,
    options?: ApplyProfileOptions,
  ): Promise<SystemPromptContext> {
    const effectiveCwd = cwd ?? this.sessionContext.cwd;
    const base = await prepareSystemPromptContext(
      { fs: this.fs, homeDir: this.env.homeDir },
      effectiveCwd,
      this.bootstrap.homeDir,
      { additionalDirs: options?.additionalDirs ?? this.workspace.additionalDirs },
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

function normalizeKimiThinkingEffort(raw: string | undefined): ThinkingEffort | undefined {
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentProfileService,
  AgentProfileService,
  InstantiationType.Delayed,
  'profile',
);
