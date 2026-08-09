import type { Component, Focusable } from '@moonshot-ai/pi-tui';
import type {
  AgentStatusUpdatedEvent,
  BackgroundTaskInfo,
  EngineCompactionStartedEvent,
  EngineGoalUpdatedEvent,
  EngineHookResultEvent,
  EngineLlmDeltaEvent,
  EngineToolSettledEvent,
  EngineToolStartedEvent,
  EngineTurnEndedEvent,
  EngineTurnStartedEvent,
  EngineUsageUpdatedEvent,
  ErrorEvent,
  Event,
  GoalChange,
  HostSessionMetaUpdatedEvent,
  WarningEvent,
} from '@moonshot-ai/kimi-code-sdk';

import { MoonLoader } from '../components/chrome/moon-loader';
import { buildGoalMarker } from '../components/messages/goal-markers';
import { StatusMessageComponent } from '../components/messages/status-message';
import {
  SwarmModeMarkerComponent,
  type SwarmModeMarkerState,
} from '../components/messages/swarm-markers';
import {
  getOauthLoginRequiredStartupNotice,
  OAUTH_LOGIN_REQUIRED_CODE,
} from '../constant/kimi-tui';
import { buildGoalCompletionMessage } from '../utils/goal-completion';
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
import { formatBackgroundTaskTranscript } from '../utils/background-task-status';
import { formatHookResultMarkdown } from '../utils/hook-result-format';
import {
  formatMcpStartupStatusSummary,
  mcpServerStatusKey,
  type McpServerStatusSnapshot,
  selectMcpStartupStatusRows,
} from '../utils/mcp-server-status';
import { currentTheme } from '#/tui/theme';
import type { ColorToken } from '#/tui/theme';
import { errorReportHintLine } from '../constant/feedback';
import { t } from '#/i18n';
import { nextTranscriptId } from '../utils/transcript-id';
import type { BtwPanelController } from './btw-panel';
import type { StreamingUIController } from './streaming-ui';
import type { TasksBrowserController } from './tasks-browser';
import { SubAgentEventHandler } from './subagent-event-handler';
import type {
  AppState,
  LivePaneState,
  QueuedMessage,
  ToolCallBlockData,
  ToolResultBlockData,
  TranscriptEntry,
} from '../types';
import type { TUIState } from '../tui-state';
import { createGoal as startGoalCommand } from '../commands/goal';
import type { TuiSession } from '../tui-session';

export interface SessionEventHost {
  state: TUIState;
  session: TuiSession | undefined;
  aborted: boolean;
  sessionEventUnsubscribe: (() => void) | undefined;
  readonly streamingUI: StreamingUIController;

  requireSession(): TuiSession;
  setAppState(patch: Partial<AppState>): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  resetLivePane(): void;
  showError(msg: string): void;
  showStatus(msg: string, color?: ColorToken): void;
  showNotice(title: string, detail?: string): void;
  updateActivityPane(): void;
  track(event: string, props?: Record<string, unknown>): void;
  mountEditorReplacement(panel: Component & Focusable): void;
  restoreEditor(): void;
  restoreInputText(text: string): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  handleShellOutput(event: { commandId: string; update: { kind: string; text?: string } }): void;
  handleShellStarted(event: { commandId: string; taskId: string }): void;
  sendNormalUserInput(text: string): void;
  updateTerminalTitle(): void;
  sendQueuedMessage(session: TuiSession, item: QueuedMessage): void;
  shiftQueuedMessage(): QueuedMessage | undefined;
  readonly btwPanelController: BtwPanelController;
  readonly tasksBrowserController: TasksBrowserController;
}

/**
 * Estimate token count from text content. Matches the heuristic used by
 * the native token estimator in tokens.rs: ASCII chars ≈ 4/token,
 * non-ASCII (CJK, emoji) ≈ 1/token.
 */
function estimateTokensFromText(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    if ((text.codePointAt(i) ?? 0) < 128) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 4 + nonAscii);
}

export class SessionEventHandler {
  readonly subAgentEventHandler: SubAgentEventHandler;

  constructor(private readonly host: SessionEventHost) {
    this.subAgentEventHandler = new SubAgentEventHandler(host, {
      backgroundTasks: this.backgroundTasks,
      backgroundTaskTranscriptedTerminal: this.backgroundTaskTranscriptedTerminal,
      syncBackgroundAgentBadge: () => {
        this.syncBackgroundTaskBadge();
      },
    });
  }

  // Runtime state – owned by this handler, reset between sessions.
  backgroundTasks: Map<string, BackgroundTaskInfo> = new Map();
  backgroundTaskTranscriptedTerminal: Set<string> = new Set();

  renderedSkillActivationIds: Set<string> = new Set();
  renderedPluginCommandActivationIds: Set<string> = new Set();
  renderedMcpServerStatusKeys: Map<string, string> = new Map();
  mcpServerStatusSpinners: Map<string, MoonLoader> = new Map();
  mcpServers: Map<string, McpServerStatusSnapshot> = new Map();
  private goalCompletionAwaitingClear = false;
  private goalCompletionTurnEnded = false;
  private currentTurnHasAssistantText = false;
  private pendingModelBlockedFallback: GoalChange | undefined;
  private queuedGoalPromotionPending = false;
  private queuedGoalPromotionInFlight = false;
  private queuedGoalPromotionTimer: ReturnType<typeof setTimeout> | undefined;

  resetRuntimeState(): void {
    this.backgroundTasks.clear();
    this.backgroundTaskTranscriptedTerminal.clear();
    this.subAgentEventHandler.resetRuntimeState();
    this.renderedSkillActivationIds.clear();
    this.renderedPluginCommandActivationIds.clear();
    this.renderedMcpServerStatusKeys.clear();
    this.mcpServers.clear();
    this.goalCompletionAwaitingClear = false;
    this.goalCompletionTurnEnded = false;
    this.currentTurnHasAssistantText = false;
    this.pendingModelBlockedFallback = undefined;
    this.queuedGoalPromotionPending = false;
    this.queuedGoalPromotionInFlight = false;
    this.clearQueuedGoalPromotionTimer();
    this.stopAllMcpServerStatusSpinners();
  }

  clearAgentSwarmProgress(): void {
    this.subAgentEventHandler.clearAgentSwarmProgress();
  }

  hasActiveAgentSwarmToolCall(): boolean {
    return this.subAgentEventHandler.hasActiveAgentSwarmToolCall();
  }

  syncAgentSwarmActivitySpinner(spinner: MoonLoader | undefined): void {
    this.subAgentEventHandler.syncAgentSwarmActivitySpinner(spinner);
  }

  startSubscription(): void {
    const { host } = this;
    const session = host.requireSession();
    const sendQueued = (item: QueuedMessage): void => {
      host.sendQueuedMessage(session, item);
    };
    host.sessionEventUnsubscribe?.();
    const { sessionId } = host.state.appState;
    host.sessionEventUnsubscribe = session.onEvent((event) => {
      if (host.aborted) return;
      if (event.sessionId !== sessionId) return;
      this.handleEvent(event, sendQueued);
    });
    void this.syncMcpServerStatusSnapshot(session);
  }

  async syncMcpServerStatusSnapshot(session: TuiSession): Promise<void> {
    const { host } = this;
    let servers: readonly McpServerStatusSnapshot[];
    try {
      servers = await session.listMcpServers();
    } catch (error) {
      if (host.session !== session || host.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      host.showError(t('tui.statusMessages.failedToSyncMcp', { message }));
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
    if ('turn_id' in event && event.turn_id !== undefined) {
      this.host.streamingUI.setTurnId(String(event.turn_id));
    }

    switch (event.type) {
      case 'session.turn.started': this.handleTurnBegin(event); break;
      case 'session.turn.ended': this.handleTurnEnd(event, sendQueued); break;
      case 'llm.delta':
        if (event.part.type === 'think') {
          this.handleThinkingDelta(event);
        } else if (event.part.type === 'tool_call') {
          // Streamed tool-argument preview (Rust native-LLM turns). The TS
          // hosts render arguments from `session.tool.started`, so the
          // preview carries nothing to do here.
          break;
        } else {
          this.handleAssistantDelta(event);
        }
        break;
      case 'session.tool.started': this.handleToolCall(event); break;
      case 'session.tool.settled': this.handleToolResult(event); break;
      case 'session.goal.updated': this.handleGoalUpdated(event); break;
      case 'session.hook.result': this.handleHookResult(event); break;
      case 'session.compaction.started': this.handleCompactionBegin(event); break;
      case 'session.shell.output':
        this.host.handleShellOutput({
          commandId: event.command_id,
          update: { kind: 'stdout', text: event.chunk },
        });
        break;
      case 'session.usage.updated': this.handleUsageUpdated(event); break;
      case 'session.meta.updated': this.handleSessionMetaChanged(event); break;
      case 'agent.status.updated': this.handleStatusUpdate(event); break;
      case 'error': this.handleSessionError(event); break;
      case 'warning': this.handleSessionWarning(event); break;
      case 'session.task.started':
      case 'session.task.terminated':
      case 'llm.step.begin':
      case 'llm.step.end':
      case 'config.update':
      case 'permission.set_mode':
      case 'turn.steer':
      case 'session.closed':
        break;
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

  private handleTurnBegin(_event: EngineTurnStartedEvent): void {
    void _event;
    this.currentTurnHasAssistantText = false;
    this.clearAgentSwarmProgress();
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

  private handleTurnEnd(
    event: EngineTurnEndedEvent,
    sendQueued: (item: QueuedMessage) => void,
  ): void {
    this.host.streamingUI.flushNow();
    const reason = mapEngineStopReason(event.stop_reason);
    if (reason === 'cancelled') {
      this.markActiveAgentSwarmsCancelled();
    }
    const todos = this.host.state.todoPanel.getTodos();
    if (todos.length > 0 && todos.every((t) => t.status === 'done')) {
      this.host.streamingUI.setTodoList([]);
    }
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeTurn(sendQueued);
    this.renderPendingModelBlockedFallback();
    this.currentTurnHasAssistantText = false;
    this.goalCompletionTurnEnded = true;
    this.scheduleQueuedGoalPromotion();
  }

  private markActiveAgentSwarmsCancelled(): void {
    this.subAgentEventHandler.markActiveAgentSwarmsCancelled();
  }

  private isAnthropicSessionActive(): boolean {
    const { state } = this.host;
    const model = state.appState.availableModels[state.appState.model];
    if (model === undefined) return false;
    if (model.protocol === 'anthropic') return true;
    return state.appState.availableProviders[model.provider]?.type === 'anthropic';
  }

  private handleThinkingDelta(event: EngineLlmDeltaEvent): void {
    const { state, streamingUI } = this.host;
    const part = event.part;
    if (part.type !== 'think') return;
    const delta = part.think ?? '';
    // Encrypted / redacted reasoning (e.g. Kimi over the Anthropic-compatible
    // protocol) streams thinking deltas whose visible text is empty — only an
    // opaque signature rides along. Models also occasionally stream whitespace-
    // only thinking (e.g. a single space). Such deltas carry nothing to render,
    // so switching into the `thinking` pane mode here would stop the "waiting"
    // moon spinner while no ThinkingComponent is ever created (it needs visible
    // text), leaving a blank, spinner-less gap until the first real text/tool
    // token arrives. Keep the moon up until actual thinking text shows up.
    if (delta.trim().length === 0 && !streamingUI.hasThinkingDraft()) return;
    streamingUI.appendThinkingDelta(delta);
    this.host.patchLivePane({ mode: 'idle' });
    if (state.appState.streamingPhase !== 'thinking') {
      this.host.setAppState({ streamingPhase: 'thinking', streamingStartTime: Date.now(), outputTokens: 0 });
    }
    this.host.setAppState({ outputTokens: state.appState.outputTokens + estimateTokensFromText(delta) });
    streamingUI.scheduleFlush();
  }

  private handleAssistantDelta(event: EngineLlmDeltaEvent): void {
    const { state, streamingUI } = this.host;
    const part = event.part;
    if (part.type !== 'text') return;
    const delta = part.text ?? '';
    if (streamingUI.hasThinkingDraft()) {
      streamingUI.flushThinkingToTranscript('idle');
    }

    if (delta.trim().length > 0) {
      this.currentTurnHasAssistantText = true;
      this.pendingModelBlockedFallback = undefined;
    }
    streamingUI.appendAssistantDelta(delta);

    this.host.patchLivePane({
      mode: 'idle',
      pendingApproval: null,
      pendingQuestion: null,
    });
    if (state.appState.streamingPhase !== 'composing') {
      this.host.setAppState({ streamingPhase: 'composing', streamingStartTime: Date.now(), outputTokens: 0 });
    }
    this.host.setAppState({ outputTokens: state.appState.outputTokens + estimateTokensFromText(delta) });
    streamingUI.scheduleFlush();
  }

  private handleHookResult(event: EngineHookResultEvent): void {
    this.host.streamingUI.flushNow();
    if (this.host.streamingUI.hasThinkingDraft()) {
      this.host.streamingUI.flushThinkingToTranscript('idle');
    }
    this.host.streamingUI.finalizeAssistantStream();
    if (event.content.trim().length > 0) {
      this.currentTurnHasAssistantText = true;
      this.pendingModelBlockedFallback = undefined;
    }
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'assistant',
      turnId: String(this.host.streamingUI.getTurnContext().turnId),
      renderMode: 'markdown',
      content: formatHookResultMarkdown(event),
    });
    this.host.patchLivePane({
      mode: 'idle',
      pendingApproval: null,
      pendingQuestion: null,
    });
  }

  private handleToolCall(event: EngineToolStartedEvent): void {
    const { streamingUI } = this.host;
    streamingUI.flushNow();
    const { turnId, step } = streamingUI.getTurnContext();
    const toolCall: ToolCallBlockData = {
      id: event.tool_call_id,
      name: event.tool_name,
      args: argsRecord(event.arguments),
      step,
      turnId,
    };
    streamingUI.registerToolCall(toolCall);
    if (event.tool_name === 'AgentSwarm' || event.tool_name === 'SwarmDiscussion') {
      this.subAgentEventHandler.handleAgentSwarmToolCallStarted(event.tool_call_id, toolCall.args);
    }
    this.host.patchLivePane({
      mode: 'tool',
      pendingApproval: null,
      pendingQuestion: null,
    });
  }

  private handleToolResult(event: EngineToolSettledEvent): void {
    const { streamingUI } = this.host;
    streamingUI.flushNow();
    const resultData: ToolResultBlockData = {
      tool_call_id: event.tool_call_id,
      output: serializeToolResultOutput(event.content),
      is_error: event.is_error,
    };
    const matchedCall = streamingUI.completeToolResult(event.tool_call_id, resultData);
    this.subAgentEventHandler.handleAgentSwarmToolResult(
      event.tool_call_id,
      resultData,
      event.is_error === true,
    );
    if (matchedCall !== undefined && matchedCall.name === 'TodoList' && !event.is_error) {
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
    const shouldRenderSwarmEnded =
      event.swarmMode === false &&
      this.host.state.appState.swarmMode &&
      this.host.state.swarmModeEntry === 'task';
    const patch: Partial<AppState> = {};
    if (event.contextUsage !== undefined) patch.contextUsage = event.contextUsage;
    if (event.contextTokens !== undefined) patch.contextTokens = event.contextTokens;
    if (event.maxContextTokens !== undefined) patch.maxContextTokens = event.maxContextTokens;
    if (event.planMode !== undefined) patch.planMode = event.planMode;
    if (event.swarmMode !== undefined) patch.swarmMode = event.swarmMode;
    if (event.permission !== undefined) {
      patch.permissionMode = event.permission;
    }
    if (event.model !== undefined) patch.model = event.model;
    if (event.thinkingEffort !== undefined) patch.thinkingEffort = event.thinkingEffort;
    if (Object.keys(patch).length > 0) this.host.setAppState(patch);
    if (event.swarmMode === false) {
      this.host.state.swarmModeEntry = undefined;
      if (shouldRenderSwarmEnded) {
        this.renderSwarmModeMarker('ended');
      }
    }
  }

  private renderSwarmModeMarker(state: SwarmModeMarkerState): void {
    this.host.state.transcriptContainer.addChild(
      new SwarmModeMarkerComponent(state),
    );
    this.host.state.ui.requestRender();
  }

  private handleGoalUpdated(event: EngineGoalUpdatedEvent): void {
    this.host.setAppState({ goal: event.snapshot });
    if (event.snapshot === null && this.goalCompletionAwaitingClear) {
      this.goalCompletionAwaitingClear = false;
      this.queuedGoalPromotionPending = true;
      this.scheduleQueuedGoalPromotion();
    }
    if (event.snapshot === null) {
      this.pendingModelBlockedFallback = undefined;
      return;
    }
    // The engine reports status on the snapshot (lowercase); a completed goal
    // clears on the follow-up null update, and a deterministic completion
    // message lands in the transcript here.
    if (event.snapshot.status === 'complete') {
      this.pendingModelBlockedFallback = undefined;
      this.goalCompletionAwaitingClear = true;
      this.goalCompletionTurnEnded = false;
      this.host.appendTranscriptEntry({
        id: nextTranscriptId(),
        kind: 'assistant',
        renderMode: 'markdown',
        content: buildGoalCompletionMessage(event.snapshot),
      });
      this.host.state.ui.requestRender();
    }
  }

  private renderPendingModelBlockedFallback(): void {
    const change = this.pendingModelBlockedFallback;
    if (change === undefined) return;
    this.pendingModelBlockedFallback = undefined;
    const { state } = this.host;
    const marker = buildGoalMarker(change, state.toolOutputExpanded, 'model');
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

  private isReadyForQueuedGoalPromotion(session?: TuiSession): boolean {
    return (
      (session === undefined || this.host.session === session) &&
      !this.host.aborted &&
      this.host.state.appState.streamingPhase === 'idle' &&
      this.host.state.queuedMessages.length === 0 &&
      !this.host.state.queuedMessageDispatchPending
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
      host.showError(t('tui.statusMessages.failedToReadUpcomingGoals', { error: formatErrorMessage(error) }));
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
              t('tui.statusMessages.queuedGoalRemoveFailed', { error: formatErrorMessage(error) }),
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
    session: TuiSession,
    goal: UpcomingGoal,
  ): Promise<void> {
    try {
      await restoreGoalQueueItem(session, goal);
    } catch (error) {
      this.host.showError(t('tui.statusMessages.queuedGoalRestoreFailed', { error: formatErrorMessage(error) }));
    }
    await this.cancelStartedQueuedGoal(session);
  }

  private async cancelStartedQueuedGoal(session: TuiSession): Promise<void> {
    try {
      await session.cancelGoal();
    } catch (error) {
      this.host.showError(t('tui.statusMessages.queuedGoalCancelFailed', { error: formatErrorMessage(error) }));
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
      t('tui.statusMessages.goalBlocked'),
      t('tui.statusMessages.goalBlockedDetail'),
    );
  }

  private handleSessionMetaChanged(event: HostSessionMetaUpdatedEvent): void {
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
      this.host.showError(getOauthLoginRequiredStartupNotice());
      return;
    }
    this.host.showError(formatErrorPayload(event));
    const sessionId = this.host.state.appState.sessionId;
    if (sessionId.length > 0) {
      this.host.showStatus(errorReportHintLine());
    }
  }

  private handleSessionWarning(event: WarningEvent): void {
    this.host.showStatus(t('tui.statusMessages.warningPrefix', { message: event.message }), 'warning');
  }

  private renderMcpServerStatus(server: McpServerStatusSnapshot): void {
    const key = mcpServerStatusKey(server);
    if (this.renderedMcpServerStatusKeys.get(server.name) === key) return;
    this.renderedMcpServerStatusKeys.set(server.name, key);
    this.mcpServers.set(server.name, server);
    const summary = formatMcpStartupStatusSummary([...this.mcpServers.values()]);
    this.host.setAppState({ mcpServersSummary: summary || null });

    switch (server.status) {
      case 'connected': {
        const message = t('tui.statusMessages.mcpServerConnected', { name: server.name, count: server.toolCount, transport: server.transport });
        this.finalizeMcpServerStatusRow(server.name, message, 'success');
        return;
      }
      case 'failed': {
        const message = server.error !== undefined
          ? t('tui.statusMessages.mcpServerFailedWithError', { name: server.name, error: server.error })
          : t('tui.statusMessages.mcpServerFailed', { name: server.name });
        this.finalizeMcpServerStatusRow(server.name, message, 'error');
        return;
      }
      case 'needs-auth': {
        const message = t('tui.statusMessages.mcpServerNeedsAuth', { name: server.name });
        this.finalizeMcpServerStatusRow(server.name, message, 'warning');
        return;
      }
      case 'disabled':
        this.finalizeMcpServerStatusRow(
          server.name,
          t('tui.statusMessages.mcpServerDisabled', { name: server.name }),
          'textMuted',
        );
        return;
      case 'pending':
        this.showMcpServerStatusSpinner(server.name);
        return;
    }
  }

  private showMcpServerStatusSpinner(name: string): void {
    const { state } = this.host;
    const label = t('tui.statusMessages.mcpServerConnecting', { name });
    const existing = this.mcpServerStatusSpinners.get(name);
    if (existing !== undefined) {
      existing.setLabel(label);
      return;
    }
    const tint = (s: string): string => currentTheme.fg('textMuted', s);
    const spinner = new MoonLoader(state.ui, 'braille', tint, label);
    state.transcriptContainer.addChild(spinner);
    this.mcpServerStatusSpinners.set(name, spinner);
    state.ui.requestRender();
  }

  private finalizeMcpServerStatusRow(name: string, message: string, color: ColorToken): void {
    const { state } = this.host;
    const spinner = this.mcpServerStatusSpinners.get(name);
    if (spinner === undefined) {
      this.host.showStatus(message, color);
      return;
    }
    spinner.stop();
    const status = new StatusMessageComponent(message, color);
    const children = state.transcriptContainer.children;
    const idx = children.indexOf(spinner);
    if (idx >= 0) {
      // In-place replacement is picked up by the container's ref-checked
      // render cache; a tree-wide invalidate is unnecessary (and costly).
      children[idx] = status;
    } else {
      state.transcriptContainer.addChild(status);
    }
    this.mcpServerStatusSpinners.delete(name);
    state.ui.requestRender();
  }

  private handleCompactionBegin(_event: EngineCompactionStartedEvent): void {
    this.host.streamingUI.finalizeLiveTextBuffers('waiting');
    this.host.setAppState({
      isCompacting: true,
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
    this.host.streamingUI.beginCompaction();
  }

  private handleUsageUpdated(event: EngineUsageUpdatedEvent): void {
    // Engine usage is session-cumulative; the per-turn delta is what the
    // token meter shows. No per-session total is tracked host-side, so only
    // update the meter when a turn is actively streaming.
    const { state } = this.host;
    if (state.appState.streamingPhase === 'composing' || state.appState.streamingPhase === 'thinking') {
      this.host.setAppState({ outputTokens: event.total_tokens });
    }
  }

  private finishCompaction(sendQueued: (item: QueuedMessage) => void): void {
    const hasActiveTurn = this.host.streamingUI.hasActiveTurn();
    if (!hasActiveTurn) {
      const next = this.host.shiftQueuedMessage();
      if (next !== undefined) {
        this.host.state.queuedMessageDispatchPending = true;
      }
      this.host.setAppState({
        isCompacting: false,
        streamingPhase: 'idle',
      });
      this.host.resetLivePane();
      if (next !== undefined) {
        setTimeout(() => {
          this.host.state.queuedMessageDispatchPending = false;
          sendQueued(next);
        }, 0);
      }
    } else {
      this.host.setAppState({ isCompacting: false });
    }
  }

  // ---------------------------------------------------------------------------
  // Background task lifecycle
  // ---------------------------------------------------------------------------

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

/** Map the engine's `LoopTurnStopReason` Debug string onto the v1 reason set
 *  the TUI renders ('cancelled' / 'failed' / 'completed'). */
function mapEngineStopReason(stopReason: string): 'completed' | 'cancelled' | 'failed' {
  switch (stopReason) {
    case 'Aborted':
      return 'cancelled';
    case 'Failed':
      return 'failed';
    default:
      return 'completed';
  }
}
