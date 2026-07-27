import { homedir } from 'node:os';

import { ErrorCodes, KimiError } from '#/errors';
import type { SessionWarning } from '@moonshot-ai/protocol';
import type {
  ActivateSkillPayload,
  ActivatePluginCommandPayload,
  AddAdditionalDirPayload,
  AddAdditionalDirResult,
  AgentAPI,
  BeginCompactionPayload,
  CancelPayload,
  CancelPlanPayload,
  CancelShellCommandPayload,
  CancelWorkflowRunPayload,
  CancelWorkflowRunResult,
  CreateGoalPayload,
  DetachBackgroundPayload,
  EmptyPayload,
  EnterSwarmPayload,
  EnterWorkflowModePayload,
  GetBackgroundOutputPayload,
  GetBackgroundPayload,
  GetWorkflowPayload,
  GetWorkflowResult,
  GetWorkflowRunPayload,
  GetWorkflowRunResult,
  ImportContextPayload,
  ListWorkflowRunsResult,
  ListWorkflowsResult,
  McpServerInfo,
  McpStartupMetrics,
  PromptPayload,
  RunShellCommandPayload,
  RunWorkflowPayload,
  RunWorkflowResult,
  ReconnectMcpServerPayload,
  RenameSessionPayload,
  RegisterToolPayload,
  SaveWorkflowPayload,
  SaveWorkflowResult,
  SessionAPI,
  SetActiveToolsPayload,
  SetModelPayload,
  SetPermissionPayload,
  SetThinkingPayload,
  SkillSummary,
  PluginCommandDef,
  SteerPayload,
  StopBackgroundPayload,
  UndoHistoryPayload,
  UnregisterToolPayload,
  UpdateSessionMetadataPayload,
  WorkflowRunSnapshot,
  WorkflowSummary,
} from '#/rpc';
import type { PromisableMethods } from '#/utils/types';
import {
  extractWorkflowMeta,
  resolveWorkflowLimits,
  saveWorkflow,
  WorkflowValidationError,
  type WorkflowDefinition,
  type WorkflowRunRecord,
} from '../workflow';

import type { Session, SessionMeta } from '.';
import {
  promptMetadataTextFromPayload,
  promptMetadataTextFromPluginCommand,
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
    this.session.metadata = {
      ...this.session.metadata,
      ...payload.metadata,
      agents: this.session.metadata.agents,
    };
    await this.session.writeMetadata();
  }

  getSessionMetadata(_payload: EmptyPayload): SessionMeta {
    return this.session.metadata;
  }

  listSkills(_payload: EmptyPayload): Promise<readonly SkillSummary[]> {
    return this.session.listSkills();
  }

  listPluginCommands(_payload: EmptyPayload): readonly PluginCommandDef[] {
    return this.session.listPluginCommands();
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

  getSessionWarnings(_payload: EmptyPayload): Promise<readonly SessionWarning[]> {
    return this.session.getSessionWarnings();
  }

  waitForBackgroundTasksOnPrint(_payload: EmptyPayload): Promise<void> {
    return this.session.waitForBackgroundTasksOnPrint();
  }

  handlePrintMainTurnCompleted(_payload: EmptyPayload): Promise<'finish' | 'continue'> {
    return this.session.handlePrintMainTurnCompleted();
  }

  addAdditionalDir(payload: AddAdditionalDirPayload): Promise<AddAdditionalDirResult> {
    return this.session.addAdditionalDir(payload.path, payload.persist);
  }

  // ─── Dynamic workflows (gated by the 'dynamic-workflows' flag) ───────────

  async listWorkflows(_payload: EmptyPayload): Promise<ListWorkflowsResult> {
    this.requireWorkflowsEnabled();
    await this.session.workflows.load();
    return this.workflowListResult();
  }

  async getWorkflow(payload: GetWorkflowPayload): Promise<GetWorkflowResult> {
    this.requireWorkflowsEnabled();
    await this.session.workflows.load();
    const workflow = this.session.workflows.get(payload.name);
    if (workflow === undefined) return { workflow: null };
    return { workflow: { ...summarizeWorkflow(workflow), script: workflow.script } };
  }

  async reloadWorkflows(_payload: EmptyPayload): Promise<ListWorkflowsResult> {
    this.requireWorkflowsEnabled();
    await this.session.reloadWorkflows();
    return this.workflowListResult();
  }

  /**
   * Start a workflow run by registry `name` or inline `script`.
   *
   * This method does NOT ask for user confirmation — approval is the caller's
   * responsibility (e.g. the TUI shows its confirmation dialog before calling;
   * the model/tool path carries its own approval flow).
   */
  async runWorkflow(payload: RunWorkflowPayload): Promise<RunWorkflowResult> {
    this.requireWorkflowsEnabled();
    const limits = resolveWorkflowLimits(this.session.options.config?.workflows);
    let definition: WorkflowDefinition;
    if (payload.name !== undefined) {
      await this.session.workflows.load();
      const found = this.session.workflows.get(payload.name);
      if (found === undefined) {
        throw new KimiError(
          ErrorCodes.REQUEST_INVALID,
          `Workflow "${payload.name}" was not found`,
        );
      }
      definition = found;
    } else if (payload.script !== undefined) {
      let meta;
      try {
        meta = extractWorkflowMeta(payload.script, { maxScriptBytes: limits.maxScriptBytes });
      } catch (error) {
        if (error instanceof WorkflowValidationError) {
          throw new KimiError(ErrorCodes.REQUEST_INVALID, error.message);
        }
        throw error;
      }
      definition = { meta, script: payload.script, path: '', source: 'extra' };
    } else {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        'runWorkflow requires either name or script',
      );
    }
    const { runId, taskId } = this.session.workflowRuns.start(definition, {
      args: payload.args ?? '',
      limits,
    });
    return { runId, taskId, workflowName: definition.meta.name };
  }

  listWorkflowRuns(_payload: EmptyPayload): ListWorkflowRunsResult {
    this.requireWorkflowsEnabled();
    return {
      runs: this.session.workflowRuns.list().map((record) => snapshotWorkflowRun(record, 50)),
    };
  }

  getWorkflowRun(payload: GetWorkflowRunPayload): GetWorkflowRunResult {
    this.requireWorkflowsEnabled();
    const record = this.session.workflowRuns.get(payload.runId);
    if (record === undefined) return { run: null };
    return { run: { ...snapshotWorkflowRun(record), script: record.script } };
  }

  cancelWorkflowRun(payload: CancelWorkflowRunPayload): CancelWorkflowRunResult {
    this.requireWorkflowsEnabled();
    return { cancelled: this.session.workflowRuns.cancel(payload.runId) };
  }

  async saveWorkflow(payload: SaveWorkflowPayload): Promise<SaveWorkflowResult> {
    this.requireWorkflowsEnabled();
    const limits = resolveWorkflowLimits(this.session.options.config?.workflows);
    let saved: { path: string };
    try {
      saved = await saveWorkflow({
        script: payload.script,
        scope: payload.scope,
        workDir: this.session.options.kaos.getcwd(),
        kimiHome: this.session.options.kimiHomeDir,
        osHome: homedir(),
        overwrite: payload.overwrite,
        maxScriptBytes: limits.maxScriptBytes,
      });
    } catch (error) {
      if (error instanceof WorkflowValidationError) {
        throw new KimiError(ErrorCodes.REQUEST_INVALID, error.message);
      }
      throw error;
    }
    const name = extractWorkflowMeta(payload.script, {
      maxScriptBytes: limits.maxScriptBytes,
    }).name;
    await this.session.reloadWorkflows();
    return { path: saved.path, name };
  }

  private requireWorkflowsEnabled(): void {
    if (!this.session.experimentalFlags.enabled('dynamic-workflows')) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        'Dynamic workflows are disabled. Enable the "dynamic-workflows" experimental flag (KIMI_CODE_EXPERIMENTAL_DYNAMIC_WORKFLOWS=1) first.',
      );
    }
  }

  private workflowListResult(): ListWorkflowsResult {
    return {
      workflows: this.session.workflows.list().map(summarizeWorkflow),
      skipped: this.session.workflows.skipped.map((entry) => ({
        path: entry.path,
        reason: entry.reason,
      })),
    };
  }

  async prompt({ agentId, ...payload }: AgentScopedPayload<PromptPayload>) {
    if (agentId === 'main') {
      await this.updatePromptMetadata(promptMetadataTextFromPayload(payload));
    }
    return (await this.getAgent(agentId)).prompt(payload);
  }

  async steer({ agentId, ...payload }: AgentScopedPayload<SteerPayload>) {
    if (agentId === 'main') {
      // A steer is user input like a prompt — and can even launch the
      // session's first turn (e.g. goal mode) — so keep title/lastPrompt in
      // sync the same way.
      await this.updatePromptMetadata(promptMetadataTextFromPayload(payload));
    }
    return (await this.getAgent(agentId)).steer(payload);
  }

  async runShellCommand({ agentId, ...payload }: AgentScopedPayload<RunShellCommandPayload>) {
    return (await this.getAgent(agentId)).runShellCommand(payload);
  }

  async cancelShellCommand({ agentId, ...payload }: AgentScopedPayload<CancelShellCommandPayload>) {
    return (await this.getAgent(agentId)).cancelShellCommand(payload);
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

  async enterSwarm({ agentId, ...payload }: AgentScopedPayload<EnterSwarmPayload>) {
    return (await this.getAgent(agentId)).enterSwarm(payload);
  }

  async exitSwarm({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).exitSwarm(payload);
  }

  async getSwarmMode({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getSwarmMode(payload);
  }

  async enterWorkflowMode({ agentId, ...payload }: AgentScopedPayload<EnterWorkflowModePayload>) {
    this.requireWorkflowsEnabled();
    return (await this.getAgent(agentId)).enterWorkflowMode(payload);
  }

  async exitWorkflowMode({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    this.requireWorkflowsEnabled();
    return (await this.getAgent(agentId)).exitWorkflowMode(payload);
  }

  async getWorkflowMode({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getWorkflowMode(payload);
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

  async detachBackground({ agentId, ...payload }: AgentScopedPayload<DetachBackgroundPayload>) {
    return (await this.getAgent(agentId)).detachBackground(payload);
  }

  async clearContext({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).clearContext(payload);
  }

  async importContext({ agentId, ...payload }: AgentScopedPayload<ImportContextPayload>) {
    return (await this.getAgent(agentId)).importContext(payload);
  }

  async activateSkill({ agentId, ...payload }: AgentScopedPayload<ActivateSkillPayload>) {
    await (await this.getAgent(agentId)).activateSkill(payload);
    if (agentId === 'main') {
      await this.updatePromptMetadata(promptMetadataTextFromSkill(payload));
    }
  }

  async activatePluginCommand({
    agentId,
    ...payload
  }: AgentScopedPayload<ActivatePluginCommandPayload>) {
    await (await this.getAgent(agentId)).activatePluginCommand(payload);
    if (agentId === 'main') {
      await this.updatePromptMetadata(promptMetadataTextFromPluginCommand(payload));
    }
  }

  async startBtw({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>): Promise<string> {
    return (await this.getAgent(agentId)).startBtw(payload);
  }

  async createGoal({ agentId, ...payload }: AgentScopedPayload<CreateGoalPayload>) {
    return (await this.getAgent(agentId)).createGoal(payload);
  }

  async getGoal({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getGoal(payload);
  }

  async pauseGoal({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).pauseGoal(payload);
  }

  async resumeGoal({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).resumeGoal(payload);
  }

  async cancelGoal({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).cancelGoal(payload);
  }

  async getCronTasks({ agentId, ...payload }: AgentScopedPayload<EmptyPayload>) {
    return (await this.getAgent(agentId)).getCronTasks(payload);
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

function summarizeWorkflow(workflow: WorkflowDefinition): WorkflowSummary {
  return {
    name: workflow.meta.name,
    description: workflow.meta.description,
    whenToUse: workflow.meta.whenToUse,
    argumentHint: workflow.meta.argumentHint,
    phases: workflow.meta.phases.map((phase) => ({ title: phase.title, detail: phase.detail })),
    path: workflow.path,
    source: workflow.source,
  };
}

function snapshotWorkflowRun(record: WorkflowRunRecord, logTail?: number): WorkflowRunSnapshot {
  return {
    runId: record.runId,
    workflowName: record.workflowName,
    description: record.description,
    phases: record.phases.map((phase) => ({ title: phase.title, detail: phase.detail })),
    status: record.status,
    phase: record.phase,
    phaseIndex: record.phaseIndex,
    agentCalls: record.agentCalls,
    logs: logTail !== undefined ? record.logs.slice(-logTail) : [...record.logs],
    error: record.error,
    resultJson: record.resultJson,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    taskId: record.taskId,
    scriptPath: record.scriptPath,
    source: record.source,
    args: record.args,
  };
}

function isUntitled(title: unknown): boolean {
  return typeof title !== 'string' || title.trim().length === 0 || title === 'New Session';
}

function hasCustomTitle(metadata: SessionMeta): boolean {
  if (metadata.isCustomTitle) return true;
  return typeof (metadata as SessionMeta & { customTitle?: unknown }).customTitle === 'string';
}
