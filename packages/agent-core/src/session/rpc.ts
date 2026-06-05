import { ErrorCodes, KimiError } from '#/errors';
import type {
  ActivateSkillPayload,
  AgentAPI,
  BeginCompactionPayload,
  CancelPayload,
  CancelPlanPayload,
  CreateGoalPayload,
  EmptyPayload,
  GoalControlPayload,
  GetBackgroundOutputPayload,
  GetBackgroundPayload,
  McpServerInfo,
  McpStartupMetrics,
  PromptPayload,
  ReconnectMcpServerPayload,
  RenameSessionPayload,
  RegisterToolPayload,
  SessionAPI,
  SetActiveToolsPayload,
  SetModelPayload,
  SetPermissionPayload,
  SetThinkingPayload,
  SkillSummary,
  SteerPayload,
  StopBackgroundPayload,
  UndoHistoryPayload,
  UnregisterToolPayload,
  UpdateSessionMetadataPayload,
} from '#/rpc';
import type { PromisableMethods } from '#/utils/types';

import type { Session, SessionMeta } from '.';
import {
  promptMetadataTextFromPayload,
  promptMetadataTextFromSkill,
  titleFromPromptMetadataText,
} from './prompt-metadata';

type AgentScopedPayload<T> = T & { agentId: string };

export class SessionAPIImpl implements PromisableMethods<SessionAPI> {
  constructor(protected readonly session: Session) {}

  async renameSession(payload: RenameSessionPayload): Promise<void> {
    const title = payload.title.trim();
    if (title.length === 0) {
      throw new KimiError(ErrorCodes.SESSION_TITLE_EMPTY, 'Session title cannot be empty');
    }
    this.session.metadata = {
      ...this.session.metadata,
      title,
      isCustomTitle: true,
      updatedAt: new Date().toISOString(),
    };
    await this.session.writeMetadata();
  }

  async updateSessionMetadata(payload: UpdateSessionMetadataPayload): Promise<void> {
    // `metadata.custom.goal` is reserved for the goal lifecycle store. Generic
    // metadata updates must neither overwrite an active goal nor write the goal
    // field directly.
    const reservedGoal = this.session.metadata.custom?.['goal'];
    const patchCustom = (payload.metadata as Partial<SessionMeta> | undefined)?.custom;
    if (patchCustom !== undefined && 'goal' in patchCustom) {
      throw new KimiError(
        ErrorCodes.GOAL_METADATA_RESERVED,
        'metadata.custom.goal is reserved; use the goal lifecycle methods',
      );
    }
    this.session.metadata = {
      ...this.session.metadata,
      ...payload.metadata,
      agents: this.session.metadata.agents,
    };
    if (reservedGoal !== undefined) {
      this.session.metadata.custom = {
        ...this.session.metadata.custom,
        goal: reservedGoal,
      };
    }
    await this.session.writeMetadata();
  }

  getSessionMetadata(_payload: EmptyPayload): SessionMeta {
    return this.session.metadata;
  }

  listSkills(_payload: EmptyPayload): Promise<readonly SkillSummary[]> {
    return this.session.listSkills();
  }

  listMcpServers(_payload: EmptyPayload): readonly McpServerInfo[] {
    return this.session.mcp.list();
  }

  async getMcpStartupMetrics(_payload: EmptyPayload): Promise<McpStartupMetrics> {
    await this.session.mcp.waitForInitialLoad();
    return { durationMs: this.session.mcp.initialLoadDurationMs() };
  }

  async reconnectMcpServer(payload: ReconnectMcpServerPayload): Promise<void> {
    await this.session.mcp.reconnect(payload.name);
  }

  generateAgentsMd(_payload: EmptyPayload): Promise<void> {
    return this.session.generateAgentsMd();
  }

  // --- Goal lifecycle (delegates to the session goal store) -------------

  createGoal(payload: CreateGoalPayload) {
    this.assertGoalCommandEnabled();
    return this.session.goals.createGoal({ ...payload, actor: 'user' });
  }

  getGoal(_payload: EmptyPayload) {
    this.assertGoalCommandEnabled();
    return this.session.goals.getGoal();
  }

  pauseGoal(payload: GoalControlPayload) {
    this.assertGoalCommandEnabled();
    return this.session.goals.pauseGoal({ actor: 'user', reason: payload.reason });
  }

  resumeGoal(payload: GoalControlPayload) {
    this.assertGoalCommandEnabled();
    return this.session.goals.resumeGoal({ actor: 'user', reason: payload.reason });
  }

  async cancelGoal(payload: GoalControlPayload) {
    this.assertGoalCommandEnabled();
    const snapshot = await this.session.goals.cancelGoal({
      actor: 'user',
      reason: payload.reason,
    });
    this.session.getReadyAgent('main')?.context.appendSystemReminder(
      [
        'The user cancelled the current goal.',
        'Ignore earlier active-goal reminders for that goal.',
        'Handle the next user request normally unless the user starts or resumes a goal.',
      ].join(' '),
      { kind: 'system_trigger', name: 'goal_cancelled' },
    );
    return snapshot;
  }

  private assertGoalCommandEnabled(): void {
    if (this.session.experimentalFlags.enabled('goal_command')) return;
    throw new KimiError(ErrorCodes.NOT_IMPLEMENTED, 'Goal command is disabled');
  }

  async prompt({ agentId, ...payload }: AgentScopedPayload<PromptPayload>) {
    if (agentId === 'main') {
      await this.updatePromptMetadata(promptMetadataTextFromPayload(payload));
    }
    return (await this.getAgent(agentId)).prompt(payload);
  }

  async steer({ agentId, ...payload }: AgentScopedPayload<SteerPayload>) {
    return (await this.getAgent(agentId)).steer(payload);
  }

  async cancel({ agentId, ...payload }: AgentScopedPayload<CancelPayload>) {
    return (await this.getAgent(agentId)).cancel(payload);
  }

  async undoHistory({ agentId, ...payload }: AgentScopedPayload<UndoHistoryPayload>) {
    return (await this.getAgent(agentId)).undoHistory(payload);
  }

  async setModel({ agentId, ...payload }: AgentScopedPayload<SetModelPayload>) {
    return (await this.getAgent(agentId)).setModel(payload);
  }

  async setThinking({ agentId, ...payload }: AgentScopedPayload<SetThinkingPayload>) {
    return (await this.getAgent(agentId)).setThinking(payload);
  }

  async setPermission({ agentId, ...payload }: AgentScopedPayload<SetPermissionPayload>) {
    return (await this.getAgent(agentId)).setPermission(payload);
  }

  async getModel({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getModel(payload);
  }

  async enterPlan({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).enterPlan(payload);
  }

  async cancelPlan({ agentId, ...payload }: AgentScopedPayload<CancelPlanPayload>) {
    return (await this.getAgent(agentId)).cancelPlan(payload);
  }

  async clearPlan({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).clearPlan(payload);
  }

  async beginCompaction({ agentId, ...payload }: AgentScopedPayload<BeginCompactionPayload>) {
    return (await this.getAgent(agentId)).beginCompaction(payload);
  }

  async cancelCompaction({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).cancelCompaction(payload);
  }

  async registerTool({ agentId, ...payload }: AgentScopedPayload<RegisterToolPayload>) {
    return (await this.getAgent(agentId)).registerTool(payload);
  }

  async unregisterTool({ agentId, ...payload }: AgentScopedPayload<UnregisterToolPayload>) {
    return (await this.getAgent(agentId)).unregisterTool(payload);
  }

  async setActiveTools({ agentId, ...payload }: AgentScopedPayload<SetActiveToolsPayload>) {
    return (await this.getAgent(agentId)).setActiveTools(payload);
  }

  async stopBackground({ agentId, ...payload }: AgentScopedPayload<StopBackgroundPayload>) {
    return (await this.getAgent(agentId)).stopBackground(payload);
  }

  async clearContext({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).clearContext(payload);
  }

  async activateSkill({ agentId, ...payload }: AgentScopedPayload<ActivateSkillPayload>) {
    await (await this.getAgent(agentId)).activateSkill(payload);
    if (agentId === 'main') {
      await this.updatePromptMetadata(promptMetadataTextFromSkill(payload));
    }
  }

  async startBtw({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>): Promise<string> {
    return (await this.getAgent(agentId)).startBtw(payload);
  }

  async getBackgroundOutput({
    agentId,
    ...payload
  }: AgentScopedPayload<GetBackgroundOutputPayload>) {
    return (await this.getAgent(agentId)).getBackgroundOutput(payload);
  }

  async getContext({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getContext(payload);
  }

  async getConfig({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getConfig(payload);
  }

  async getPermission({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getPermission(payload);
  }

  async getPlan({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getPlan(payload);
  }

  async getUsage({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getUsage(payload);
  }

  async getTools({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getTools(payload);
  }

  async getBackground({ agentId, ...payload }: AgentScopedPayload<GetBackgroundPayload>) {
    return (await this.getAgent(agentId)).getBackground(payload);
  }

  private async getAgent(agentId: string): Promise<PromisableMethods<AgentAPI>> {
    const agent = await this.session.ensureAgentResumed(agentId);
    return agent.rpcMethods;
  }

  private needUpdateEasyTitle(metadata: SessionMeta): boolean {
    if (hasCustomTitle(metadata)) return false;
    if (!isUntitled(metadata.title)) return false;
    return true;
  }

  private async updatePromptMetadata(lastPrompt: string | undefined): Promise<void> {
    if (lastPrompt === undefined) return;

    const title = this.needUpdateEasyTitle(this.session.metadata)
      ? titleFromPromptMetadataText(lastPrompt)
      : undefined;
    const now = new Date().toISOString();
    const nextMetadata = {
      ...this.session.metadata,
      lastPrompt,
      updatedAt: now,
    };
    if (title !== undefined) {
      nextMetadata.title = title;
      nextMetadata.isCustomTitle = false;
    }

    this.session.metadata = nextMetadata;
    await this.session.writeMetadata();
    await this.session.rpc.emitEvent({
      type: 'session.meta.updated',
      agentId: 'main',
      title,
      patch: {
        title,
        isCustomTitle: title === undefined ? undefined : false,
        lastPrompt,
      },
    });
  }
}

function isUntitled(title: unknown): boolean {
  return typeof title !== 'string' || title.trim().length === 0 || title === 'New Session';
}

function hasCustomTitle(metadata: SessionMeta): boolean {
  if (metadata.isCustomTitle) return true;
  return typeof (metadata as SessionMeta & { customTitle?: unknown }).customTitle === 'string';
}
