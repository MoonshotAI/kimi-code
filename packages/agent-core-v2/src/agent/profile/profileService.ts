/**
 * `profile` domain (L4) — `IAgentProfileService` implementation.
 *
 * Owns the active agent's model alias, thinking level, system prompt, and
 * active-tool set; resolves the runnable god-object Model through the App-
 * scope `IModelResolver`, persists the persistent config slice (`cwd` /
 * `modelAlias` / `profileName` / resolved base `thinkingLevel` /
 * `systemPrompt` / profile `disallowedTools`) in the `wire` `ProfileModel`
 * through the `config.update` Op
 * and the persisted active-tool set in the `wire` `ActiveToolsModel` through the
 * `tools.set_active_tools` Op (`wire.dispatch`), and reads both through
 * `wire.getModel`. The effective active-tool set read by consumers is the
 * persisted base (`ActiveToolsModel`, rebuilt by `wire.replay`) overlaid with
 * the ephemeral per-tool deltas from `addActiveTool` / `removeActiveTool`
 * (used by `userTool`; intentionally not persisted, re-derived on resume); the
 * live overlay is cached in a field and falls back to the Model when unset, so
 * no restore-ordering coupling with `userTool` arises. Profile and client
 * policy are persisted independently. The `agent.status.updated`
 * / `warning` events now ride `IEventBus` (`agent.status.updated` canonical in
 * `usageOps`). `chdir` and
 * `emitStatusUpdated` run live-only after the dispatch, so `wire.replay`
 * rebuilds the Models silently; the same live-only path mirrors the resolved
 * model protocol into the ambient telemetry context (`provider_type` /
 * `protocol`) whenever the model alias changes.
 * Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { UNKNOWN_CAPABILITY, type ModelCapability } from '#/app/llmProtocol/capability';
import { type GenerationKwargs } from '#/app/llmProtocol/kimiOptions';
import { type ThinkingEffort } from '#/app/llmProtocol/thinkingEffort';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { type Model } from '#/app/model/modelInstance';
import { type KimiModelOverrides } from '#/app/model/modelOverrides';
import { IModelResolver } from '#/app/model/modelResolver';
import {
  normalizeRequestedThinkingEffort,
  resolveKimiThinkingEffortOverride,
} from '#/app/model/thinking';
import { ErrorCodes, Error2 } from "#/errors";
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { resolveThinkingEffort, resolveThinkingKeep, supportsThinkingEffort } from './thinking';
import type { LoopControl } from '#/agent/loop/configSection';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ToolSource } from '#/tool/toolContract';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import type { ResolvedAgentProfile, SystemPromptContext } from '#/agent/profile/profile';

import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { IWireService } from '#/wire/wire';
import type { PayloadOf } from '#/wire/types';
import { IEventBus } from '#/app/event/eventBus';
import { prepareSystemPromptContext } from './context';
import type {
  ApplyProfileOptions,
  BindAgentInput,
  ProfileBindingSnapshot,
  ProfileData,
  ProfileModelContext,
  ProfileServiceOptions,
  ProfileSetModelResult,
  ProfileUpdateData,
} from './profile';
import { IAgentProfileService, ProfileError, ProfileErrors } from './profile';
import {
  THINKING_SECTION,
  TOOLS_SECTION,
  type ThinkingConfig,
  type ToolsConfig,
} from './configSection';
import { isToolActive as evaluateToolActive } from '#/agent/toolPolicy/evaluate';
import {
  ActiveToolsModel,
  configUpdate,
  ProfileModel,
  setActiveTools,
  resetActiveTools,
  type ActiveToolsState,
  type ProfileModelState,
} from './profileOps';

export interface WarningEvent {
  readonly type: 'warning';
  readonly message: string;
  readonly code?: string;
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    warning: WarningEvent;
  }
}

export class AgentProfileService extends Disposable implements IAgentProfileService {
  declare readonly _serviceBrand: undefined;

  private optionsValue: ProfileServiceOptions = {};
  private activeToolNamesOverlay: readonly string[] | undefined;
  private agentsMdWarning: string | undefined;
  private readonly emittedThinkingEffortWarnings = new Set<string>();

  private get activeToolNames(): ActiveToolsState {
    return (
      this.activeToolNamesOverlay ??
      (this.wire.getModel(ActiveToolsModel) as ActiveToolsState)
    );
  }

  private activeProfile: ResolvedAgentProfile | undefined;

  constructor(
    @IWireService private readonly wire: IWireService,
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
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @ISessionToolPolicy private readonly sessionToolPolicy: ISessionToolPolicy,
  ) {
    super();
    this.configure({});
    this._register(
      this.sessionToolPolicy.onDidChange((event) => {
        event.waitUntil(this.refreshSystemPrompt());
      }),
    );
    this._register(
      this.config.onDidSectionChange(({ domain }) => {
        if (domain === TOOLS_SECTION) void this.refreshSystemPrompt();
      }),
    );
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

  applyBindingSnapshot(snapshot: ProfileBindingSnapshot): void {
    this.activeProfile = undefined;
    this.wire.dispatch(
      configUpdate(
        this.resolveConfigPayload({
          cwd: snapshot.cwd,
          modelAlias: snapshot.modelAlias,
          profileName: snapshot.profileName,
          thinkingLevel: snapshot.thinkingLevel,
          systemPrompt: snapshot.systemPrompt,
          disallowedTools: snapshot.disallowedTools ?? [],
        }),
      ),
    );
    this.afterConfigDispatch({
      cwd: snapshot.cwd,
      modelAlias: snapshot.modelAlias,
      profileName: snapshot.profileName,
      thinkingLevel: snapshot.thinkingLevel,
      systemPrompt: snapshot.systemPrompt,
      disallowedTools: snapshot.disallowedTools ?? [],
    });
    this.setActiveTools(snapshot.activeToolNames);
  }

  async bind(input: BindAgentInput): Promise<void> {
    await this.catalog.ready;
    // A profile is the session's identity: first-bind only. The guard runs
    // twice — here, before name resolution, so `already bound` wins over
    // `unknown profile` and the common case fails fast; and again in the
    // synchronous segment after every await and before the first
    // wire.dispatch, so check-and-set is atomic and concurrent binds cannot
    // both pass (an edge-level guard always leaves an interleaving window).
    this.assertBindable(input.profile);
    const profile = this.catalog.get(input.profile);
    if (profile === undefined) {
      const available = this.catalog
        .list()
        .map((p) => p.name)
        .join(', ');
      throw new ProfileError(
        ProfileErrors.codes.PROFILE_UNKNOWN,
        `Unknown agent profile: "${input.profile}". Available profiles: ${available}`,
        { profile: input.profile, available },
      );
    }
    const alias = input.model ?? this.config.get<string>('defaultModel');
    if (alias === undefined || alias === '') {
      throw new ProfileError(
        ProfileErrors.codes.MODEL_NOT_CONFIGURED,
        `model is required to bind profile "${input.profile}" (no default model configured)`,
      );
    }
    const model = this.modelFactory.resolve(alias);

    // An explicitly user-requested thinking effort (strictThinking) must be
    // supported by the model: reject before any await or state mutation so a
    // bad edge request cannot wedge the session's identity after first-bind.
    // Inherited thinking (subagent spawn, fork) deliberately skips this and
    // clamps below instead — a persisted effort that drifted out of the
    // model's support list must not break spawning.
    if (input.strictThinking === true && input.thinking !== undefined) {
      this.assertThinkingEffortSupported(input.thinking, model, alias);
    }

    await this.sessionToolPolicy.ready;
    const context = await this.buildSystemPromptContext(profile, input.cwd);
    this.assertBindable(profile.name);
    const currentProfileName = this.profileName;
    const systemPrompt = profile.systemPrompt(context);
    this.activeProfile = profile;
    this.cacheAgentsMdWarning(context);

    // A same-name rebind keeps the persisted thinking effort unless the caller
    // explicitly overrides it; only a first bind resolves the default.
    const thinkingLevel = resolveThinkingEffort(
      input.thinking ?? (currentProfileName !== undefined ? this.thinkingLevel : undefined),
      this.config.get<ThinkingConfig>(THINKING_SECTION),
      model,
    );

    this.update({
      cwd: input.cwd,
      profileName: profile.name,
      systemPrompt,
      disallowedTools: profile.disallowedTools ?? [],
    });
    this.setActiveTools(profile.tools);
    this.wire.dispatch(configUpdate({ modelAlias: alias, thinkingEffort: thinkingLevel }));
    this.afterConfigDispatch({ modelAlias: alias, thinkingLevel });

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
    this.assertThinkingEffortSupported(level, this.tryResolveRawModel(), this.modelAlias ?? '');
    const normalized = normalizeRequestedThinkingEffort(level);
    this.update({ thinkingLevel: normalized ?? level });
    const effort = this.thinkingLevel;
    if (effort !== previousEffort) {
      this.telemetry.track2('thinking_toggle', {
        enabled: effort !== 'off',
        effort,
        from: previousEffort,
      });
    }
  }

  private assertThinkingEffortSupported(
    requested: string,
    model: Model | undefined,
    modelAlias: string,
  ): void {
    const normalized = normalizeRequestedThinkingEffort(requested);
    if (normalized === undefined || supportsThinkingEffort(normalized, model)) return;
    const efforts = model?.supportEfforts ?? [];
    const supported = efforts.length === 0 ? 'off' : ['off', ...efforts].join(', ');
    throw new ProfileError(
      ProfileErrors.codes.MODEL_CONFIG_INVALID,
      `Thinking effort "${requested}" is not supported by model "${modelAlias}". Supported efforts: ${supported}.`,
    );
  }

  getModel(): string {
    return this.modelAlias ?? '';
  }

  useProfile(profile: ResolvedAgentProfile, context: SystemPromptContext): void {
    this.activeProfile = profile;
    this.update({
      profileName: profile.name,
      systemPrompt: profile.systemPrompt(context),
      disallowedTools: profile.disallowedTools ?? [],
    });
    this.setActiveTools(profile.tools);
  }

  async applyProfile(profile: ResolvedAgentProfile, options?: ApplyProfileOptions): Promise<void> {
    const context = await this.buildSystemPromptContext(profile, undefined, options);
    this.useProfile(profile, context);
    this.cacheAgentsMdWarning(context);
    this.publishAgentsMdWarning();
  }

  async refreshSystemPrompt(): Promise<void> {
    const profile = this.resolveActiveProfile();
    if (profile === undefined) return;

    const context = await this.buildSystemPromptContext(profile, this.cwd);
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
      disallowedTools: [...(this.profileState.disallowedTools ?? [])],
    };
  }

  getEffectiveThinkingLevel(): ThinkingEffort {
    return this.resolveThinkingState(this.tryResolveRawModel()).effective;
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
      thinkingLevel: this.resolveThinkingState(model).effective,
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
    const thinking = this.resolveThinkingState(model);
    const thinkingConfig = this.config.get<ThinkingConfig>(THINKING_SECTION);
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
      thinking.effective,
    );
    if (keep !== undefined) {
      if (model.protocol === 'kimi' && thinking.forced === undefined) {
        kwargs.extra_body = { thinking: { keep } };
      } else if (model.protocol === 'anthropic') {
        model = model.withThinkingKeep(keep);
      }
    }
    if (Object.keys(kwargs).length > 0) model = model.withGenerationKwargs(kwargs);
    model = model.withThinking(thinking.effective);
    if (model.protocol === 'kimi' && thinking.forced !== undefined) {
      const requestThinking: { type: 'enabled'; effort: string; keep?: string } = {
        type: 'enabled',
        effort: thinking.forced,
      };
      if (keep !== undefined) requestThinking.keep = keep;
      model = model.withGenerationKwargs({ extra_body: { thinking: requestThinking } });
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
    if (changed.thinkingLevel !== undefined || changed.modelAlias !== undefined) {
      const model = this.resolveModelForThinking(changed.modelAlias ?? this.modelAlias);
      const requested =
        changed.thinkingLevel ?? (this.modelAlias === undefined ? undefined : this.thinkingLevel);
      payload.thinkingEffort = resolveThinkingEffort(
        requested,
        this.config.get<ThinkingConfig>(THINKING_SECTION),
        model,
      );
    }
    if (changed.systemPrompt !== undefined) payload.systemPrompt = changed.systemPrompt;
    if (changed.disallowedTools !== undefined) {
      payload.disallowedTools = [...changed.disallowedTools];
    }
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
    if (changed.modelAlias !== undefined || changed.thinkingLevel !== undefined) {
      this.warnAboutAnthropicThinkingEffort();
    }
    this.emitStatusUpdated(
      changed.modelAlias !== undefined || changed.thinkingLevel !== undefined,
    );
  }

  private warnAboutAnthropicThinkingEffort(): void {
    try {
      const model = this.tryResolveRawModel();
      if (model?.protocol !== 'anthropic') return;
      const effort = this.getEffectiveThinkingLevel();
      if (effort === 'on') return;

      let code: string;
      let message: string;
      let knownEfforts = '';
      if (effort === 'off') {
        if (!model.alwaysThinking) return;
        code = 'anthropic-thinking-cannot-disable';
        message = `Model "${model.name}" declares always-on thinking. The configured effort "off" will be sent unchanged to the Anthropic-compatible backend.`;
      } else {
        const efforts = model.supportEfforts?.filter((value) => value.length > 0);
        if (efforts === undefined || efforts.length === 0 || efforts.includes(effort)) return;
        knownEfforts = efforts.join(',');
        code = 'anthropic-thinking-effort-not-listed';
        message = `Thinking effort "${effort}" is not listed for model "${model.name}" (known: ${efforts.join(', ')}). The configured value will be sent unchanged to the Anthropic-compatible backend.`;
      }

      const key = [code, model.id, model.name, effort, knownEfforts].join('\u0000');
      if (this.emittedThinkingEffortWarnings.has(key)) return;
      this.emittedThinkingEffortWarnings.add(key);
      this.eventBus.publish({ type: 'warning', code, message });
    } catch {
    }
  }

  private setActiveTools(names: readonly string[] | undefined): void {
    this.activeToolNamesOverlay = undefined;
    if (names === undefined) {
      this.wire.dispatch(resetActiveTools({}));
      return;
    }
    this.wire.dispatch(setActiveTools({ names: [...names] }));
  }

  private emitStatusUpdated(includeThinkingEffort = false): void {
    const custom = this.optionsValue.emitStatusUpdated;
    if (custom !== undefined) {
      custom();
      return;
    }
    if (!this.hasModel()) return;
    this.eventBus.publish({
      type: 'agent.status.updated',
      model: this.modelAlias,
      thinkingEffort: includeThinkingEffort
        ? this.getEffectiveThinkingLevel()
        : undefined,
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

  private resolveThinkingState(model: Model | undefined): {
    readonly effective: ThinkingEffort;
    readonly forced: ThinkingEffort | undefined;
  } {
    const base = this.thinkingLevel;
    const forced = resolveKimiThinkingEffortOverride(
      this.config.get<ThinkingConfig>(THINKING_SECTION)?.forcedEffort,
      base,
      model?.providerType === 'kimi',
    );
    return { effective: forced ?? base, forced };
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

  private assertBindable(requested: string): void {
    const current = this.profileName;
    if (current !== undefined && current !== requested) {
      throw new ProfileError(
        ProfileErrors.codes.PROFILE_ALREADY_BOUND,
        `agent is already bound to profile "${current}"; cannot switch to "${requested}" in this session`,
        { current, requested },
      );
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
    profile: ResolvedAgentProfile,
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
      skillActive: this.isToolActiveForProfile(profile, 'Skill'),
    };
  }

  private isToolActiveForProfile(
    profile: ResolvedAgentProfile,
    name: string,
    source: ToolSource = 'builtin',
  ): boolean {
    const globalTools = this.config.get<ToolsConfig>(TOOLS_SECTION);
    return (
      evaluateToolActive(profile, name, source) &&
      evaluateToolActive(
        {
          tools: globalTools?.enabled?.length ? globalTools.enabled : undefined,
          disallowedTools: globalTools?.disabled,
        },
        name,
        source,
      ) &&
      evaluateToolActive(
        { disallowedTools: this.sessionToolPolicy.disabledTools() },
        name,
        source,
      )
    );
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
  InstantiationType.Eager,
  'profile',
);
