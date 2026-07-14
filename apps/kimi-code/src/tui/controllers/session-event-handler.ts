import type { Component, Focusable } from '@moonshot-ai/pi-tui';

import type {
  AgentStatusUpdatedEvent,
  AgentTaskInfo,
  AssistantDeltaEvent,
  CompactionCancelledEvent,
  CompactionCompletedEvent,
  CompactionStartedEvent,
  CoreSession,
  CronFiredEvent,
  ErrorEvent,
  GoalChange,
  GoalUpdatedEvent,
  HookResultEvent,
  PluginCommandActivatedEvent,
  SessionEvent,
  SessionMetaUpdatedEvent,
  SkillActivatedEvent,
  TaskStartedEvent,
  TaskTerminatedEvent,
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
} from '#/core/index';

import { MoonLoader } from '../components/chrome/moon-loader';
import { buildGoalMarker } from '../components/messages/goal-markers';
import { StatusMessageComponent } from '../components/messages/status-message';
import {
  SwarmModeMarkerComponent,
  type SwarmModeMarkerState,
} from '../components/messages/swarm-markers';
import {
  OAUTH_LOGIN_REQUIRED_CODE,
  OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE,
} from '../constant/kimi-tui';
import { buildGoalCompletionMessage } from '../utils/goal-completion';
import {
  argsRecord,
  formatErrorPayload,
  isTodoItemShape,
  serializeToolResultOutput,
  stringValue,
} from '../utils/event-payload';
import { formatBackgroundTaskTranscript } from '../utils/background-task-status';
import { formatHookResultMarkdown } from '../utils/hook-result-format';
import { McpOAuthAuthorizationUrlOpener } from '../utils/mcp-oauth';
import {
  formatMcpStartupStatusSummary,
  mcpServerStatusKey,
  type McpServerStatusSnapshot,
  selectMcpStartupStatusRows,
} from '../utils/mcp-server-status';
import { openUrl } from '#/utils/open-url';
import { currentTheme } from '#/tui/theme';
import type { ColorToken } from '#/tui/theme';
import { errorReportHintLine } from '../constant/feedback';
import { formatStepDebugTiming } from '#/utils/usage/debug-timing';
import { nextTranscriptId } from '../utils/transcript-id';
import type { BtwPanelController } from './btw-panel';
import type { StreamingUIController } from './streaming-ui';
import type { TasksBrowserController } from './tasks-browser';
import { SubAgentEventHandler } from './subagent-event-handler';
import type {
  AppState,
  LivePaneState,
  QueuedMessage,
  SkillActivationTrigger,
  ToolCallBlockData,
  ToolResultBlockData,
  TranscriptEntry,
} from '../types';
import type { TUIState } from '../tui-state';
import { GoalQueuePromoter } from '../goal-queue-promoter';

export interface SessionEventHost {
  state: TUIState;
  session: CoreSession | undefined;
  aborted: boolean;
  sessionEventUnsubscribe: (() => void) | undefined;
  readonly streamingUI: StreamingUIController;

  requireSession(): CoreSession;
  ensureSession(): Promise<CoreSession | undefined>;
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
  sendQueuedMessage(session: CoreSession, item: QueuedMessage): void;
  sendQueuedGoalMessage(
    session: CoreSession,
    item: QueuedMessage,
    confirmation: Component,
  ): Promise<void>;
  shiftQueuedMessage(): QueuedMessage | undefined;
  readonly btwPanelController: BtwPanelController;
  readonly tasksBrowserController: TasksBrowserController;
}

export class SessionEventHandler {
  readonly subAgentEventHandler: SubAgentEventHandler;

  private readonly promoter: GoalQueuePromoter;

  constructor(private readonly host: SessionEventHost) {
    this.promoter = new GoalQueuePromoter(host);
    this.subAgentEventHandler = new SubAgentEventHandler(host, {
      backgroundTasks: this.backgroundTasks,
      backgroundTaskTranscriptedTerminal: this.backgroundTaskTranscriptedTerminal,
      syncBackgroundAgentBadge: () => {
        this.syncBackgroundTaskBadge();
      },
    });
  }

  // Runtime state – owned by this handler, reset between sessions.
  backgroundTasks: Map<string, AgentTaskInfo> = new Map();
  backgroundTaskTranscriptedTerminal: Set<string> = new Set();

  renderedSkillActivationIds: Set<string> = new Set();
  renderedPluginCommandActivationIds: Set<string> = new Set();
  renderedMcpServerStatusKeys: Map<string, string> = new Map();
  mcpServerStatusSpinners: Map<string, MoonLoader> = new Map();
  mcpServers: Map<string, McpServerStatusSnapshot> = new Map();
  private currentTurnHasAssistantText = false;
  private pendingModelBlockedFallback: GoalChange | undefined;

  resetRuntimeState(): void {
    this.backgroundTasks.clear();
    this.backgroundTaskTranscriptedTerminal.clear();
    this.subAgentEventHandler.resetRuntimeState();
    this.renderedSkillActivationIds.clear();
    this.renderedPluginCommandActivationIds.clear();
    this.renderedMcpServerStatusKeys.clear();
    this.mcpServers.clear();
    this.currentTurnHasAssistantText = false;
    this.pendingModelBlockedFallback = undefined;
    this.promoter.reset();
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
      if (host.aborted) return;
      if (host.session !== session) return;
      if (host.state.appState.sessionId !== session.id) return;
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

  async syncMcpServerStatusSnapshot(session: CoreSession): Promise<void> {
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

  handleEvent(event: SessionEvent, sendQueued: (item: QueuedMessage) => void): void {
    if (this.subAgentEventHandler.routeChildAgentEvent(event)) return;

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
      case 'shell.output': this.host.handleShellOutput(event); break;
      case 'shell.started': this.host.handleShellStarted(event); break;
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
      case 'plugin_command.activated': this.handlePluginCommandActivated(event); break;
      case 'error': this.handleSessionError(event); break;
      case 'warning': this.handleSessionWarning(event); break;
      case 'compaction.started': this.handleCompactionBegin(event); break;
      case 'compaction.completed': this.handleCompactionEnd(event, sendQueued); break;
      case 'compaction.blocked': break;
      case 'compaction.cancelled': this.handleCompactionCancel(event, sendQueued); break;
      case 'subagent.spawned':
      case 'subagent.started':
      case 'subagent.suspended':
      case 'subagent.completed':
      case 'subagent.failed':
        this.subAgentEventHandler.handleLifecycleEvent(event); break;
      // v2 renamed the background task lifecycle events to `task.*`.
      case 'task.started':
      case 'task.terminated':
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

  private handleTurnBegin(_event: TurnStartedEvent): void {
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

  private handleTurnEnd(event: TurnEndedEvent, sendQueued: (item: QueuedMessage) => void): void {
    this.host.streamingUI.flushNow();
    if (event.reason === 'cancelled') {
      this.markActiveAgentSwarmsCancelled();
    }
    if (event.reason === 'failed' && event.error?.code === 'provider.filtered') {
      this.host.showStatus('Turn stopped: provider safety policy blocked the response.', 'error');
    }
    if (event.reason === 'blocked') {
      this.host.showStatus('Turn stopped: prompt hook blocked the request.', 'error');
    }
    const todos = this.host.state.todoPanel.getTodos();
    if (todos.length > 0 && todos.every((t) => t.status === 'done')) {
      this.host.streamingUI.setTodoList([]);
    }
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeTurn(sendQueued);
    this.renderPendingModelBlockedFallback();
    this.currentTurnHasAssistantText = false;
    this.promoter.onTurnEnded();
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

    if (event.providerFinishReason === 'filtered') {
      this.host.showNotice(
        'Provider safety policy blocked the response.',
        `The model output was filtered (${event.rawFinishReason ?? 'content_filter'}).`,
      );
      return;
    }

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
    if (text === undefined) return;
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'status',
      turnId: String(event.turnId),
      renderMode: 'plain',
      content: text,
    });
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

  private handleStepInterrupted(event: TurnStepInterruptedEvent): void {
    this.host.streamingUI.flushNow();
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers('idle');
    const reason = event.reason;
    if (reason === 'error') return;
    if (reason === 'aborted' || reason === undefined || reason === '') {
      this.markActiveAgentSwarmsCancelled();
      if (event.message === undefined || event.message === '') {
        this.host.showStatus('Interrupted by user', 'error');
      } else {
        this.host.showError(event.message);
      }
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
    // Encrypted / redacted reasoning (e.g. Kimi over the Anthropic-compatible
    // protocol) streams thinking deltas whose visible text is empty — only an
    // opaque signature rides along. Such deltas carry nothing to render, so
    // switching into the `thinking` pane mode here would stop the "waiting"
    // moon spinner while no ThinkingComponent is ever created (it needs visible
    // text), leaving a blank, spinner-less gap until the first real text/tool
    // token arrives. Keep the moon up until actual thinking text shows up.
    if (event.delta.length === 0 && !streamingUI.hasThinkingDraft()) return;
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

    if (event.delta.trim().length > 0) {
      this.currentTurnHasAssistantText = true;
      this.pendingModelBlockedFallback = undefined;
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
    if (event.content.trim().length > 0) {
      this.currentTurnHasAssistantText = true;
      this.pendingModelBlockedFallback = undefined;
    }
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
    if (event.name === 'AgentSwarm') {
      this.subAgentEventHandler.handleAgentSwarmToolCallStarted(event.toolCallId, toolCall.args);
    }
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
    const preview = streamingUI.getStreamingToolCallPreview(event.toolCallId);
    if (
      preview !== undefined &&
      (preview.name === 'AgentSwarm' || this.subAgentEventHandler.hasAgentSwarmProgress(event.toolCallId))
    ) {
      this.subAgentEventHandler.handleAgentSwarmToolCallDelta(event.toolCallId, preview.args, {
        streamingArguments: preview.argumentsText,
      });
    }

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
    const text = event.update.text;
    if (text === undefined || text.length === 0) return;
    const tc = this.host.streamingUI.getToolComponent(event.toolCallId);
    if (tc === undefined) return;
    if (event.update.kind === 'status') {
      tc.appendProgress(text);
      return;
    }
    if (event.update.kind === 'stdout' || event.update.kind === 'stderr') {
      tc.appendLiveOutput(text);
    }
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
    this.subAgentEventHandler.handleAgentSwarmToolResult(
      event.toolCallId,
      resultData,
      event.isError === true,
    );
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
    const shouldRenderSwarmEnded =
      event.swarmMode === false &&
      this.host.state.appState.swarmMode &&
      this.host.state.swarmModeEntry === 'task';
    const patch: Partial<AppState> = {};
    if (event.contextTokens !== undefined) patch.contextTokens = event.contextTokens;
    if (event.maxContextTokens !== undefined) patch.maxContextTokens = event.maxContextTokens;
    // The v2 `agent.status.updated` payload carries no `contextUsage` (or
    // `permission`) field, unlike the v1 protocol event: derive the usage
    // ratio from the freshest token counts so the footer gauge stays live;
    // permission changes flow through explicit setPermission + status sync.
    if (event.contextTokens !== undefined || event.maxContextTokens !== undefined) {
      const contextTokens = event.contextTokens ?? this.host.state.appState.contextTokens;
      const maxContextTokens =
        event.maxContextTokens ?? this.host.state.appState.maxContextTokens;
      patch.contextUsage = maxContextTokens > 0 ? contextTokens / maxContextTokens : 0;
    }
    if (event.planMode !== undefined) patch.planMode = event.planMode;
    if (event.swarmMode !== undefined) patch.swarmMode = event.swarmMode;
    if (event.model !== undefined) patch.model = event.model;
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

  private handleGoalUpdated(event: GoalUpdatedEvent): void {
    this.host.setAppState({ goal: event.snapshot });
    if (event.snapshot === null) {
      this.promoter.onSnapshotCleared();
      this.pendingModelBlockedFallback = undefined;
    }
    const change = event.change;
    if (change === undefined) return;
    const { state } = this.host;

    // Completion -> the box disappears (snapshot cleared on the follow-up null
    // update) and a deterministic completion message lands in the transcript.
    // Resume renders the same text from the durable goal completion replay
    // record, so live and replayed completion cards stay identical.
    if (change.kind === 'completion' && event.snapshot !== null) {
      this.pendingModelBlockedFallback = undefined;
      this.promoter.onGoalCompletion();
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
      void this.promoter.notifyBlocked();
      if (change.actor === 'model' || change.reason === undefined) {
        this.pendingModelBlockedFallback = this.currentTurnHasAssistantText
          ? undefined
          : change;
        return;
      }
      this.pendingModelBlockedFallback = undefined;
    } else if (change.kind === 'lifecycle') {
      this.pendingModelBlockedFallback = undefined;
    }
    const marker = buildGoalMarker(change, state.toolOutputExpanded, change.actor);
    if (marker !== null) {
      state.transcriptContainer.addChild(marker);
      state.ui.requestRender();
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

  requestQueuedGoalPromotion(): void {
    this.promoter.request();
  }

  retryQueuedGoalPromotion(): void {
    this.promoter.retry();
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
    this.host.showStatus(`Warning: ${event.message}`, 'warning');
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
        const toolStr = `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`;
        const message = `MCP server "${server.name}" connected · ${toolStr} (${server.transport})`;
        this.finalizeMcpServerStatusRow(server.name, message, 'success');
        return;
      }
      case 'failed': {
        const message = `MCP server "${server.name}" failed${server.error !== undefined ? `: ${server.error}` : ''}`;
        this.finalizeMcpServerStatusRow(server.name, message, 'error');
        return;
      }
      case 'needs-auth': {
        const message = `MCP server "${server.name}" needs OAuth — run /mcp-config login ${server.name}`;
        this.finalizeMcpServerStatusRow(server.name, message, 'warning');
        return;
      }
      case 'disabled':
        this.finalizeMcpServerStatusRow(
          server.name,
          `MCP server "${server.name}" disabled`,
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
    const label = `MCP server "${name}" connecting…`;
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
      // v2 declares `trigger` as a plain string; the runtime source
      // (SkillActivationOrigin) is exactly this literal union.
      skillTrigger: event.trigger as SkillActivationTrigger,
    });
  }

  private handlePluginCommandActivated(event: PluginCommandActivatedEvent): void {
    if (this.renderedPluginCommandActivationIds.has(event.activationId)) return;
    this.renderedPluginCommandActivationIds.add(event.activationId);
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'plugin_command',
      turnId: undefined,
      renderMode: 'plain',
      content: `/${event.pluginId}:${event.commandName}`,
      pluginCommandData: {
        activationId: event.activationId,
        pluginId: event.pluginId,
        commandName: event.commandName,
        args: event.commandArgs,
        trigger: event.trigger,
      },
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
    this.host.streamingUI.endCompaction(
      event.result.tokensBefore,
      event.result.tokensAfter,
      event.result.summary,
    );
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
      const next = this.host.shiftQueuedMessage();
      let dispatchGeneration: number | undefined;
      if (next !== undefined) {
        this.host.state.queuedMessageDispatchPending = true;
        dispatchGeneration = ++this.host.state.queuedMessageDispatchGeneration;
      }
      this.host.setAppState({
        isCompacting: false,
        streamingPhase: 'idle',
      });
      this.host.resetLivePane();
      if (next !== undefined && dispatchGeneration !== undefined) {
        setTimeout(() => {
          if (this.host.state.queuedMessageDispatchGeneration !== dispatchGeneration) return;
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

  private handleBackgroundTaskEvent(
    event: TaskStartedEvent | TaskTerminatedEvent,
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

    if (event.type === 'task.started') {
      if (info.kind === 'agent') {
        // A foreground subagent detached via Ctrl+B: flip its card to
        // `◐ backgrounded` so it doesn't look like it completed.
        this.host.streamingUI.markSubagentBackgrounded(info.agentId);
        this.syncBackgroundTaskBadge();
        this.host.tasksBrowserController.repaint();
        return;
      }
      this.appendBackgroundTaskEntry(info);
      this.syncBackgroundTaskBadge();
      this.host.tasksBrowserController.repaint();
      return;
    }

    if (event.type === 'task.terminated' && isTerminal) {
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

  private appendBackgroundTaskEntry(info: AgentTaskInfo): void {
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
