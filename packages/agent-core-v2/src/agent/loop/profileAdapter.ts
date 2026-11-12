import type { IEventDispatcher } from '#/state/eventDispatcher';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { IProviderDiscoveryService } from '#/app/kosongConfig/discovery';
import type { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import type { ModelCapability } from '#/llm-adapter/contract/capability';
import type { ModelRequestParams } from '#/llm-adapter/model/generate';
import type { ThinkingEffort } from '#human/llm-requester/thinking';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  EMPTY_LOOP_PROFILE,
  ProfileBind,
  ConfigUpdate,
  ToolsSetActiveTools,
  reduceLoopActiveTools,
  reduceLoopConfigUpdate,
  reduceLoopProfileBind,
} from '#/agent/profile/profileOps';
import {
  IAgentProfileService,
  type ApplyProfileOptions,
  type BindAgentInput,
  type EffectiveProfileReader,
  type ProfileBindingSnapshot,
  type ProfileData,
  type ProfileModelContext,
  type ProfileSetModelResult,
  type ProfileUpdateData,
  type ResolvedAgentProfile,
  type SystemPromptContext,
} from '#/agent/profile/profile';
import type { LoopJournalSnapshot } from './journal';

export class AgentLoopProfileAdapter implements EffectiveProfileReader {
  private state: { readonly profile?: ProfileBindingSnapshot; readonly bound: boolean } = { bound: false };
  private activeToolNamesOverlay: readonly string[] | undefined;

  constructor(
    private readonly profile: IAgentProfileService,
    private readonly dispatcher: IEventDispatcher,
    private readonly scopeContext: IAgentScopeContext,
    private readonly discovery: IProviderDiscoveryService,
    private readonly catalog: ISessionAgentProfileCatalog,
    private readonly telemetry: ITelemetryService,
    private readonly systemPromptChanged: (value: string) => void,
  ) {}

  snapshot(): ProfileBindingSnapshot {
    return this.state.profile ?? EMPTY_LOOP_PROFILE;
  }

  data(): ProfileData {
    const data = this.profile.data(this.snapshot());
    if (this.activeToolNamesOverlay === undefined) return data;
    return { ...data, activeToolNames: [...this.activeToolNamesOverlay] };
  }

  getSystemPrompt(): string {
    return this.snapshot().systemPrompt;
  }

  getAgentsMdWarning(): string | undefined {
    return this.profile.getAgentsMdWarning();
  }

  getModel(): string {
    return this.profile.getModel(this.snapshot());
  }

  getEffectiveThinkingLevel(): ThinkingEffort {
    return this.profile.getEffectiveThinkingLevel(this.snapshot());
  }

  resolveModelContext(): ProfileModelContext {
    return this.profile.resolveModelContext(this.snapshot());
  }

  resolveRequestParams(): ModelRequestParams {
    return this.profile.resolveRequestParams(this.snapshot());
  }

  getModelCapabilities(): ModelCapability {
    return this.profile.getModelCapabilities(this.snapshot());
  }

  getModelProviderType(alias?: string): string | undefined {
    return this.profile.getModelProviderType(alias, this.snapshot());
  }

  getMaxOutputSize(): number | undefined {
    return this.profile.getMaxOutputSize(this.snapshot());
  }

  hasModel(): boolean {
    return this.profile.hasModel(this.snapshot());
  }

  isRunnable(): boolean {
    return this.profile.isRunnable(this.snapshot());
  }

  hasProvider(): boolean {
    return this.profile.hasProvider(this.snapshot());
  }

  getActiveToolNames(): readonly string[] | undefined {
    return this.data().activeToolNames;
  }

  async setProfile(profile: ProfileBindingSnapshot): Promise<void> {
    const event = new ProfileBind({
      agentId: this.scopeContext.agentId,
      modelAlias: profile.modelAlias,
      profileName: profile.profileName,
      thinkingEffort: profile.thinkingLevel,
      systemPrompt: profile.systemPrompt,
      environmentDisclosure: profile.environmentDisclosure,
      renderGeneration: profile.renderGeneration,
      agentsMdPaths: profile.agentsMdPaths,
      activeToolNames: profile.activeToolNames,
      disallowedTools: profile.disallowedTools ?? [],
      subagents: profile.subagents,
    });
    const dispatched = this.dispatcher.dispatch(event);
    this.state = { profile: reduceLoopProfileBind(this.state.profile, event), bound: true };
    this.systemPromptChanged(this.getSystemPrompt());
    this.profile.afterConfigDispatch({
      modelAlias: profile.modelAlias,
      profileName: profile.profileName,
      thinkingLevel: profile.thinkingLevel,
      systemPrompt: profile.systemPrompt,
      environmentDisclosure: profile.environmentDisclosure,
      agentsMdPaths: profile.agentsMdPaths,
      disallowedTools: profile.disallowedTools ?? [],
    }, this.snapshot());
    await dispatched;
  }

  async bindProfile(input: BindAgentInput): Promise<void> {
    await this.setProfile(await this.profile.resolveBinding(input, this.state.profile));
  }

  applyBindingSnapshot(profile: ProfileBindingSnapshot): Promise<void> {
    const binding = this.profile.prepareBindingSnapshot(profile);
    this.activeToolNamesOverlay = undefined;
    return this.setProfile(binding);
  }

  useProfile(profile: ResolvedAgentProfile, context: SystemPromptContext): void {
    const changed = this.profile.useProfile(profile, context);
    this.applyUpdate(changed, this.profile.prepareUpdate(changed, this.state.profile, profile.tools ?? null));
  }

  async applyProfile(profile: ResolvedAgentProfile, options?: ApplyProfileOptions): Promise<void> {
    const changed = await this.profile.applyProfile(profile, options);
    this.applyUpdate(changed, this.profile.prepareUpdate(changed, this.state.profile, profile.tools ?? null));
  }

  update(changed: ProfileUpdateData): void {
    this.applyUpdate(changed, this.profile.prepareUpdate(changed, this.state.profile));
  }

  private applyUpdate(changed: ProfileUpdateData, plan: ReturnType<IAgentProfileService['prepareUpdate']>): void {
    if (plan.config !== undefined) {
      void this.dispatcher.dispatch(new ConfigUpdate(plan.config));
      this.state = { ...this.state, profile: reduceLoopConfigUpdate(this.snapshot(), plan.config) };
    }
    if (plan.tools !== undefined) {
      void this.dispatcher.dispatch(plan.tools);
      this.activeToolNamesOverlay = undefined;
      this.state = {
        ...this.state,
        profile: reduceLoopActiveTools(this.snapshot(), plan.tools instanceof ToolsSetActiveTools ? plan.tools.names : undefined),
      };
    }
    this.systemPromptChanged(this.getSystemPrompt());
    if (plan.config !== undefined) {
      const { activeToolNames: _activeToolNames, ...configChanged } = changed;
      this.profile.afterConfigDispatch(configChanged, this.snapshot());
    }
  }

  async setModel(alias: string): Promise<ProfileSetModelResult> {
    const result = this.profile.resolveModel(alias);
    if (this.state.profile?.profileName === undefined) {
      await this.bindProfile({ profile: DEFAULT_AGENT_PROFILE_NAME, model: alias });
      this.telemetry.track2('model_switch', { model: alias });
    } else if (this.state.profile.modelAlias !== alias) {
      this.update({ modelAlias: alias });
      this.telemetry.track2('model_switch', { model: alias });
    }
    return result;
  }

  setThinking(level: string): void {
    const previousEffort = this.data().thinkingLevel;
    const thinkingLevel = this.profile.resolveThinkingLevel(level, this.state.profile);
    this.update({ thinkingLevel });
    const effort = this.data().thinkingLevel;
    if (effort !== previousEffort) {
      this.telemetry.track2('thinking_toggle', { enabled: effort !== 'off', effort, from: previousEffort });
    }
  }

  republishStatus(): void {
    this.profile.republishStatus(this.snapshot());
  }

  addActiveTool(name: string): void {
    const active = this.getActiveToolNames();
    if (active === undefined || active.includes(name)) return;
    this.activeToolNamesOverlay = [...active, name];
  }

  removeActiveTool(name: string): void {
    const active = this.getActiveToolNames();
    if (active === undefined || !active.includes(name)) return;
    this.activeToolNamesOverlay = active.filter((candidate) => candidate !== name);
  }

  async refreshBoundSubagentAllowlist(): Promise<void> {
    const snapshot = await this.profile.refreshBoundSubagentAllowlist(this.state.profile);
    if (snapshot !== undefined) await this.setProfile(snapshot);
  }

  restore(snapshot: LoopJournalSnapshot): void {
    this.state = { profile: snapshot.profile, bound: snapshot.profileBound };
  }

  async afterRestore(): Promise<void> {
    const modelAlias = this.state.profile?.modelAlias;
    const replacement = modelAlias === undefined ? undefined : this.discovery.retiredModelReplacement(modelAlias);
    if (replacement !== undefined) await this.setModel(replacement).catch(() => {});
    this.profile.afterConfigDispatch({ modelAlias: this.state.profile?.modelAlias }, this.snapshot());
    await this.refreshBoundSubagentAllowlist();
  }
}
