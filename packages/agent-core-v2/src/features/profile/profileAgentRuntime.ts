import { assign, fromCallback, setup, type Snapshot } from 'xstate';

import { TOOLS_SECTION } from '#/agent/toolPolicy/configSection';
import { ISessionAgentsMdReminderService } from '#/agent/agentsMdReminder/sessionAgentsMdReminder';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/agent/runtime/agentRuntime';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { THINKING_SECTION } from '#/app/kosongConfig/configSection';
import { IPluginService } from '#/app/plugin/plugin';
import { ErrorCodes, Error2 } from '#/errors';
import { ProfileError, ProfileErrors } from '#/features/profile/errors';
import {
  anthropicThinkingEffortWarning,
  assertThinkingEffortSupported,
  resolveThinkingEffort,
  resolveThinkingState,
  type ThinkingDeps,
} from '#/features/profile/internal/thinking';
import {
  buildSystemPromptContext,
  type SystemPromptCaches,
  type SystemPromptContextDeps,
} from '#/features/profile/internal/systemPrompt';
import { publishToolPatternWarnings } from '#/features/profile/internal/toolPatternWarnings';
import type {
  ApplyProfileOptions,
  BindAgentInput,
  ProfileData,
  ProfileModelContext,
  ProfileSetModelResult,
  ProfileStatus,
  ProfileUpdateData,
  ResolvedAgentProfile,
  SystemPromptContext,
} from '#/features/profile/profile';
import { extractAgentsMdPathsFromSystemPrompt } from '#/features/profile/profileContext';
import {
  ConfigUpdate,
  foldConfigUpdate,
  foldProfileBind,
  foldToolsResetActiveTools,
  foldToolsSetActiveTools,
  INITIAL_PROFILE_STATE,
  ProfileBind,
  ToolsResetActiveTools,
  ToolsSetActiveTools,
  WarningIssued,
  type ActiveToolsState,
  type ConfigUpdatePayload,
  type ProfileState,
} from '#/features/profile/profileOps';
import { UNKNOWN_CAPABILITY, type ModelCapability } from '#/kosong/contract/capability';
import type { SamplingOptions, ThinkingEffort } from '#/kosong/contract/provider';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import type { ModelOverrides } from '#/kosong/model/model.types';
import type { ModelRequestParams } from '#/kosong/model/modelRequester';
import {
  normalizeRequestedThinkingEffort,
  resolveThinkingKeep,
  type ThinkingConfig,
} from '#/kosong/model/thinking';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import type { LoopControl } from '#/features/loop/configSection';
import { IHostClock } from '#/os/interface/hostClock';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IAgentHostService, type AgentHost } from '#/agent/host/agentHost';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';

interface ProfileActorContext {
  readonly runtime: AgentRuntimeContext<ProfileState>;
  ledger: ProfileState;
  activeToolNamesOverlay: ActiveToolsState;
  agentsMdWarning: string | undefined;
  readonly emittedThinkingEffortWarnings: Set<string>;
  readonly emittedToolPatternWarnings: Set<string>;
  readonly emittedPluginBudgetWarnings: Set<string>;
  frozenSkillListing: string | undefined;
  frozenPluginSections: string | undefined;
}

interface ProfileCommitEvent {
  readonly type: 'profile.commit';
  readonly ledger: ProfileState;
}

interface ProfilePatchEvent {
  readonly type: 'profile.patch';
  readonly patch: Partial<
    Pick<
      ProfileActorContext,
      'activeToolNamesOverlay' | 'agentsMdWarning' | 'frozenSkillListing' | 'frozenPluginSections'
    >
  >;
}

type ProfileActorSnapshot = Snapshot<unknown> & {
  readonly context: ProfileActorContext;
};

const profileToolPatternWatcher = fromCallback(
  ({ input }: { input: AgentRuntimeContext<ProfileState> }) => {
    const config = input.get(IConfigService);
    const subscription = config.onDidSectionChange(({ domain }) => {
      if (domain !== TOOLS_SECTION) return;
      publishToolPatternWarnings(
        {
          config,
          toolReferences: [],
          builtinProfiles: input.get(IBuiltinAgentProfileLoader),
        },
        input.getLogicState<ProfileActorContext>().emittedToolPatternWarnings,
        undefined,
        (message, code) => {
          void input.dispatch(new WarningIssued({ agentId: input.agent.agentId, message, code }));
        },
      );
    });
    return () => {
      subscription.dispose();
    };
  },
);

const profileActorLogic = setup({
  types: {} as {
    context: ProfileActorContext;
    input: AgentRuntimeContext<ProfileState>;
    events: ProfileCommitEvent | ProfilePatchEvent | AgentRuntimeRestoreEvent;
  },
  actors: { profileToolPatternWatcher },
}).createMachine({
  context: ({ input }) => ({
    runtime: input,
    ledger: INITIAL_PROFILE_STATE,
    activeToolNamesOverlay: undefined,
    agentsMdWarning: undefined,
    emittedThinkingEffortWarnings: new Set(),
    emittedToolPatternWarnings: new Set(),
    emittedPluginBudgetWarnings: new Set(),
    frozenSkillListing: undefined,
    frozenPluginSections: undefined,
  }),
  initial: 'beforeRestore',
  states: {
    beforeRestore: {
      on: { 'runtime.restore': 'active' },
    },
    active: {
      invoke: {
        src: 'profileToolPatternWatcher',
        input: ({ context }) => context.runtime,
      },
    },
  },
  on: {
    'profile.commit': {
      actions: assign({ ledger: ({ event }) => event.ledger }),
    },
    'profile.patch': {
      actions: assign(({ context, event }) => ({ ...context, ...event.patch })),
    },
  },
});

export class ProfileRuntime {
  constructor(private readonly context: AgentRuntimeContext<ProfileState>) {}

  private get host(): AgentHost {
    return this.context.get(IAgentHostService).of(this.context.agent);
  }

  data(): ProfileData {
    const model = this.tryResolveRawModel();
    const activeToolNames = this.activeTools();
    const profile = this.profileState();
    return {
      modelAlias: this.currentModelAlias(),
      modelCapabilities: model?.capabilities ?? UNKNOWN_CAPABILITY,
      profileName: this.currentProfileName(),
      thinkingLevel: this.storedThinkingLevel(),
      systemPrompt: this.systemPrompt(),
      agentsMdPaths: profile.agentsMdPaths,
      activeToolNames: activeToolNames === undefined ? undefined : [...activeToolNames],
      disallowedTools: [...(profile.disallowedTools ?? [])],
      subagents: profile.subagents === undefined ? undefined : [...profile.subagents],
      environmentDisclosure: profile.environmentDisclosure,
      renderGeneration: profile.renderGeneration,
    };
  }

  model(): string {
    return this.currentModelAlias() ?? '';
  }

  systemPrompt(): string {
    return this.profileState().systemPrompt;
  }

  activeTools(): readonly string[] | undefined {
    return this.logicState().activeToolNamesOverlay ?? this.context.getState().activeTools;
  }

  requestParams(): ModelRequestParams {
    const model = this.tryResolveRawModel();
    const thinking = this.thinkingState(model);
    const config = this.context.get(IConfigService);
    const thinkingConfig = config.get<ThinkingConfig>(THINKING_SECTION);
    const overrides = config.get<ModelOverrides>('modelOverrides');
    const sampling: SamplingOptions = {
      temperature: overrides?.temperature,
      topP: overrides?.topP,
    };
    return {
      cacheKey: this.context.get(ISessionContext).sessionId,
      sampling:
        sampling.temperature === undefined && sampling.topP === undefined ? undefined : sampling,
      thinkingEffort: thinking.effective,
      thinkingKeep: resolveThinkingKeep(
        overrides?.thinkingKeep,
        thinkingConfig?.keep,
        thinking.effective,
      ),
    };
  }

  modelCapabilities(): ModelCapability {
    return this.tryResolveRawModel()?.capabilities ?? UNKNOWN_CAPABILITY;
  }

  maxOutputSize(): number | undefined {
    return this.tryResolveRawModel()?.maxOutputSize;
  }

  modelContext(): ProfileModelContext {
    const modelAlias = this.requireModelAlias();
    const model = this.context.get(IModelCatalog).get(modelAlias);
    const loopControl = this.context.get(IConfigService).get<LoopControl>('loopControl');
    return {
      modelAlias,
      modelCapabilities: model.capabilities,
      maxOutputSize: model.maxOutputSize,
      alwaysThinking: model.alwaysThinking || undefined,
      thinkingLevel: this.thinkingState(model).effective,
      reservedContextSize: loopControl?.reservedContextSize,
      compactionTriggerRatio: loopControl?.compactionTriggerRatio,
    };
  }

  effectiveThinkingLevel(): ThinkingEffort {
    return this.thinkingState(this.tryResolveRawModel()).effective;
  }

  agentsMdWarning(): string | undefined {
    return this.logicState().agentsMdWarning;
  }

  hasProvider(): boolean {
    return this.tryResolveRawModel() !== undefined;
  }

  status(): ProfileStatus {
    return this.currentProfileName() !== undefined && this.currentModelAlias() !== undefined
      ? 'ready'
      : 'unbound';
  }

  async bind(input: BindAgentInput): Promise<void> {
    const catalog = this.context.get(ISessionAgentProfileCatalog);
    const config = this.context.get(IConfigService);
    await catalog.ready;
    await this.context.get(IAgentIdentity).resolved();
    this.assertBindable(input.profile);
    const profile = catalog.get(input.profile);
    if (profile === undefined) {
      const available = catalog
        .list()
        .map((candidate) => candidate.name)
        .join(', ');
      throw new ProfileError(
        ProfileErrors.codes.PROFILE_UNKNOWN,
        `Unknown agent profile: "${input.profile}". Available profiles: ${available}`,
        { profile: input.profile, available },
      );
    }
    const alias = input.model ?? config.get<string>('defaultModel');
    if (alias === undefined || alias === '') {
      throw new ProfileError(
        ProfileErrors.codes.MODEL_NOT_CONFIGURED,
        `model is required to bind profile "${input.profile}" (no default model configured)`,
      );
    }
    const model = this.context.get(IModelCatalog).get(alias);
    if (input.strictThinking === true && input.thinking !== undefined) {
      assertThinkingEffortSupported(this.thinkingDeps(), input.thinking, model, alias);
    }
    await this.context.get(ISessionToolPolicy).ready;
    const context = await this.buildContext(profile, undefined);
    this.assertBindable(profile.name);
    const currentProfileName = this.currentProfileName();
    const rendered = profile.renderSystemPrompt(context);
    this.cacheAgentsMdWarning(context);
    const thinkingLevel = resolveThinkingEffort(
      this.thinkingDeps(),
      input.thinking ?? (currentProfileName !== undefined ? this.storedThinkingLevel() : undefined),
      model,
    );
    this.patch({ activeToolNamesOverlay: undefined });
    await this.context.dispatch(
      new ProfileBind({
        agentId: this.context.agent.agentId,
        modelAlias: alias,
        profileName: profile.name,
        thinkingEffort: thinkingLevel,
        systemPrompt: rendered.text,
        environmentDisclosure: rendered.environment,
        agentsMdPaths: context.agentsMdPaths ?? [],
        activeToolNames: profile.tools,
        disallowedTools: profile.disallowedTools ?? [],
        subagents: profile.subagents,
      }),
    );
    this.afterConfigDispatch({
      modelAlias: alias,
      profileName: profile.name,
      thinkingLevel,
      systemPrompt: rendered.text,
      disallowedTools: profile.disallowedTools ?? [],
    });
    this.seedAgentsMdReminder(context);
    this.publishAgentsMdWarning();
    this.publishPatterns(profile);
  }

  async apply(profile: ResolvedAgentProfile, options?: ApplyProfileOptions): Promise<void> {
    const context = await this.buildContext(profile, options);
    this.useProfile(profile, context);
    this.seedAgentsMdReminder(context);
    this.cacheAgentsMdWarning(context);
    this.publishAgentsMdWarning();
    this.publishPatterns(profile);
  }

  update(changed: ProfileUpdateData): void {
    const { activeToolNames, ...configChanged } = changed;
    if (Object.keys(configChanged).length > 0) {
      void this.context.dispatch(new ConfigUpdate(this.resolveConfigPayload(configChanged)));
      this.afterConfigDispatch(configChanged);
    }
    if (activeToolNames !== undefined) {
      this.setActiveTools(activeToolNames);
    }
  }

  applyData(data: ProfileData): void {
    this.patch({ activeToolNamesOverlay: undefined });
    const agentsMdPaths =
      data.agentsMdPaths ?? extractAgentsMdPathsFromSystemPrompt(data.systemPrompt);
    void this.context.dispatch(
      new ProfileBind({
        agentId: this.context.agent.agentId,
        modelAlias: data.modelAlias,
        profileName: data.profileName,
        thinkingEffort: data.thinkingLevel,
        systemPrompt: data.systemPrompt,
        environmentDisclosure: data.environmentDisclosure,
        renderGeneration: data.renderGeneration,
        agentsMdPaths,
        activeToolNames: data.activeToolNames,
        disallowedTools: data.disallowedTools ?? [],
        subagents: data.subagents,
      }),
    );
    this.afterConfigDispatch({
      modelAlias: data.modelAlias,
      profileName: data.profileName,
      thinkingLevel: data.thinkingLevel,
      systemPrompt: data.systemPrompt,
      environmentDisclosure: data.environmentDisclosure,
      agentsMdPaths,
      disallowedTools: data.disallowedTools ?? [],
    });
    this.context
      .get(ISessionAgentsMdReminderService)
      .of(this.context.agent)
      .seedInjected(agentsMdPaths, this.context.get(ISessionContext).cwd);
  }

  async setModel(alias: string): Promise<ProfileSetModelResult> {
    const model = this.context.get(IModelCatalog).get(alias);
    if (this.currentProfileName() === undefined) {
      await this.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: alias });
      this.host.telemetry.track2('model_switch', { model: alias });
    } else if (this.currentModelAlias() !== alias) {
      this.update({ modelAlias: alias });
      this.host.telemetry.track2('model_switch', { model: alias });
    }
    return {
      model: alias,
      providerName: model.providerName,
    };
  }

  setThinking(level: string): void {
    const previousEffort = this.storedThinkingLevel();
    assertThinkingEffortSupported(
      this.thinkingDeps(),
      level,
      this.tryResolveRawModel(),
      this.currentModelAlias() ?? '',
    );
    const normalized = normalizeRequestedThinkingEffort(level);
    this.update({ thinkingLevel: normalized ?? level });
    const effort = this.storedThinkingLevel();
    if (effort !== previousEffort) {
      this.host.telemetry.track2('thinking_toggle', {
        enabled: effort !== 'off',
        effort,
        from: previousEffort,
      });
    }
  }

  addActiveTool(name: string): void {
    const activeToolNames = this.activeTools();
    if (activeToolNames === undefined || activeToolNames.includes(name)) return;
    this.patch({ activeToolNamesOverlay: [...activeToolNames, name] });
  }

  removeActiveTool(name: string): void {
    const activeToolNames = this.activeTools();
    if (activeToolNames === undefined || !activeToolNames.includes(name)) return;
    this.patch({
      activeToolNamesOverlay: activeToolNames.filter((candidate) => candidate !== name),
    });
  }

  republishStatus(): void {
    this.emitStatusUpdated(true);
  }

  useProfile(profile: ResolvedAgentProfile, context: SystemPromptContext): void {
    const rendered = profile.renderSystemPrompt(context);
    this.update({
      profileName: profile.name,
      systemPrompt: rendered.text,
      environmentDisclosure: rendered.environment,
      agentsMdPaths: context.agentsMdPaths ?? [],
      disallowedTools: profile.disallowedTools ?? [],
    });
    this.setActiveTools(profile.tools);
  }

  private setActiveTools(names: readonly string[] | undefined): void {
    this.patch({ activeToolNamesOverlay: undefined });
    if (names === undefined) {
      void this.context.dispatch(
        new ToolsResetActiveTools({ agentId: this.context.agent.agentId }),
      );
      return;
    }
    void this.context.dispatch(
      new ToolsSetActiveTools({ agentId: this.context.agent.agentId, names: [...names] }),
    );
  }

  private resolveConfigPayload(
    changed: Omit<ProfileUpdateData, 'activeToolNames'>,
  ): ConfigUpdatePayload {
    const payload: ConfigUpdatePayload = { agentId: this.context.agent.agentId };
    if (changed.modelAlias !== undefined) payload.modelAlias = changed.modelAlias;
    if (changed.profileName !== undefined) payload.profileName = changed.profileName;
    if (changed.thinkingLevel !== undefined || changed.modelAlias !== undefined) {
      const model = this.resolveModelForThinking(changed.modelAlias ?? this.currentModelAlias());
      const requested =
        changed.thinkingLevel ??
        (this.currentModelAlias() === undefined ? undefined : this.storedThinkingLevel());
      payload.thinkingEffort = resolveThinkingEffort(this.thinkingDeps(), requested, model);
    }
    if (changed.systemPrompt !== undefined) {
      payload.systemPrompt = changed.systemPrompt;
      if (changed.environmentDisclosure !== undefined) {
        payload.environmentDisclosure = changed.environmentDisclosure;
      }
    }
    if (changed.agentsMdPaths !== undefined) {
      payload.agentsMdPaths = [...changed.agentsMdPaths];
    }
    if (changed.disallowedTools !== undefined) {
      payload.disallowedTools = [...changed.disallowedTools];
    }
    return payload;
  }

  private afterConfigDispatch(changed: Omit<ProfileUpdateData, 'activeToolNames'>): void {
    if (changed.modelAlias !== undefined) {
      const model = this.tryResolveRawModel();
      this.host.telemetryContext.set({
        provider_type: model?.providerType ?? model?.protocol,
        protocol: model?.protocol,
      });
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
      const warning = anthropicThinkingEffortWarning(
        this.tryResolveRawModel(),
        this.effectiveThinkingLevel(),
      );
      if (warning === undefined) return;
      const emitted = this.logicState().emittedThinkingEffortWarnings;
      if (emitted.has(warning.key)) return;
      emitted.add(warning.key);
      void this.context.dispatch(
        new WarningIssued({
          agentId: this.context.agent.agentId,
          code: warning.code,
          message: warning.message,
        }),
      );
    } catch {
    }
  }

  private emitStatusUpdated(includeThinkingEffort = false): void {
    const modelAlias = this.currentModelAlias();
    if (modelAlias === undefined) return;
    const capabilities = this.tryResolveRawModel()?.capabilities;
    const maxContextTokens = capabilities?.max_input_tokens ?? capabilities?.max_context_tokens;
    void this.context.dispatch(
      new AgentStatusUpdated({
        agentId: this.context.agent.agentId,
        model: modelAlias,
        thinkingEffort: includeThinkingEffort ? this.effectiveThinkingLevel() : undefined,
        maxContextTokens:
          maxContextTokens !== undefined && maxContextTokens > 0 ? maxContextTokens : undefined,
      }),
    );
  }

  private buildContext(
    profile: ResolvedAgentProfile,
    options: ApplyProfileOptions | undefined,
  ): Promise<SystemPromptContext> {
    const deps: SystemPromptContextDeps = {
      runtime: this.host.agentRuntime,
      sessionContext: this.context.get(ISessionContext),
      workspace: this.context.get(ISessionWorkspaceContext),
      instructions: this.context.get(ISessionInstructionsProvider),
      bootstrap: this.context.get(IBootstrapService),
      skillCatalog: this.context.get(ISessionSkillCatalog),
      plugins: this.context.get(IPluginService),
      clock: this.context.get(IHostClock),
      identity: this.context.get(IAgentIdentity),
      toolPolicyGate: this.context.get(ISessionToolPolicyGate),
      sessionToolPolicy: this.context.get(ISessionToolPolicy),
      config: this.context.get(IConfigService),
    };
    const logicState = (): ProfileActorContext => this.logicState();
    const patch = (value: ProfilePatchEvent['patch']): void => {
      this.patch(value);
    };
    const caches: SystemPromptCaches = {
      get frozenSkillListing() {
        return logicState().frozenSkillListing;
      },
      set frozenSkillListing(value: string | undefined) {
        patch({ frozenSkillListing: value });
      },
      get frozenPluginSections() {
        return logicState().frozenPluginSections;
      },
      set frozenPluginSections(value: string | undefined) {
        patch({ frozenPluginSections: value });
      },
      emittedPluginBudgetWarnings: logicState().emittedPluginBudgetWarnings,
    };
    return buildSystemPromptContext(deps, caches, profile, options, (message, code) => {
      void this.context.dispatch(
        new WarningIssued({ agentId: this.context.agent.agentId, message, code }),
      );
    });
  }

  private seedAgentsMdReminder(context: SystemPromptContext): void {
    this.context
      .get(ISessionAgentsMdReminderService)
      .of(this.context.agent)
      .seedInjected(
        context.agentsMdPaths ?? [],
        context.cwd ?? this.context.get(ISessionContext).cwd,
      );
  }

  private cacheAgentsMdWarning(context: Pick<SystemPromptContext, 'agentsMdWarning'>): void {
    this.patch({ agentsMdWarning: context.agentsMdWarning });
  }

  private publishAgentsMdWarning(): void {
    const warning = this.logicState().agentsMdWarning;
    if (warning === undefined) return;
    void this.context.dispatch(
      new WarningIssued({
        agentId: this.context.agent.agentId,
        message: warning,
        code: 'agents-md-oversized',
      }),
    );
  }

  private publishPatterns(profile?: ResolvedAgentProfile): void {
    publishToolPatternWarnings(
      {
        config: this.context.get(IConfigService),
        toolReferences: [],
        builtinProfiles: this.context.get(IBuiltinAgentProfileLoader),
      },
      this.logicState().emittedToolPatternWarnings,
      profile,
      (message, code) => {
        void this.context.dispatch(
          new WarningIssued({ agentId: this.context.agent.agentId, message, code }),
        );
      },
    );
  }

  private assertBindable(requested: string): void {
    const current = this.currentProfileName();
    if (current !== undefined && current !== requested) {
      throw new ProfileError(
        ProfileErrors.codes.PROFILE_ALREADY_BOUND,
        `agent is already bound to profile "${current}"; cannot switch to "${requested}" in this session`,
        { current, requested },
      );
    }
  }

  private thinkingDeps(): ThinkingDeps {
    return {
      config: this.context.get(IConfigService),
      protocolAdapters: this.context.get(IProtocolAdapterRegistry),
    };
  }

  private thinkingState(model: Model | undefined): {
    readonly effective: ThinkingEffort;
    readonly forced: ThinkingEffort | undefined;
  } {
    return resolveThinkingState(this.thinkingDeps(), this.storedThinkingLevel(), model);
  }

  private profileState() {
    return this.context.getState().profile;
  }

  private logicState(): ProfileActorContext {
    return this.context.getLogicState<ProfileActorContext>();
  }

  private patch(event: ProfilePatchEvent['patch']): void {
    this.context.send({ type: 'profile.patch', patch: event });
  }

  private currentModelAlias(): string | undefined {
    return this.profileState().modelAlias;
  }

  private currentProfileName(): string | undefined {
    return this.profileState().profileName;
  }

  private storedThinkingLevel(): ThinkingEffort {
    const stored = this.profileState().thinkingLevel;
    if (stored === 'off' && this.alwaysThinkingModel()) {
      return resolveThinkingEffort(this.thinkingDeps(), stored, this.tryResolveRawModel());
    }
    return stored;
  }

  private alwaysThinkingModel(): boolean {
    return this.tryResolveRawModel()?.alwaysThinking === true;
  }

  private tryResolveRawModel(): Model | undefined {
    return this.resolveModelForThinking(this.currentModelAlias());
  }

  private resolveModelForThinking(alias: string | undefined): Model | undefined {
    if (alias === undefined) return undefined;
    try {
      return this.context.get(IModelCatalog).get(alias);
    } catch {
      return undefined;
    }
  }

  private requireModelAlias(): string {
    const modelAlias = this.currentModelAlias();
    if (modelAlias === undefined) {
      throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'Model not set');
    }
    return modelAlias;
  }
}

export const AgentProfile = defineAgentRuntimeContract<ProfileRuntime>('profile');

export const profileAgentRuntimeProvider = defineAgentRuntimeProvider<
  ProfileState,
  ProfileRuntime
>(AgentProfile, {
  id: 'profile',
  logic: profileActorLogic,
  durable: {
    events: [ProfileBind, ConfigUpdate, ToolsSetActiveTools, ToolsResetActiveTools],
    undoable: false,
    transition: (state, event) => {
      if (event instanceof ProfileBind) {
        return foldProfileBind(state, event);
      }
      if (event instanceof ConfigUpdate) {
        foldConfigUpdate(state, event);
        return;
      }
      if (event instanceof ToolsSetActiveTools) {
        foldToolsSetActiveTools(state, event);
        return;
      }
      if (event instanceof ToolsResetActiveTools) {
        foldToolsResetActiveTools(state);
        return;
      }
      return undefined;
    },
    read: (snapshot) => (snapshot as ProfileActorSnapshot).context.ledger,
    commit: (actor, ledger) => {
      actor.send({ type: 'profile.commit', ledger });
    },
  },
  createApi: (context) => new ProfileRuntime(context),
  inspect: (snapshot) => (snapshot as ProfileActorSnapshot).context.ledger.profile.modelAlias,
});
