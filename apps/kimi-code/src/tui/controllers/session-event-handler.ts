import chalk from 'chalk';
import type { Component, Focusable } from '@earendil-works/pi-tui';
import type {
  AgentStatusUpdatedEvent,
  AssistantDeltaEvent,
  BackgroundTaskInfo,
  BackgroundTaskStartedEvent,
  BackgroundTaskTerminatedEvent,
  CompactionCancelledEvent,
  CompactionCompletedEvent,
  CompactionStartedEvent,
  CronFiredEvent,
  ErrorEvent,
  Event,
  GoalUpdatedEvent,
  HookResultEvent,
  Session,
  SessionMetaUpdatedEvent,
  SkillActivatedEvent,
  SubagentCompletedEvent,
  SubagentFailedEvent,
  SubagentSpawnedEvent,
  ThinkingDeltaEvent,
  ToolCallDeltaEvent,
  ToolCallStartedEvent,
  ToolProgressEvent,
  ToolResultEvent,
  TurnEndedEvent,
  TurnStartedEvent,
  TurnStepCompletedEvent,
  TurnStepInterruptedEvent,
  TurnStepStartedEvent,
  WarningEvent,
} from '@moonshot-ai/kimi-code-sdk';
import { buildGoalCompletionMessage } from '@moonshot-ai/kimi-code-sdk';

import { MoonLoader } from '../components/chrome/moon-loader';
import { buildGoalMarker } from '../components/messages/goal-markers';
import { StatusMessageComponent } from '../components/messages/status-message';
import {
  MAIN_AGENT_ID,
  OAUTH_LOGIN_REQUIRED_CODE,
  OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE,
} from '../constant/kimi-tui';
import {
  argsRecord,
  formatErrorPayload,
  formatErrorMessage,
  isTodoItemShape,
  serializeToolResultOutput,
  stringValue,
} from '../utils/event-payload';
import {
  readGoalQueue,
  removeGoalQueueItem,
  restoreGoalQueueItem,
  type UpcomingGoal,
} from '../goal-queue-store';
import { formatBackgroundAgentTranscript } from '../utils/background-agent-status';
import { formatBackgroundTaskTranscript } from '../utils/background-task-status';
import { formatHookResultMarkdown, formatHookResultPlain } from '../utils/hook-result-format';
import { McpOAuthAuthorizationUrlOpener } from '../utils/mcp-oauth';
import {
  formatMcpStartupStatusSummary,
  mcpServerStatusKey,
  type McpServerStatusSnapshot,
  selectMcpStartupStatusRows,
} from '../utils/mcp-server-status';
import { openUrl } from '#/utils/open-url';
import { errorReportHintLine } from '../constant/feedback';
import { formatStepDebugTiming } from '#/utils/usage/debug-timing';
import { nextTranscriptId } from '../utils/transcript-id';
import type { BtwPanelController } from './btw-panel';
import type { StreamingUIController } from './streaming-ui';
import type { TasksBrowserController } from './tasks-browser';
import type {
  AppState,
  BackgroundAgentMetadata,
  LivePaneState,
  QueuedMessage,
  ToolCallBlockData,
  ToolResultBlockData,
  TranscriptEntry,
} from '../types';
import type { TUIState } from '../tui-state';
import { createGoal as startGoalCommand } from '../commands/goal';

export interface SessionEventHost {
  state: TUIState;
  session: Session | undefined;
  aborted: boolean;
  sessionEventUnsubscribe: (() => void) | undefined;
  readonly streamingUI: StreamingUIController;

  requireSession(): Session;
  setAppState(patch: Partial<AppState>): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  resetLivePane(): void;
  showError(msg: string): void;
  showStatus(msg: string, color?: string): void;
  showNotice(title: string, detail?: string): void;
  track(event: string, props?: Record<string, unknown>): void;
  mountEditorReplacement(panel: Component & Focusable): void;
  restoreEditor(): void;
  restoreInputText(text: string): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  sendNormalUserInput(text: string): void;
  updateTerminalTitle(): void;
  sendQueuedMessage(session: Session, item: QueuedMessage): void;
  shiftQueuedMessage(): QueuedMessage | undefined;
  readonly btwPanelController: BtwPanelController;
  readonly tasksBrowserController: TasksBrowserController;
}

export class SessionEventHandler {
  constructor(private readonly host: SessionEventHost) {}

  // Runtime state – owned by this handler, reset between sessions.
  backgroundAgentMetadata: Map<string, BackgroundAgentMetadata> = new Map();
  backgroundTasks: Map<string, BackgroundTaskInfo> = new Map();
  backgroundTaskTranscriptedTerminal: Set<string> = new Set();
  subagentInfo: Map<string, { parentToolCallId: string; name: string }> = new Map();
  renderedSkillActivationIds: Set<string> = new Set();
  renderedMcpServerStatusKeys: Map<string, string> = new Map();
  mcpServerStatusSpinners: Map<string, MoonLoader> = new Map();
  mcpServers: Map<string, McpServerStatusSnapshot> = new Map();
  private goalCompletionAwaitingClear = false;
  private goalCompletionTurnEnded = false;
  private queuedGoalPromotionPending = false;
  private queuedGoalPromotionInFlight = false;
  private queuedGoalPromotionTimer: ReturnType<typeof setTimeout> | undefined;

  resetRuntimeState(): void {
    this.backgroundAgentMetadata.clear();
    this.backgroundTasks.clear();
    this.backgroundTaskTranscriptedTerminal.clear();
    this.subagentInfo.clear();
    this.renderedSkillActivationIds.clear();
    this.renderedMcpServerStatusKeys.clear();
    this.mcpServers.clear();
    this.goalCompletionAwaitingClear = false;
    this.goalCompletionTurnEnded = false;
    this.queuedGoalPromotionPending = false;
    this.queuedGoalPromotionInFlight = false;
    this.clearQueuedGoalPromotionTimer();
    this.stopAllMcpServerStatusSpinners();
  }

  startSubscription(): void {
    const { host } = this;
    const session = host.requireSession();
    const sendQueued = (item: QueuedMessage): void => {
      host.sendQueuedMessage(session, item);
    };
    host.sessionEventUnsubscribe?.();
    const mcpOAuthOpener = new McpOAuthAuthorizationUrlOpener(openUrl);
    const { sessionId } = host.state.appState;
    host.sessionEventUnsubscribe = session.onEvent((event) => {
      if (host.aborted) return;
      if (event.sessionId !== sessionId) return;
      if (event.type === 'tool.progress') {
        mcpOAuthOpener.handleToolProgress(event);
      }
      this.handleEvent(event, sendQueued);
    });
    void this.syncMcpServerStatusSnapshot(session);
  }

  async syncMcpServerStatusSnapshot(session: Session): Promise<void> {
    const { host } = this;
    let servers: readonly McpServerStatusSnapshot[];
    try {
      servers = await session.listMcpServers();
    } catch (error) {
      if (host.session !== session || host.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      host.showError(`Failed to sync MCP server status: ${message}`);
      return;
    }
    if (host.session !== session || host.state.appState.sessionId !== session.id) return;

    const visible = selectMcpStartupStatusRows(servers);
    const visibleNames = new Set(visible.map((server) => server.name));
    for (const server of visible) {
      if (this.renderedMcpServerStatusKeys.has(server.name)) continue;
      this.renderMcpServerStatus(server);
    }

    this.mcpServers.clear();
    for (const server of servers) {
      this.mcpServers.set(server.name, server);
    }
    const hidden: McpServerStatusSnapshot[] = [];
    for (const server of servers) {
      if (visibleNames.has(server.name)) continue;
      if (this.renderedMcpServerStatusKeys.has(server.name)) continue;
      this.renderedMcpServerStatusKeys.set(server.name, mcpServerStatusKey(server));
      hidden.push(server);
    }
    const summary = formatMcpStartupStatusSummary(servers);
    host.setAppState({ mcpServersSummary: summary || null });
  }

  handleEvent(event: Event, sendQueued: (item: QueuedMessage) => void): void {
    if (this.routeSubagentEvent(event)) return;

    if ('turnId' in event && event.turnId !== undefined) {
      this.host.streamingUI.setTurnId(String(event.turnId));
    }

    switch (event.type) {
      case 'turn.started': this.handleTurnBegin(event); break;
      case 'turn.ended': this.handleTurnEnd(event, sendQueued); break;
      case 'turn.step.started': this.handleStepBegin(event); break;
      case 'turn.step.interrupted': this.handleStepInterrupted(event); break;
      case 'turn.step.completed': this.handleStepCompleted(event); break;
      case 'turn.step.retrying': break;
      case 'tool.progress': this.handleToolProgress(event); break;
      case 'assistant.delta': this.handleAssistantDelta(event); break;
      case 'hook.result': this.handleHookResult(event); break;
      case 'thinking.delta': this.handleThinkingDelta(event); break;
      case 'tool.call.started': this.handleToolCall(event); break;
      case 'tool.call.delta': this.handleToolCallDelta(event); break;
      case 'tool.result': this.handleToolResult(event); break;
      case 'agent.status.updated': this.handleStatusUpdate(event); break;
      case 'session.meta.updated': this.handleSessionMetaChanged(event); break;
      case 'goal.updated': this.handleGoalUpdated(event); break;
      case 'skill.activated': this.handleSkillActivated(event); break;
      case 'error': this.handleSessionError(event); break;
      case 'warning': this.handleSessionWarning(event); break;
      case 'compaction.started': this.handleCompactionBegin(event); break;
      case 'compaction.completed': this.handleCompactionEnd(event, sendQueued); break;
      case 'compaction.blocked': break;
      case 'compaction.cancelled': this.handleCompactionCancel(event, sendQueued); break;
      case 'subagent.spawned': this.handleSubagentSpawned(event); break;
      case 'subagent.completed': this.handleSubagentCompleted(event); break;
      case 'subagent.failed': this.handleSubagentFailed(event); break;
      case 'background.task.started':
      case 'background.task.terminated':
        this.handleBackgroundTaskEvent(event); break;
      case 'cron.fired': this.handleCronFired(event); break;
      case 'mcp.server.status': this.renderMcpServerStatus(event.server); break;
      case 'tool.list.updated': break;
      default: break;
    }
  }

  stopAllMcpServerStatusSpinners(): void {
    for (const spinner of this.mcpServerStatusSpinners.values()) {
      spinner.stop();
    }
    this.mcpServerStatusSpinners.clear();
  }

  // ---------------------------------------------------------------------------
  // Private handlers
  // ---------------------------------------------------------------------------

  private routeSubagentEvent(event: Event): boolean {
    const subagentId = event.agentId;
    if (subagentId === MAIN_AGENT_ID) return false;

    const { streamingUI } = this.host;
    if (this.host.btwPanelController.routeEvent(event)) return true;

    const info = this.subagentInfo.get(subagentId);
    if (info === undefined) return true;
    if (info.parentToolCallId.length === 0) return true;
    const { parentToolCallId } = info;
    const sourceName = info.name;
    const toolCall = streamingUI.getToolComponent(parentToolCallId);
    if (toolCall === undefined) return true;
    toolCall.setSubagentMeta(subagentId, sourceName);

    switch (event.type) {
      case 'hook.result':
        toolCall.appendSubagentText(formatHookResultPlain(event), 'text');
        return true;
      case 'assistant.delta':
        toolCall.appendSubagentText(event.delta, 'text');
        return true;
      case 'thinking.delta':
        toolCall.appendSubagentText(event.delta, 'thinking');
        return true;
      case 'tool.call.started':
        toolCall.appendSubToolCall({
          id: `${subagentId}:${event.toolCallId}`,
          name: event.name,
          args: argsRecord(event.args),
        });
        return true;
      case 'tool.call.delta':
        toolCall.appendSubToolCallDelta({
          id: `${subagentId}:${event.toolCallId}`,
          name: event.name,
          argumentsPart: event.argumentsPart ?? null,
        });
        return true;
      case 'tool.result':
        toolCall.finishSubToolCall({
          tool_call_id: `${subagentId}:${event.toolCallId}`,
          output: serializeToolResultOutput(event.output),
          is_error: event.isError,
        });
        return true;
      case 'agent.status.updated': {
        const usageObj = event.usage;
        const totalUsage = usageObj?.total ?? usageObj?.currentTurn;
        toolCall.updateSubagentMetrics({
          contextTokens: event.contextTokens,
          usage: totalUsage,
        });
        return true;
      }
      case 'background.task.started':
      case 'background.task.terminated':
      case 'compaction.blocked':
      case 'compaction.cancelled':
      case 'compaction.completed':
      case 'compaction.started':
      case 'cron.fired':
      case 'error':
      case 'warning':
      case 'goal.updated':
      case 'session.meta.updated':
      case 'skill.activated':
      case 'subagent.completed':
      case 'subagent.failed':
      case 'subagent.spawned':
      case 'tool.progress':
      case 'tool.list.updated':
      case 'mcp.server.status':
      case 'turn.ended':
      case 'turn.started':
      case 'turn.step.completed':
      case 'turn.step.interrupted':
      case 'turn.step.retrying':
      case 'turn.step.started':
        return true;
      default:
        return true;
    }
  }

  private handleTurnBegin(_event: TurnStartedEvent): void {
    void _event;
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.setStep(0);
    this.host.patchLivePane({
      mode: 'waiting',
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.host.setAppState({
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
  }

  private handleCronFired(event: CronFiredEvent): void {
    this.host.streamingUI.flushNow();
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'cron',
      turnId: this.host.streamingUI.getTurnContext().turnId,
      renderMode: 'plain',
      content: event.prompt,
      cronData: {
        jobId: event.origin.jobId,
        cron: event.origin.cron,
        recurring: event.origin.recurring,
        coalescedCount: event.origin.coalescedCount,
        stale: event.origin.stale,
      },
    });
  }

  private handleTurnEnd(_event: TurnEndedEvent, sendQueued: (item: QueuedMessage) => void): void {
    void _event;
    this.host.streamingUI.flushNow();
    const todos = this.host.state.todoPanel.getTodos();
    if (todos.length > 0 && todos.every((t) => t.status === 'done')) {
      this.host.streamingUI.setTodoList([]);
    }
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeTurn(sendQueued);
    this.goalCompletionTurnEnded = true;
    this.scheduleQueuedGoalPromotion();
  }

  private handleStepBegin(event: TurnStepStartedEvent): void {
    this.host.streamingUI.flushNow();
    this.host.streamingUI.setStep(event.step);
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers('waiting');
    this.host.patchLivePane({
      mode: 'waiting',
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.host.setAppState({
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
  }

  private handleStepCompleted(event: TurnStepCompletedEvent): void {
    this.host.streamingUI.flushNow();
    this.maybeShowDebugTiming(event);
    if (event.finishReason !== 'max_tokens') return;

    const truncatedCount = this.host.streamingUI.markStepTruncated(
      String(event.turnId),
      event.step,
    );

    const title =
      truncatedCount > 0
        ? 'Model hit max_tokens — tool call was truncated before it could run.'
        : 'Model hit max_tokens — no tool call was emitted.';
    const detail = this.isAnthropicSessionActive()
      ? 'If this limit is wrong for your model, set `max_output_size` on the model alias in your kimi-code config.'
      : undefined;
    this.host.showNotice(title, detail);
  }

  private maybeShowDebugTiming(event: TurnStepCompletedEvent): void {
    if (process.env['KIMI_CODE_DEBUG'] !== '1') return;
    const text = formatStepDebugTiming(event);
    if (text !== undefined) this.host.showStatus(text);
  }

  private isAnthropicSessionActive(): boolean {
    const { state } = this.host;
    const providerKey = state.appState.availableModels[state.appState.model]?.provider;
    if (providerKey === undefined) return false;
    return state.appState.availableProviders[providerKey]?.type === 'anthropic';
  }

  private handleStepInterrupted(event: TurnStepInterruptedEvent): void {
    this.host.streamingUI.flushNow();
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers('idle');
    const reason = event.reason;
    if (reason === 'error') return;
    if (reason === 'aborted' || reason === undefined || reason === '') {
      this.host.showStatus('Interrupted by user', this.host.state.theme.colors.error);
      return;
    }
    this.host.showError(
      reason === 'max_steps'
        ? 'reached per-turn step limit (max_steps)'
        : `step interrupted (${reason})`,
    );
  }

  private handleThinkingDelta(event: ThinkingDeltaEvent): void {
    const { state, streamingUI } = this.host;
    streamingUI.appendThinkingDelta(event.delta);
    this.host.patchLivePane({ mode: 'idle' });
    if (state.appState.streamingPhase !== 'thinking') {
      this.host.setAppState({ streamingPhase: 'thinking', streamingStartTime: Date.now() });
    }
    streamingUI.scheduleFlush();
  }

  private handleAssistantDelta(event: AssistantDeltaEvent): void {
    const { state, streamingUI } = this.host;
    if (streamingUI.hasThinkingDraft()) {
      streamingUI.flushThinkingToTranscript('idle');
    }

    streamingUI.appendAssistantDelta(event.delta);

    this.host.patchLivePane({
      mode: 'idle',
      pendingApproval: null,
      pendingQuestion: null,
    });
    if (state.appState.streamingPhase !== 'composing') {
      this.host.setAppState({ streamingPhase: 'composing', streamingStartTime: Date.now() });
    }
    streamingUI.scheduleFlush();
  }

  private handleHookResult(event: HookResultEvent): void {
    this.host.streamingUI.flushNow();
    if (this.host.streamingUI.hasThinkingDraft()) {
      this.host.streamingUI.flushThinkingToTranscript('idle');
    }
    this.host.streamingUI.finalizeAssistantStream();
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'assistant',
      turnId: String(event.turnId),
      renderMode: 'markdown',
      content: formatHookResultMarkdown(event),
    });
    this.host.patchLivePane({
      mode: 'idle',
      pendingApproval: null,
      pendingQuestion: null,
    });
  }

  private handleToolCall(event: ToolCallStartedEvent): void {
    const { streamingUI } = this.host;
    streamingUI.flushNow();
    const { turnId, step } = streamingUI.getTurnContext();
    const toolCall: ToolCallBlockData = {
      id: event.toolCallId,
      name: event.name,
      args: argsRecord(event.args),
      description: event.description,
      display: event.display,
      step,
      turnId,
    };
    streamingUI.registerToolCall(toolCall);
    this.host.patchLivePane({
      mode: 'tool',
      pendingApproval: null,
      pendingQuestion: null,
    });
  }

  private handleToolCallDelta(event: ToolCallDeltaEvent): void {
    if (event.toolCallId.length === 0) return;
    const { state, streamingUI } = this.host;
    streamingUI.accumulateToolCallDelta(event.toolCallId, event.name, event.argumentsPart);

    this.host.patchLivePane({
      mode: 'tool',
      pendingApproval: null,
      pendingQuestion: null,
    });
    if (state.appState.streamingPhase !== 'composing') {
      this.host.setAppState({ streamingPhase: 'composing', streamingStartTime: Date.now() });
    }
    streamingUI.scheduleFlush();
  }

  private handleToolProgress(event: ToolProgressEvent): void {
    if (event.update.kind !== 'status') return;
    const text = event.update.text;
    if (text === undefined || text.length === 0) return;
    const tc = this.host.streamingUI.getToolComponent(event.toolCallId);
    if (tc === undefined) return;
    tc.appendProgress(text);
  }

  private handleToolResult(event: ToolResultEvent): void {
    const { streamingUI } = this.host;
    streamingUI.flushNow();
    const resultData: ToolResultBlockData = {
      tool_call_id: event.toolCallId,
      output: serializeToolResultOutput(event.output),
      is_error: event.isError,
      synthetic: event.synthetic,
    };
    const matchedCall = streamingUI.completeToolResult(event.toolCallId, resultData);
    if (matchedCall !== undefined && matchedCall.name === 'TodoList' && !event.isError) {
      const rawTodos = (matchedCall.args as { todos?: unknown }).todos;
      if (Array.isArray(rawTodos)) {
        const sanitized = rawTodos
          .filter((todo): todo is { title: string; status: 'pending' | 'in_progress' | 'done' } =>
            isTodoItemShape(todo),
          )
          .map((t) => ({ title: t.title, status: t.status }));
        streamingUI.setTodoList(sanitized);
      }
    }
    this.host.patchLivePane({ mode: 'waiting' });
  }

  private handleStatusUpdate(event: AgentStatusUpdatedEvent): void {
    const patch: Partial<AppState> = {};
    if (event.contextUsage !== undefined) patch.contextUsage = event.contextUsage;
    if (event.contextTokens !== undefined) patch.contextTokens = event.contextTokens;
    if (event.maxContextTokens !== undefined) patch.maxContextTokens = event.maxContextTokens;
    if (event.planMode !== undefined) patch.planMode = event.planMode;
    if (event.permission !== undefined) {
      patch.permissionMode = event.permission;
    }
    if (event.model !== undefined) patch.model = event.model;
    if (Object.keys(patch).length > 0) this.host.setAppState(patch);
  }

  private handleGoalUpdated(event: GoalUpdatedEvent): void {
    this.host.setAppState({ goal: event.snapshot });
    if (event.snapshot === null && this.goalCompletionAwaitingClear) {
      this.goalCompletionAwaitingClear = false;
      this.queuedGoalPromotionPending = true;
      this.scheduleQueuedGoalPromotion();
    }
    const change = event.change;
    if (change === undefined) return;
    const { state } = this.host;

    // Completion -> the box disappears (snapshot cleared on the follow-up null
    // update) and a deterministic completion message lands in the transcript.
    // The same text is appended to the conversation by the continuation
    // controller, so it persists and renders identically on resume.
    if (change.kind === 'completion' && event.snapshot !== null) {
      this.goalCompletionAwaitingClear = true;
      this.goalCompletionTurnEnded = false;
      this.host.appendTranscriptEntry({
        id: nextTranscriptId(),
        kind: 'assistant',
        renderMode: 'markdown',
        content: buildGoalCompletionMessage(event.snapshot),
      });
      state.ui.requestRender();
      return;
    }

    // Lifecycle change (pause / resume / blocked) -> a low-profile,
    // ctrl+o-expandable marker.
    if (change.kind === 'lifecycle' && change.status === 'blocked') {
      void this.notifyQueuedGoalWaitingOnBlocked();
    }
    const marker = buildGoalMarker(change, state.theme.colors, state.toolOutputExpanded);
    if (marker !== null) {
      state.transcriptContainer.addChild(marker);
      state.ui.requestRender();
    }
  }

  private scheduleQueuedGoalPromotion(): void {
    if (!this.queuedGoalPromotionPending || !this.goalCompletionTurnEnded) return;
    if (this.queuedGoalPromotionInFlight) return;
    if (this.queuedGoalPromotionTimer !== undefined) return;
    this.queuedGoalPromotionTimer = setTimeout(() => {
      this.queuedGoalPromotionTimer = undefined;
      if (!this.queuedGoalPromotionPending || !this.goalCompletionTurnEnded) return;
      if (this.queuedGoalPromotionInFlight) return;
      if (!this.isReadyForQueuedGoalPromotion()) {
        return;
      }
      this.queuedGoalPromotionInFlight = true;
      void this.promoteNextQueuedGoal()
        .then((complete) => {
          if (complete) {
            this.queuedGoalPromotionPending = false;
            this.goalCompletionTurnEnded = false;
            return;
          }
          this.goalCompletionTurnEnded = false;
        })
        .finally(() => {
          this.queuedGoalPromotionInFlight = false;
          this.scheduleQueuedGoalPromotion();
        });
    }, 0);
  }

  private clearQueuedGoalPromotionTimer(): void {
    if (this.queuedGoalPromotionTimer === undefined) return;
    clearTimeout(this.queuedGoalPromotionTimer);
    this.queuedGoalPromotionTimer = undefined;
  }

  requestQueuedGoalPromotion(): void {
    this.queuedGoalPromotionPending = true;
    this.goalCompletionTurnEnded = true;
    this.scheduleQueuedGoalPromotion();
  }

  retryQueuedGoalPromotion(): void {
    this.scheduleQueuedGoalPromotion();
  }

  private isReadyForQueuedGoalPromotion(session?: Session): boolean {
    return (
      (session === undefined || this.host.session === session) &&
      !this.host.aborted &&
      this.host.state.appState.streamingPhase === 'idle' &&
      this.host.state.queuedMessages.length === 0
    );
  }

  private async promoteNextQueuedGoal(): Promise<boolean> {
    const { host } = this;
    const session = host.session;
    if (session === undefined || host.aborted) return true;

    let queue;
    try {
      queue = await readGoalQueue(session);
    } catch (error) {
      host.showError(`Failed to read upcoming goals: ${formatErrorMessage(error)}`);
      return false;
    }
    if (host.session !== session || host.aborted) return true;

    const next = queue.goals[0];
    if (next === undefined) return true;

    if (!this.isReadyForQueuedGoalPromotion(session)) return false;

    const started = await startGoalCommand(
      host,
      { kind: 'create', objective: next.objective, replace: false },
      next.objective,
      {
        beforeSend: async () => {
          if (!this.isReadyForQueuedGoalPromotion(session)) {
            await this.cancelStartedQueuedGoal(session);
            return false;
          }
          try {
            await removeGoalQueueItem(session, { goalId: next.id });
          } catch (error) {
            host.showError(
              `Queued goal started, but could not be removed from the queue: ${formatErrorMessage(error)}`,
            );
            await this.cancelStartedQueuedGoal(session);
            return false;
          }
          if (this.isReadyForQueuedGoalPromotion(session)) {
            return true;
          }
          await this.restoreAndCancelStartedQueuedGoal(session, next);
          return false;
        },
        sendInput: (objective) => {
          host.sendQueuedMessage(session, { text: objective });
        },
      },
    );
    return started || host.session !== session || host.aborted;
  }

  private async restoreAndCancelStartedQueuedGoal(
    session: Session,
    goal: UpcomingGoal,
  ): Promise<void> {
    try {
      await restoreGoalQueueItem(session, goal);
    } catch (error) {
      this.host.showError(`Queued goal could not be restored: ${formatErrorMessage(error)}`);
    }
    await this.cancelStartedQueuedGoal(session);
  }

  private async cancelStartedQueuedGoal(session: Session): Promise<void> {
    try {
      await session.cancelGoal();
    } catch (error) {
      this.host.showError(`Queued goal could not be cancelled: ${formatErrorMessage(error)}`);
    }
  }

  private async notifyQueuedGoalWaitingOnBlocked(): Promise<void> {
    const { host } = this;
    const session = host.session;
    if (session === undefined || host.aborted) return;

    let hasQueuedGoal = false;
    try {
      const queue = await readGoalQueue(session);
      hasQueuedGoal = queue.goals.length > 0;
    } catch {
      return;
    }
    if (!hasQueuedGoal || host.session !== session || host.aborted) return;

    host.showNotice(
      'Goal blocked.',
      'The next queued goal will start only after this goal is complete.',
    );
  }

  private handleSessionMetaChanged(event: SessionMetaUpdatedEvent): void {
    const title = event.title ?? stringValue(event.patch?.['title']);
    if (title !== undefined) {
      this.host.setAppState({ sessionTitle: title });
      this.host.updateTerminalTitle();
    }
  }

  private handleSessionError(event: ErrorEvent): void {
    this.host.streamingUI.flushNow();
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers('idle');
    if (event.code === OAUTH_LOGIN_REQUIRED_CODE) {
      this.host.showError(OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE);
      return;
    }
    this.host.showError(formatErrorPayload(event));
    const sessionId = this.host.state.appState.sessionId;
    if (sessionId.length > 0) {
      this.host.showStatus(errorReportHintLine());
    }
  }

  private handleSessionWarning(event: WarningEvent): void {
    this.host.showStatus(`Warning: ${event.message}`, this.host.state.theme.colors.warning);
  }

  private renderMcpServerStatus(server: McpServerStatusSnapshot): void {
    const { state } = this.host;
    const key = mcpServerStatusKey(server);
    if (this.renderedMcpServerStatusKeys.get(server.name) === key) return;
    this.renderedMcpServerStatusKeys.set(server.name, key);
    this.mcpServers.set(server.name, server);
    const summary = formatMcpStartupStatusSummary([...this.mcpServers.values()]);
    this.host.setAppState({ mcpServersSummary: summary || null });

    const colors = state.theme.colors;
    switch (server.status) {
      case 'connected': {
        const toolStr = `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`;
        const message = `MCP server "${server.name}" connected · ${toolStr} (${server.transport})`;
        this.finalizeMcpServerStatusRow(server.name, message, colors.success);
        return;
      }
      case 'failed': {
        const message = `MCP server "${server.name}" failed${server.error !== undefined ? `: ${server.error}` : ''}`;
        this.finalizeMcpServerStatusRow(server.name, message, colors.error);
        return;
      }
      case 'needs-auth': {
        const message = `MCP server "${server.name}" needs OAuth — run /mcp-config login ${server.name}`;
        this.finalizeMcpServerStatusRow(server.name, message, colors.warning);
        return;
      }
      case 'disabled':
        this.finalizeMcpServerStatusRow(
          server.name,
          `MCP server "${server.name}" disabled`,
          colors.textMuted,
        );
        return;
      case 'pending':
        this.showMcpServerStatusSpinner(server.name);
        return;
    }
  }

  private showMcpServerStatusSpinner(name: string): void {
    const { state } = this.host;
    const label = `MCP server "${name}" connecting…`;
    const existing = this.mcpServerStatusSpinners.get(name);
    if (existing !== undefined) {
      existing.setLabel(label);
      return;
    }
    const tint = (s: string): string => chalk.hex(state.theme.colors.textMuted)(s);
    const spinner = new MoonLoader(state.ui, 'braille', tint, label);
    state.transcriptContainer.addChild(spinner);
    this.mcpServerStatusSpinners.set(name, spinner);
    state.ui.requestRender();
  }

  private finalizeMcpServerStatusRow(name: string, message: string, color: string): void {
    const { state } = this.host;
    const spinner = this.mcpServerStatusSpinners.get(name);
    if (spinner === undefined) {
      this.host.showStatus(message, color);
      return;
    }
    spinner.stop();
    const status = new StatusMessageComponent(message, state.theme.colors, color);
    const children = state.transcriptContainer.children;
    const idx = children.indexOf(spinner);
    if (idx >= 0) {
      children[idx] = status;
      state.transcriptContainer.invalidate();
    } else {
      state.transcriptContainer.addChild(status);
    }
    this.mcpServerStatusSpinners.delete(name);
    state.ui.requestRender();
  }

  private handleSkillActivated(event: SkillActivatedEvent): void {
    if (this.renderedSkillActivationIds.has(event.activationId)) return;
    this.renderedSkillActivationIds.add(event.activationId);
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'skill_activation',
      turnId: undefined,
      renderMode: 'plain',
      content: `Activated skill: ${event.skillName}`,
      skillActivationId: event.activationId,
      skillName: event.skillName,
      skillArgs: event.skillArgs,
      skillTrigger: event.trigger,
    });
  }

  private handleCompactionBegin(event: CompactionStartedEvent): void {
    this.host.streamingUI.finalizeLiveTextBuffers('waiting');
    this.host.setAppState({
      isCompacting: true,
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
    this.host.streamingUI.beginCompaction(event.instruction);
  }

  private handleCompactionEnd(
    event: CompactionCompletedEvent,
    sendQueued: (item: QueuedMessage) => void,
  ): void {
    this.host.streamingUI.endCompaction(event.result.tokensBefore, event.result.tokensAfter);
    this.finishCompaction(sendQueued);
  }

  private handleCompactionCancel(
    _event: CompactionCancelledEvent,
    sendQueued: (item: QueuedMessage) => void,
  ): void {
    this.host.streamingUI.cancelCompaction();
    this.finishCompaction(sendQueued);
  }

  private finishCompaction(sendQueued: (item: QueuedMessage) => void): void {
    const hasActiveTurn = this.host.streamingUI.hasActiveTurn();
    if (!hasActiveTurn) {
      this.host.setAppState({
        isCompacting: false,
        streamingPhase: 'idle',
      });
      this.host.resetLivePane();
      const next = this.host.shiftQueuedMessage();
      if (next !== undefined) {
        setTimeout(() => {
          sendQueued(next);
        }, 0);
      }
    } else {
      this.host.setAppState({ isCompacting: false });
    }
  }

  private handleSubagentSpawned(event: SubagentSpawnedEvent): void {
    const { streamingUI } = this.host;
    this.subagentInfo.set(event.subagentId, {
      parentToolCallId: event.parentToolCallId,
      name: event.subagentName,
    });

    if (event.runInBackground) {
      const meta = this.buildBackgroundAgentMetadata(event);
      this.backgroundAgentMetadata.set(event.subagentId, meta);
      this.appendBackgroundAgentEntry('started', meta);
      this.syncBackgroundAgentBadge();
      return;
    }

    let tc = streamingUI.getToolComponent(event.parentToolCallId);
    if (tc === undefined) {
      const toolCall = streamingUI.getActiveToolCall(event.parentToolCallId);
      if (toolCall !== undefined) {
        streamingUI.onToolCallStart(toolCall);
        tc = streamingUI.getToolComponent(event.parentToolCallId);
      }
    }
    tc ??= this.createStandaloneSubagentToolCall(event);
    if (tc === undefined) return;
    tc.onSubagentSpawned({
      agentId: event.subagentId,
      agentName: event.subagentName,
      runInBackground: event.runInBackground,
    });
  }

  private handleSubagentCompleted(event: SubagentCompletedEvent): void {
    const { streamingUI } = this.host;
    const backgroundMeta = this.backgroundAgentMetadata.get(event.subagentId);
    if (backgroundMeta !== undefined) {
      const taskId = this.findAgentTaskId(event.subagentId, backgroundMeta);
      this.backgroundAgentMetadata.delete(event.subagentId);
      this.syncBackgroundAgentBadge();
      if (taskId !== undefined && this.backgroundTaskTranscriptedTerminal.has(taskId)) {
        return;
      }
      if (taskId !== undefined) {
        this.backgroundTaskTranscriptedTerminal.add(taskId);
      }
      const extras =
        event.resultSummary === undefined ? undefined : { resultSummary: event.resultSummary };
      this.appendBackgroundAgentEntry('completed', backgroundMeta, extras);
      return;
    }
    const tc = streamingUI.getToolComponent(event.parentToolCallId);
    if (tc === undefined) return;
    tc.onSubagentCompleted({
      contextTokens: event.contextTokens,
      usage: event.usage,
      resultSummary: event.resultSummary,
    });
    streamingUI.removeToolComponentIfInactive(event.parentToolCallId);
  }

  private handleSubagentFailed(event: SubagentFailedEvent): void {
    const { streamingUI } = this.host;
    const backgroundMeta = this.backgroundAgentMetadata.get(event.subagentId);
    if (backgroundMeta !== undefined) {
      const taskId = this.findAgentTaskId(event.subagentId, backgroundMeta);
      const task = taskId === undefined ? undefined : this.backgroundTasks.get(taskId);
      this.backgroundAgentMetadata.delete(event.subagentId);
      this.syncBackgroundAgentBadge();
      if (task?.kind === 'agent' && task.status === 'timed_out') {
        // The deadline path already stamped the Agent card as timed out; the
        // abort-triggered child failure should not downgrade it to failed.
        return;
      }
      // Push the real subagent error onto the parent Agent card too —
      // `background.task.terminated` arrives separately (possibly later)
      // with no error string and would only stamp the generic
      // `Background agent failed`. The card and the separate transcript
      // entry now share the same actual reason.
      streamingUI.applyBackgroundTaskTerminalStatus({
        agentId: event.subagentId,
        description: backgroundMeta.description ?? '',
        status: 'failed',
        errorText: event.error,
      });
      if (taskId !== undefined && this.backgroundTaskTranscriptedTerminal.has(taskId)) {
        return;
      }
      if (taskId !== undefined) {
        this.backgroundTaskTranscriptedTerminal.add(taskId);
      }
      this.appendBackgroundAgentEntry('failed', backgroundMeta, { error: event.error });
      return;
    }
    const tc = streamingUI.getToolComponent(event.parentToolCallId);
    if (tc === undefined) return;
    tc.onSubagentFailed({ error: event.error });
    streamingUI.removeToolComponentIfInactive(event.parentToolCallId);
  }

  private createStandaloneSubagentToolCall(event: SubagentSpawnedEvent) {
    const { streamingUI } = this.host;
    const description = event.description ?? `Run ${event.subagentName} agent`;
    const { turnId, step } = streamingUI.getTurnContext();
    const toolCall: ToolCallBlockData = {
      id: event.parentToolCallId,
      name: 'Agent',
      args: {
        description,
        subagent_type: event.subagentName,
      },
      description,
      step,
      turnId,
    };
    streamingUI.onToolCallStart(toolCall);
    return streamingUI.getToolComponent(event.parentToolCallId);
  }

  private findAgentTaskId(
    subagentId: string,
    meta: BackgroundAgentMetadata,
  ): string | undefined {
    for (const info of this.backgroundTasks.values()) {
      if (info.kind !== 'agent') continue;
      if (info.agentId === subagentId) return info.taskId;
    }
    const description = meta.description ?? meta.agentName;
    if (description === undefined) return undefined;
    let match: string | undefined;
    for (const info of this.backgroundTasks.values()) {
      if (info.kind !== 'agent') continue;
      if (info.description !== description) continue;
      if (match !== undefined) return undefined;
      match = info.taskId;
    }
    return match;
  }

  private buildBackgroundAgentMetadata(event: SubagentSpawnedEvent): BackgroundAgentMetadata {
    const parent = this.host.streamingUI.getActiveToolCall(event.parentToolCallId);
    const description = parent?.args['description'] ?? event.description;
    return {
      agentId: event.subagentId,
      parentToolCallId: event.parentToolCallId,
      agentName: event.subagentName,
      description: typeof description === 'string' ? description : undefined,
    };
  }

  private appendBackgroundAgentEntry(
    phase: 'started' | 'completed' | 'failed',
    meta: BackgroundAgentMetadata,
    extras: { resultSummary?: string; error?: string } | undefined = undefined,
  ): void {
    const status = formatBackgroundAgentTranscript(phase, meta, extras);
    const entry: TranscriptEntry = {
      id: nextTranscriptId(),
      kind: 'status',
      turnId: this.host.streamingUI.getTurnContext().turnId,
      renderMode: 'plain',
      content: status.headline,
      detail: status.detail,
      backgroundAgentStatus: status,
    };
    this.host.appendTranscriptEntry(entry);
  }

  private syncBackgroundAgentBadge(): void {
    this.syncBackgroundTaskBadge();
  }

  // ---------------------------------------------------------------------------
  // Background task lifecycle
  // ---------------------------------------------------------------------------

  private handleBackgroundTaskEvent(
    event: BackgroundTaskStartedEvent | BackgroundTaskTerminatedEvent,
  ): void {
    const { state } = this.host;
    const { info } = event;
    const previous = this.backgroundTasks.get(info.taskId);
    this.backgroundTasks.set(info.taskId, info);

    const viewer = state.tasksBrowser?.viewer;
    if (viewer !== undefined && viewer.taskId === info.taskId) {
      void this.host.tasksBrowserController.refreshOutputViewer({ silent: true });
    }

    const isTerminal =
      info.status === 'completed' ||
      info.status === 'failed' ||
      info.status === 'timed_out' ||
      info.status === 'killed' ||
      info.status === 'lost';

    if (event.type === 'background.task.started') {
      if (info.kind === 'agent') {
        this.syncBackgroundTaskBadge();
        this.host.tasksBrowserController.repaint();
        return;
      }
      this.appendBackgroundTaskEntry(info);
      this.syncBackgroundTaskBadge();
      this.host.tasksBrowserController.repaint();
      return;
    }

    if (event.type === 'background.task.terminated' && isTerminal) {
      if (info.kind === 'agent') {
        // The Agent tool's spawn-success ToolResult is not an error, so the
        // parent toolCall card would otherwise render `✓ Completed` for any
        // terminated bg agent — including `lost` / `failed` / `killed`.
        // Push the actual terminal status so the card matches reality.
        this.host.streamingUI.applyBackgroundTaskTerminalStatus({
          agentId: info.agentId,
          description: info.description,
          status: info.status,
        });
      }
      if (!this.backgroundTaskTranscriptedTerminal.has(info.taskId)) {
        if (info.kind === 'process' || info.kind === 'question') {
          this.appendBackgroundTaskEntry(info);
        }
        this.backgroundTaskTranscriptedTerminal.add(info.taskId);
      }
      this.syncBackgroundTaskBadge();
      this.host.tasksBrowserController.repaint();
      return;
    }

    if (previous?.status !== info.status) {
      this.syncBackgroundTaskBadge();
    }
    this.host.tasksBrowserController.repaint();
  }

  private appendBackgroundTaskEntry(info: BackgroundTaskInfo): void {
    const status = formatBackgroundTaskTranscript(info);
    const entry: TranscriptEntry = {
      id: nextTranscriptId(),
      kind: 'status',
      turnId: this.host.streamingUI.getTurnContext().turnId,
      renderMode: 'plain',
      content: status.headline,
      detail: status.detail,
      backgroundAgentStatus: status,
    };
    this.host.appendTranscriptEntry(entry);
  }

  private syncBackgroundTaskBadge(): void {
    const { state } = this.host;
    let bashTasks = 0;
    let agentTasks = 0;
    for (const info of this.backgroundTasks.values()) {
      if (
        info.status === 'completed' ||
        info.status === 'failed' ||
        info.status === 'timed_out' ||
        info.status === 'killed' ||
        info.status === 'lost'
      ) {
        continue;
      }
      if (info.kind === 'agent') {
        agentTasks += 1;
      } else {
        bashTasks += 1;
      }
    }
    state.footer.setBackgroundCounts({ bashTasks, agentTasks });
    state.ui.requestRender();
  }
}
