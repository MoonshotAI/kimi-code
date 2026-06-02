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
import { flags } from '../flags';
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

  cancelGoal(payload: GoalControlPayload) {
    this.assertGoalCommandEnabled();
    return this.session.goals.cancelGoal({ actor: 'user', reason: payload.reason });
  }

  private assertGoalCommandEnabled(): void {
    if (flags.enabled('goal-command')) return;
    throw new KimiError(ErrorCodes.NOT_IMPLEMENTED, 'Goal command is disabled');
  }

  async prompt({ agentId, ...payload }: AgentScopedPayload<PromptPayload>) {
    if (agentId === 'main') {
      await this.updatePromptMetadata(promptMetadataTextFromPayload(payload));
    }
    return this.getAgent(agentId).prompt(payload);
  }

  steer({ agentId, ...payload }: AgentScopedPayload<SteerPayload>) {
    return this.getAgent(agentId).steer(payload);
  }

  cancel({ agentId, ...payload }: AgentScopedPayload<CancelPayload>) {
    return this.getAgent(agentId).cancel(payload);
  }

  undoHistory({ agentId, ...payload }: AgentScopedPayload<UndoHistoryPayload>) {
    return this.getAgent(agentId).undoHistory(payload);
  }

  setModel({ agentId, ...payload }: AgentScopedPayload<SetModelPayload>) {
    return this.getAgent(agentId).setModel(payload);
  }

  setThinking({ agentId, ...payload }: AgentScopedPayload<SetThinkingPayload>) {
    return this.getAgent(agentId).setThinking(payload);
  }

  setPermission({ agentId, ...payload }: AgentScopedPayload<SetPermissionPayload>) {
    return this.getAgent(agentId).setPermission(payload);
  }

  getModel({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).getModel(payload);
  }

  enterPlan({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).enterPlan(payload);
  }

  cancelPlan({ agentId, ...payload }: AgentScopedPayload<CancelPlanPayload>) {
    return this.getAgent(agentId).cancelPlan(payload);
  }

  clearPlan({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).clearPlan(payload);
  }

  beginCompaction({ agentId, ...payload }: AgentScopedPayload<BeginCompactionPayload>) {
    return this.getAgent(agentId).beginCompaction(payload);
  }

  cancelCompaction({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).cancelCompaction(payload);
  }

  registerTool({ agentId, ...payload }: AgentScopedPayload<RegisterToolPayload>) {
    return this.getAgent(agentId).registerTool(payload);
  }

  unregisterTool({ agentId, ...payload }: AgentScopedPayload<UnregisterToolPayload>) {
    return this.getAgent(agentId).unregisterTool(payload);
  }

  setActiveTools({ agentId, ...payload }: AgentScopedPayload<SetActiveToolsPayload>) {
    return this.getAgent(agentId).setActiveTools(payload);
  }

  stopBackground({ agentId, ...payload }: AgentScopedPayload<StopBackgroundPayload>) {
    return this.getAgent(agentId).stopBackground(payload);
  }

  clearContext({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).clearContext(payload);
  }

  async activateSkill({ agentId, ...payload }: AgentScopedPayload<ActivateSkillPayload>) {
    await this.getAgent(agentId).activateSkill(payload);
    if (agentId === 'main') {
      await this.updatePromptMetadata(promptMetadataTextFromSkill(payload));
    }
  }

  getBackgroundOutput({ agentId, ...payload }: AgentScopedPayload<GetBackgroundOutputPayload>) {
    return this.getAgent(agentId).getBackgroundOutput(payload);
  }

  getContext({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).getContext(payload);
  }

  getConfig({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).getConfig(payload);
  }

  getPermission({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).getPermission(payload);
  }

  getPlan({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).getPlan(payload);
  }

  getUsage({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).getUsage(payload);
  }

  getTools({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return this.getAgent(agentId).getTools(payload);
  }

  getBackground({ agentId, ...payload }: AgentScopedPayload<GetBackgroundPayload>) {
    return this.getAgent(agentId).getBackground(payload);
  }

  private getAgent(agentId: string): PromisableMethods<AgentAPI> {
    const agent = this.session.agents.get(agentId);
    if (agent === undefined) {
      throw new KimiError(ErrorCodes.AGENT_NOT_FOUND, `Agent "${agentId}" was not found`);
    }
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
