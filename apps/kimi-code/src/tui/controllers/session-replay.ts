import type {
  AgentReplayRecord,
  BackgroundTaskInfo,
  ContextMessage,
  PermissionMode,
  PromptOrigin,
  ResumedAgentState,
  Session,
  ToolCall,
} from '@moonshot-ai/kimi-code-sdk';

import { ToolCallComponent } from '../components/messages/tool-call';
import type { TodoItem } from '../components/chrome/todo-panel';
import type {
  AppState,
  BackgroundAgentMetadata,
  ToolCallBlockData,
  ToolResultBlockData,
  TranscriptEntry,
} from '../types';
import { formatErrorMessage, isTodoItemShape } from '../utils/event-payload';
import { formatBackgroundAgentTranscript } from '../utils/background-agent-status';
import { formatBackgroundTaskTranscript } from '../utils/background-task-status';
import {
  appStateFromResumeAgent,
  backgroundOrigin,
  collectReplayMessageContent,
  contentPartsToText,
  countActiveBackgroundTasks,
  createReplayRenderContext,
  formatHookResultMessageForTranscript,
  isTerminalBackgroundTask,
  limitReplayRecordsByTurn,
  REPLAY_TURN_LIMIT,
  replayBackgroundProjection,
  replayEntry,
  skillActivationFromOrigin,
  toolCallFromReplayMessage,
  toolResultOutput,
  type ReplayRenderContext,
  type SkillActivationProjection,
} from '../utils/message-replay';
import type { StreamingUIController } from './streaming-ui';
import type { TUIState } from '../kimi-tui';

export interface SessionReplayHost {
  state: TUIState;
  readonly streamingUI: StreamingUIController;
  setAppState(patch: Partial<AppState>): void;
  showError(msg: string): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
}

export class SessionReplayRenderer {
  constructor(private readonly host: SessionReplayHost) {}

  async hydrateFromReplay(session: Session): Promise<boolean> {
    this.host.setAppState({ isReplaying: true });
    try {
      const main = session.getResumeState()?.agents['main'];
      if (main === undefined) {
        this.host.showError('Session history is unavailable for this session.');
        return false;
      }

      this.hydrateSnapshot(main);
      this.renderRecords(main);
      return true;
    } catch (error) {
      const message = formatErrorMessage(error);
      this.host.showError(`Failed to replay session history: ${message}`);
      return false;
    } finally {
      this.host.setAppState({ isReplaying: false });
    }
  }

  // ---------------------------------------------------------------------------
  // Snapshot hydration
  // ---------------------------------------------------------------------------

  private hydrateSnapshot(agent: ResumedAgentState): void {
    this.host.setAppState(appStateFromResumeAgent(agent));
    this.hydrateTodoPanel(agent);
    this.hydrateBackgroundState(agent);
  }

  private hydrateTodoPanel(agent: ResumedAgentState): void {
    const rawTodos = agent.toolStore?.['todo'];
    if (!Array.isArray(rawTodos)) {
      this.host.streamingUI.setTodoList([]);
      return;
    }

    const todos = rawTodos
      .filter((todo): todo is TodoItem => isTodoItemShape(todo))
      .map((todo) => ({ title: todo.title, status: todo.status }));
    if (todos.length > 0 && todos.every((todo) => todo.status === 'done')) {
      this.host.streamingUI.setTodoList([]);
      return;
    }

    this.host.streamingUI.setTodoList(todos);
  }

  private hydrateBackgroundState(agent: ResumedAgentState): void {
    const { state } = this.host;
    const projection = replayBackgroundProjection(agent.background);
    state.backgroundAgents = new Set(projection.backgroundAgents);
    state.backgroundAgentMetadata = new Map(projection.backgroundAgentMetadata);
    state.backgroundTasks = new Map<string, BackgroundTaskInfo>(
      agent.background.map((info) => [info.taskId, info]),
    );
    state.backgroundTaskTranscriptedTerminal.clear();
    for (const info of agent.background) {
      if (isTerminalBackgroundTask(info)) {
        state.backgroundTaskTranscriptedTerminal.add(info.taskId);
      }
    }
    state.footer.setBackgroundCounts(countActiveBackgroundTasks(state.backgroundTasks));
    state.ui.requestRender();
  }

  // ---------------------------------------------------------------------------
  // Record rendering
  // ---------------------------------------------------------------------------

  private renderRecords(agent: ResumedAgentState): void {
    const context = createReplayRenderContext();
    for (const record of limitReplayRecordsByTurn(agent.replay, REPLAY_TURN_LIMIT)) {
      this.renderRecord(context, record);
    }
    this.flushAssistant(context);
    this.cleanupRuntime(context);
  }

  private renderRecord(context: ReplayRenderContext, record: AgentReplayRecord): void {
    switch (record.type) {
      case 'message':
        this.renderMessage(context, record.message);
        return;
      case 'plan_updated':
        this.flushAssistant(context);
        if (!record.enabled && context.suppressNextPlanModeOffNotice) {
          context.suppressNextPlanModeOffNotice = false;
          return;
        }
        context.suppressNextPlanModeOffNotice = false;
        this.host.appendTranscriptEntry(
          replayEntry(context, 'status', `Plan mode: ${record.enabled ? 'ON' : 'OFF'}`, 'notice'),
        );
        return;
      case 'permission_updated':
        this.flushAssistant(context);
        this.renderPermissionUpdate(context, record.mode);
        return;
      case 'approval_result':
        this.flushAssistant(context);
        this.renderApprovalResult(context, record.record);
        return;
      case 'config_updated':
        return;
    }
  }

  private renderMessage(context: ReplayRenderContext, message: ContextMessage): void {
    switch (message.role) {
      case 'user':
        this.renderUserMessage(context, message);
        return;
      case 'assistant':
        if (message.origin?.kind === 'hook_result') {
          this.renderHookResult(context, message);
          this.renderToolCalls(context, message.toolCalls);
          return;
        }
        collectReplayMessageContent(context.assistant, message.content);
        this.flushAssistant(context);
        this.renderToolCalls(context, message.toolCalls);
        return;
      case 'tool':
        this.flushAssistant(context);
        this.renderToolResult(context, message);
        return;
      case 'system':
        return;
      default:
        return;
    }
  }

  private renderUserMessage(context: ReplayRenderContext, message: ContextMessage): void {
    const origin = backgroundOrigin(message);
    if (origin !== undefined) {
      this.flushAssistant(context);
      this.renderBackgroundTaskNotification(context, origin);
      return;
    }
    if (message.origin?.kind === 'hook_result') {
      this.renderHookResult(context, message);
      return;
    }
    if (message.origin?.kind === 'injection') {
      return;
    }

    this.flushAssistant(context);
    const skill = skillActivationFromOrigin(message.origin);
    if (skill !== undefined) {
      this.renderSkillActivation(context, skill);
      if (message.origin?.kind === 'skill_activation' && message.origin.trigger === 'user-slash') {
        this.advanceTurn(context);
      }
      return;
    }

    this.advanceTurn(context);
    this.host.appendTranscriptEntry(
      replayEntry(context, 'user', contentPartsToText(message.content), 'plain'),
    );
  }

  private renderToolCalls(context: ReplayRenderContext, toolCalls: readonly ToolCall[]): void {
    if (toolCalls.length === 0) return;
    const { state, streamingUI } = this.host;
    context.stepIndex += 1;
    this.applyStepContext(context);
    for (const rawToolCall of toolCalls) {
      const toolCall = toolCallFromReplayMessage(rawToolCall, context);
      if (toolCall === undefined) continue;
      context.toolCalls.set(toolCall.id, toolCall);
      state.activeToolCalls.set(toolCall.id, toolCall);
      streamingUI.onToolCallStart(toolCall);
    }
  }

  private renderToolResult(context: ReplayRenderContext, message: ContextMessage): void {
    const toolCallId = message.toolCallId;
    if (toolCallId === undefined) return;
    const call = context.toolCalls.get(toolCallId);
    if (call === undefined) return;

    const result: ToolResultBlockData = {
      tool_call_id: toolCallId,
      output: toolResultOutput(message.content),
      is_error: message.isError,
    };
    call.result = result;
    this.applyStepContext(context);
    this.host.streamingUI.onToolCallEnd(toolCallId, result);
    this.host.state.activeToolCalls.delete(toolCallId);
    context.completedToolCallIds.add(toolCallId);
  }

  private advanceTurn(context: ReplayRenderContext): void {
    context.turnIndex += 1;
    context.stepIndex = 0;
    context.currentTurnId = `replay:${String(context.turnIndex)}`;
    this.applyStepContext(context);
  }

  private applyStepContext(context: ReplayRenderContext): void {
    this.host.state.currentTurnId = context.currentTurnId;
    this.host.state.currentStep = context.stepIndex;
  }

  private flushAssistant(context: ReplayRenderContext): void {
    const { state, streamingUI } = this.host;
    const thinking = context.assistant.thinking.join('');
    const text = context.assistant.text.join('');
    context.assistant = { thinking: [], text: [] };
    this.applyStepContext(context);

    if (thinking.length > 0) {
      streamingUI.onThinkingUpdate(thinking);
      streamingUI.onThinkingEnd();
    }
    if (text.length > 0) {
      state.assistantStreamActive = true;
      streamingUI.onStreamingTextStart();
      streamingUI.onStreamingTextUpdate(text);
      streamingUI.onStreamingTextEnd();
      state.assistantStreamActive = false;
      state.assistantDraft = '';
    }
  }

  private cleanupRuntime(context: ReplayRenderContext): void {
    const { state, streamingUI } = this.host;
    this.flushAssistant(context);
    state.activeToolCalls.clear();
    for (const toolCallId of context.completedToolCallIds) {
      state.pendingToolComponents.delete(toolCallId);
    }
    state.pendingAgentGroup = null;
    state.pendingReadGroup = null;
    state.currentTurnId = undefined;
    state.currentStep = 0;
    state.streamingToolCallArguments.clear();
    streamingUI.pendingToolCallFlushIds.clear();
    state.ui.requestRender();
  }

  // ---------------------------------------------------------------------------
  // Special content renderers
  // ---------------------------------------------------------------------------

  private renderSkillActivation(
    context: ReplayRenderContext,
    skill: SkillActivationProjection,
  ): void {
    const { state } = this.host;
    if (context.skillActivationIds.has(skill.activationId)) return;
    if (state.renderedSkillActivationIds.has(skill.activationId)) return;
    context.skillActivationIds.add(skill.activationId);
    state.renderedSkillActivationIds.add(skill.activationId);
    this.host.appendTranscriptEntry({
      ...replayEntry(context, 'skill_activation', `Activated skill: ${skill.skillName}`, 'plain'),
      skillActivationId: skill.activationId,
      skillName: skill.skillName,
      skillArgs: skill.skillArgs,
    });
  }

  private renderHookResult(context: ReplayRenderContext, message: ContextMessage): void {
    if (message.origin?.kind !== 'hook_result') return;
    this.flushAssistant(context);
    this.host.appendTranscriptEntry(
      replayEntry(
        context,
        'assistant',
        formatHookResultMessageForTranscript(
          contentPartsToText(message.content),
          message.origin.event,
          message.origin.blocked === true,
        ),
        'markdown',
      ),
    );
  }

  private renderPermissionUpdate(context: ReplayRenderContext, mode: PermissionMode): void {
    if (mode === 'yolo') {
      this.host.appendTranscriptEntry(
        replayEntry(context, 'status', 'YOLO mode: ON', 'notice', {
          detail: 'All actions will be approved automatically. Use with caution.',
        }),
      );
      return;
    }
    this.host.appendTranscriptEntry(
      replayEntry(
        context,
        'status',
        mode === 'manual' ? 'YOLO mode: OFF' : `Permission mode: ${mode}`,
        'notice',
      ),
    );
  }

  private renderApprovalResult(
    context: ReplayRenderContext,
    record: Extract<AgentReplayRecord, { type: 'approval_result' }>['record'],
  ): void {
    if (record.toolName === 'ExitPlanMode') {
      this.renderPlanReviewResult(context, record);
      return;
    }

    const { result } = record;
    const parts: string[] = [];
    switch (result.decision) {
      case 'approved':
        parts.push(result.scope === 'session' ? 'Approved for session' : 'Approved');
        break;
      case 'rejected':
        parts.push('Rejected');
        break;
      case 'cancelled':
        parts.push('Cancelled');
        break;
    }
    parts.push(`: ${record.action}`);
    if (result.feedback !== undefined && result.feedback.length > 0) {
      parts.push(` — "${result.feedback}"`);
    }
    this.host.appendTranscriptEntry(replayEntry(context, 'status', parts.join(''), 'notice'));
  }

  private renderPlanReviewResult(
    context: ReplayRenderContext,
    record: Extract<AgentReplayRecord, { type: 'approval_result' }>['record'],
  ): void {
    const { result } = record;
    if (result.decision === 'approved') {
      context.suppressNextPlanModeOffNotice = true;
      return;
    }
    this.removeToolCall(record.toolCallId);

    let content: string;
    switch (result.decision) {
      case 'rejected':
        content =
          result.selectedLabel === 'Revise' ? 'Plan sent back for revision' : 'Plan review rejected';
        break;
      case 'cancelled':
        content = 'Plan review cancelled';
        break;
    }
    const detail =
      result.feedback !== undefined && result.feedback.length > 0
        ? `Feedback: ${result.feedback}`
        : undefined;
    this.host.appendTranscriptEntry(replayEntry(context, 'status', content, 'notice', { detail }));
  }

  private removeToolCall(toolCallId: string): void {
    const { state } = this.host;
    state.activeToolCalls.delete(toolCallId);
    state.pendingToolComponents.delete(toolCallId);
    const index = state.transcriptEntries.findIndex(
      (entry) => entry.toolCallData?.id === toolCallId,
    );
    if (index >= 0) state.transcriptEntries.splice(index, 1);
    const children = state.transcriptContainer.children;
    const childIndex = children.findIndex(
      (child) => child instanceof ToolCallComponent && child.toolCallView.id === toolCallId,
    );
    if (childIndex >= 0) {
      children.splice(childIndex, 1);
      state.transcriptContainer.invalidate();
    }
  }

  private renderBackgroundTaskNotification(
    context: ReplayRenderContext,
    origin: Extract<PromptOrigin, { kind: 'background_task' }>,
  ): void {
    const { state } = this.host;
    const task = state.backgroundTasks.get(origin.taskId);
    if (task !== undefined && task.taskId.startsWith('bash-')) {
      const status = formatBackgroundTaskTranscript({ ...task, status: origin.status });
      this.host.appendTranscriptEntry({
        ...replayEntry(context, 'status', status.headline, 'plain'),
        detail: status.detail,
        backgroundAgentStatus: status,
      });
      state.backgroundTaskTranscriptedTerminal.add(origin.taskId);
      return;
    }

    const meta: BackgroundAgentMetadata = {
      agentId: origin.taskId,
      parentToolCallId: origin.taskId,
      description: task?.description,
    };
    let status = formatBackgroundAgentTranscript(
      origin.status === 'completed' ? 'completed' : 'failed',
      meta,
    );
    if (origin.status === 'lost') {
      status = {
        ...status,
        headline: status.headline.replace(' failed in background', ' lost in background'),
      };
    } else if (origin.status === 'killed') {
      status = {
        ...status,
        headline: status.headline.replace(' failed in background', ' stopped'),
      };
    }
    this.host.appendTranscriptEntry({
      ...replayEntry(context, 'status', status.headline, 'plain'),
      detail: status.detail,
      backgroundAgentStatus: status,
    });
    state.backgroundAgents.delete(meta.agentId);
    state.backgroundAgentMetadata.delete(meta.agentId);
  }
}
