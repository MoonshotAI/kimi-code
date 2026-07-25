/**
 * `profile` domain (L4) — `IAgentProfileService` implementation.
 *
 * Owns the active agent's model alias, thinking level, system prompt, and
 * active-tool set; reads the bound model's pure data through the App-scope
 * `IModelCatalog` and produces the dialect-free per-turn intent
 * (`resolveRequestParams`: cache key / sampling / thinking effort+keep —
 * wire encoding is each dialect's own hook), persists the profile binding
 * (`cwd` / `modelAlias` / `profileName` / resolved base `thinkingLevel` /
 * `systemPrompt` / `activeToolNames` / profile `disallowedTools` / profile
 * `subagents`) in the `wire` `ProfileModel` through the `profile.bind` Op
 * (later slice updates ride the `config.update` Op) and the persisted
 * active-tool set in the `wire` `ActiveToolsModel` through the
 * `tools.set_active_tools` / `tools.reset_active_tools` Ops (`wire.dispatch`),
 * and reads both through
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
 * `bind()` is first-bind only — a profile is the session's identity: the
 * guard runs before name resolution so `already bound` fails fast, and again
 * in the synchronous segment before the first dispatch, so concurrent binds
 * cannot both pass (an edge-level guard always leaves an interleaving
 * window); a same-name rebind keeps the persisted thinking effort unless the
 * caller explicitly overrides it. `refreshSystemPrompt` never rejects: a
 * failed context build keeps the current prompt and surfaces a warning,
 * because the `[tools]` config watcher fires it voided (an unhandled
 * rejection would crash kap-server) and the Session tool-policy fan-out
 * awaits it across agents. Tool-policy entries that can never activate
 * anything (typo'd names, wildcards without the `mcp__` prefix, incomplete
 * `mcp__` literals) surface as `warning` events instead of silently shrinking
 * the tool set; the known-name vocabulary is the live registry plus
 * builtin-profile literal names — deliberately not the session catalog, so a
 * typo in one agent file cannot legitimize the same typo in another, and
 * flag-gated tools (which every builtin profile lists) stay "known" even when
 * unregistered.
 * Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { UNKNOWN_CAPABILITY, type ModelCapability } from '#/kosong/contract/capability';
import { type SamplingOptions, type ThinkingEffort } from '#/kosong/contract/provider';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { type ModelOverrides } from '#/kosong/model/model.types';
import { type ModelRequestParams } from '#/kosong/model/modelRequester';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import {
  drivesThinkingThroughTraits,
  modelSupportsThinkingEffort,
  normalizeRequestedThinkingEffort,
  resolveForcedThinkingEffort,
  resolveThinkingEffortForModel,
  resolveThinkingKeep,
  requiresStrictThinkingValidation,
  type ThinkingConfig,
} from '#/kosong/model/thinking';
import { THINKING_SECTION } from '#/app/kosongConfig/configSection';
import { DEFAULT_AGENT_PROFILE_NAME, IAgentProfileCatalogService } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ErrorCodes, Error2 } from "#/errors";
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
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
import { TOOLS_SECTION, type ToolsConfig } from '#/agent/toolPolicy/configSection';
import { isToolActiveComposed, findInactiveToolPatterns, literalToolNames, type InactiveToolPattern } from '#/agent/toolPolicy/evaluate';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import {
  ActiveToolsModel,
  configUpdate,
  profileBind,
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

function describeInactiveToolPattern(
  context: string,
  field: string,
  issue: InactiveToolPattern,
): string {
  switch (issue.kind) {
    case 'unknown-tool':
      return `Tool pattern "${issue.pattern}" in ${context} ${field} does not match any registered or built-in tool; it will never activate anything.`;
    case 'wildcard-not-mcp':
      return `Tool pattern "${issue.pattern}" in ${context} ${field} uses wildcards, which only match MCP tools (names starting with "mcp__"); it will never activate anything.`;
    case 'incomplete-mcp-name':
      return `Tool pattern "${issue.pattern}" in ${context} ${field} matches no tool; use "${issue.pattern}__*" to match the whole MCP server.`;
  }
}

export class AgentProfileService extends Disposable implements IAgentProfileService {
  declare readonly _serviceBrand: undefined;

  private optionsValue: ProfileServiceOptions = {};
  private activeToolNamesOverlay: readonly string[] | undefined;
  private agentsMdWarning: string | undefined;
  private readonly emittedThinkingEffortWarnings = new Set<string>();
  private readonly emittedToolPatternWarnings = new Set<string>();

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
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IProtocolAdapterRegistry private readonly protocolAdapters: IProtocolAdapterRegistry,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @ISessionToolPolicy private readonly sessionToolPolicy: ISessionToolPolicy,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentProfileCatalogService private readonly builtinProfiles: IAgentProfileCatalogService,
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
        if (domain === TOOLS_SECTION) {
          this.publishToolPatternWarnings();
          void this.refreshSystemPrompt();
        }
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
    this.activeToolNamesOverlay = undefined;
    this.wire.dispatch(
      profileBind({
        cwd: snapshot.cwd,
        modelAlias: snapshot.modelAlias,
        profileName: snapshot.profileName,
        thinkingEffort: snapshot.thinkingLevel,
        systemPrompt: snapshot.systemPrompt,
        activeToolNames: snapshot.activeToolNames,
        disallowedTools: snapshot.disallowedTools ?? [],
        subagents: snapshot.subagents,
      }),
    );
    this.afterConfigDispatch({
      cwd: snapshot.cwd,
      modelAlias: snapshot.modelAlias,
      profileName: snapshot.profileName,
      thinkingLevel: snapshot.thinkingLevel,
      systemPrompt: snapshot.systemPrompt,
      disallowedTools: snapshot.disallowedTools ?? [],
    });
  }

  async bind(input: BindAgentInput): Promise<void> {
    await this.catalog.ready;
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
    const model = this.modelCatalog.get(alias);

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

    const thinkingLevel = this.resolveThinkingEffort(
      input.thinking ?? (currentProfileName !== undefined ? this.thinkingLevel : undefined),
      model,
    );

    this.activeToolNamesOverlay = undefined;
    this.wire.dispatch(profileBind({
      cwd: input.cwd,
      modelAlias: alias,
      profileName: profile.name,
      thinkingEffort: thinkingLevel,
      systemPrompt,
      activeToolNames: profile.tools,
      disallowedTools: profile.disallowedTools ?? [],
      subagents: profile.subagents,
    }));
    this.afterConfigDispatch({
      cwd: input.cwd,
      modelAlias: alias,
      profileName: profile.name,
      thinkingLevel,
      systemPrompt,
      disallowedTools: profile.disallowedTools ?? [],
    });

    this.publishAgentsMdWarning();
    this.publishToolPatternWarnings(profile);
  }

  async setModel(alias: string): Promise<ProfileSetModelResult> {
    const model = this.modelCatalog.get(alias);
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
    if (normalized === undefined || this.supportsThinkingEffort(normalized, model)) return;
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
    this.publishToolPatternWarnings(profile);
  }

  async refreshSystemPrompt(): Promise<void> {
    const profile = this.resolveActiveProfile();
    if (profile === undefined) return;

    let context: SystemPromptContext;
    try {
      context = await this.buildSystemPromptContext(profile, this.cwd);
    } catch (error) {
      this.eventBus.publish({
        type: 'warning',
        message: `System prompt refresh skipped: ${error instanceof Error ? error.message : String(error)}`,
        code: 'system-prompt-refresh-failed',
      });
      return;
    }
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
      subagents:
        this.profileState.subagents === undefined ? undefined : [...this.profileState.subagents],
    };
  }

  getEffectiveThinkingLevel(): ThinkingEffort {
    return this.resolveThinkingState(this.tryResolveRawModel()).effective;
  }

  resolveModelContext(): ProfileModelContext {
    const modelAlias = this.model;
    const model = this.modelCatalog.get(modelAlias);
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

  resolveRequestParams(): ModelRequestParams {
    const model = this.tryResolveRawModel();
    const thinking = this.resolveThinkingState(model);
    const thinkingConfig = this.config.get<ThinkingConfig>(THINKING_SECTION);
    const overrides = this.config.get<ModelOverrides>('modelOverrides');
    const sampling: SamplingOptions = {
      temperature: overrides?.temperature,
      topP: overrides?.topP,
    };
    return {
      cacheKey: this.sessionContext.sessionId,
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
      payload.thinkingEffort = this.resolveThinkingEffort(requested, model);
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
      const model = this.tryResolveRawModel();
      this.telemetryContext.set({
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
      const model = this.tryResolveRawModel();
      if (model?.protocol !== 'anthropic') return;
      const effort = this.getEffectiveThinkingLevel();
      if (effort === 'on' || effort === 'off') return;

      let code: string;
      let message: string;
      let knownEfforts = '';
      const efforts = model.supportEfforts?.filter((value) => value.length > 0);
      if (efforts === undefined || efforts.length === 0 || efforts.includes(effort)) return;
      knownEfforts = efforts.join(',');
      code = 'anthropic-thinking-effort-not-listed';
      message = `Thinking effort "${effort}" is not listed for model "${model.name}" (known: ${efforts.join(', ')}). The configured value will be sent unchanged to the Anthropic-compatible backend.`;

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
      maxContextTokens:
        this.getModelCapabilities().max_input_tokens ??
        this.getModelCapabilities().max_context_tokens,
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
      return this.resolveThinkingEffort(stored, this.tryResolveRawModel());
    }
    return stored;
  }

  private resolveThinkingState(model: Model | undefined): {
    readonly effective: ThinkingEffort;
    readonly forced: ThinkingEffort | undefined;
  } {
    const base = this.thinkingLevel;
    const forced = resolveForcedThinkingEffort(
      this.config.get<ThinkingConfig>(THINKING_SECTION)?.forcedEffort,
      base,
      drivesThinkingThroughTraits(model?.providerType),
    );
    return { effective: forced ?? base, forced };
  }

  /**
   * The registry-driven strict-validation verdict for one model (v1
   * `provider.type === 'kimi'` parity): strict effort validation and
   * trait-driven normalization apply only when the (protocol, providerType)
   * pair's thinking driver marks `strictThinkingValidation`. Over a foreign
   * transport (the `(kimi, anthropic)` registration, e.g. managed models on
   * protocol `anthropic`) the profile stays lenient and warns instead of
   * rejecting unlisted efforts.
   */
  private strictThinkingValidation(model: Model | undefined): boolean {
    if (model === undefined) return false;
    return requiresStrictThinkingValidation(
      this.protocolAdapters,
      model.protocol,
      model.providerType,
    );
  }

  private resolveThinkingEffort(
    requested: string | undefined,
    model: Model | undefined,
  ): ThinkingEffort {
    return resolveThinkingEffortForModel(
      requested,
      this.config.get<ThinkingConfig>(THINKING_SECTION),
      model,
      this.strictThinkingValidation(model),
    );
  }

  private supportsThinkingEffort(effort: ThinkingEffort, model: Model | undefined): boolean {
    return modelSupportsThinkingEffort(effort, model, this.strictThinkingValidation(model));
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
      return this.modelCatalog.get(alias);
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

  private publishToolPatternWarnings(profile?: ResolvedAgentProfile): void {
    const known = new Set<string>();
    for (const ref of this.toolRegistry.listReferences()) known.add(ref.name);
    for (const builtin of this.builtinProfiles.list()) {
      for (const name of literalToolNames([
        ...(builtin.tools ?? []),
        ...(builtin.disallowedTools ?? []),
      ])) {
        known.add(name);
      }
    }
    const checks: {
      context: string;
      field: string;
      patterns: readonly string[] | undefined;
    }[] = [];
    if (profile !== undefined) {
      checks.push(
        { context: `profile "${profile.name}"`, field: 'tools', patterns: profile.tools },
        {
          context: `profile "${profile.name}"`,
          field: 'disallowedTools',
          patterns: profile.disallowedTools,
        },
      );
    }
    const global = this.config.get<ToolsConfig>(TOOLS_SECTION);
    checks.push(
      { context: 'the global [tools] config', field: 'enabled', patterns: global?.enabled },
      { context: 'the global [tools] config', field: 'disabled', patterns: global?.disabled },
    );
    for (const { context, field, patterns } of checks) {
      if (patterns === undefined) continue;
      for (const issue of findInactiveToolPatterns(patterns, (name) => known.has(name))) {
        const key = `${context}|${field}|${issue.pattern}`;
        if (this.emittedToolPatternWarnings.has(key)) continue;
        this.emittedToolPatternWarnings.add(key);
        this.eventBus.publish({
          type: 'warning',
          code: 'tool-pattern-no-match',
          message: describeInactiveToolPattern(context, field, issue),
        });
      }
    }
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
    return isToolActiveComposed(
      {
        profile,
        global: this.config.get<ToolsConfig>(TOOLS_SECTION),
        sessionDisabledTools: this.sessionToolPolicy.disabledTools(),
      },
      name,
      source,
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
