import type { Session } from '@moonshot-ai/kimi-code-sdk';

import { AgentGroupComponent } from '../components/messages/agent-group';
import { AssistantMessageComponent } from '../components/messages/assistant-message';
import { CompactionComponent } from '../components/dialogs/compaction';
import { ReadGroupComponent } from '../components/messages/read-group';
import { ThinkingComponent } from '../components/messages/thinking';
import { ToolCallComponent } from '../components/messages/tool-call';
import { STREAMING_UI_FLUSH_MS } from '../constant/streaming';
import { hasDispose } from '../utils/component-capabilities';
import { parseStreamingArgs } from '../utils/event-payload';
import { notifyTerminalOnce } from '../utils/terminal-notification';
import { nextTranscriptId } from '../utils/transcript-id';
import type { TodoItem } from '../components/chrome/todo-panel';
import type {
  AppState,
  LivePaneState,
  QueuedMessage,
  ToolCallBlockData,
  ToolResultBlockData,
  TranscriptEntry,
} from '../types';
import type { TUIState } from '../tui-state';

export interface StreamingUIHost {
  state: TUIState;
  session: Session | undefined;
  setAppState(patch: Partial<AppState>): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  resetLivePane(): void;
  updateActivityPane(): void;
  updateQueueDisplay(): void;
  requireSession(): Session;
  deferUserMessages: boolean;
}

export class StreamingUIController {
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFlushAt: number | undefined;
  private pendingAssistantFlush = false;
  private pendingThinkingFlush = false;
  readonly pendingToolCallFlushIds = new Set<string>();

  // ---------------------------------------------------------------------------
  // Streaming runtime state (moved from TUIState)
  // ---------------------------------------------------------------------------

  currentTurnId: string | undefined = undefined;
  currentStep = 0;
  assistantDraft = '';
  thinkingDraft = '';
  streamingBlock: { component: AssistantMessageComponent; entry: TranscriptEntry } | null = null;
  activeThinkingComponent: ThinkingComponent | undefined = undefined;
  activeCompactionBlock: CompactionComponent | undefined = undefined;
  activeToolCalls = new Map<string, ToolCallBlockData>();
  streamingToolCallArguments = new Map<
    string,
    { name?: string; argumentsText: string; startedAtMs: number }
  >();
  pendingToolComponents = new Map<string, ToolCallComponent>();
  pendingAgentGroup: {
    readonly turnId: string | undefined;
    readonly step: number;
    solo?: ToolCallComponent;
    group?: AgentGroupComponent;
  } | null = null;
  pendingReadGroup: {
    readonly turnId: string | undefined;
    readonly step: number;
    solo?: ToolCallComponent;
    group?: ReadGroupComponent;
  } | null = null;

  constructor(private readonly host: StreamingUIHost) {}

  // ---------------------------------------------------------------------------
  // Dispose helpers (moved from KimiTUI)
  // ---------------------------------------------------------------------------

  disposeActiveThinkingComponent(): void {
    if (this.activeThinkingComponent !== undefined) {
      this.activeThinkingComponent.dispose();
      this.activeThinkingComponent = undefined;
    }
  }

  disposeAndClearPendingToolComponents(): void {
    for (const component of this.pendingToolComponents.values()) {
      if (hasDispose(component)) component.dispose();
    }
    this.pendingToolComponents.clear();
  }

  disposeActiveCompactionBlock(): void {
    if (this.activeCompactionBlock !== undefined) {
      this.activeCompactionBlock.dispose();
      this.activeCompactionBlock = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Flush control
  // ---------------------------------------------------------------------------

  hasPending(): boolean {
    return (
      this.pendingAssistantFlush ||
      this.pendingThinkingFlush ||
      this.pendingToolCallFlushIds.size > 0
    );
  }

  clearFlushTimer(): void {
    if (this.flushTimer === undefined) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private clearFlushTimerIfIdle(): void {
    if (this.hasPending()) return;
    this.clearFlushTimer();
  }

  discardPending(): void {
    this.clearFlushTimer();
    this.pendingAssistantFlush = false;
    this.pendingThinkingFlush = false;
    this.pendingToolCallFlushIds.clear();
  }

  scheduleFlush(): void {
    if (!this.hasPending()) return;
    if (this.flushTimer !== undefined) return;
    const delay =
      this.lastFlushAt === undefined
        ? 0
        : Math.max(0, STREAMING_UI_FLUSH_MS - (Date.now() - this.lastFlushAt));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, delay);
  }

  flushNow(): void {
    this.clearFlushTimer();
    this.flush();
  }

  private flush(): void {
    if (!this.hasPending()) return;
    this.lastFlushAt = Date.now();
    const shouldFlushThinking = this.pendingThinkingFlush;
    const shouldFlushAssistant = this.pendingAssistantFlush;
    const toolCallIds = [...this.pendingToolCallFlushIds];
    this.pendingThinkingFlush = false;
    this.pendingAssistantFlush = false;
    this.pendingToolCallFlushIds.clear();

    if (shouldFlushThinking && this.thinkingDraft.length > 0) {
      this.onThinkingUpdate(this.thinkingDraft);
    }
    if (shouldFlushAssistant) {
      this.onStreamingTextUpdate(this.assistantDraft);
    }
    for (const id of toolCallIds) {
      this.flushToolCallPreview(id);
    }
  }

  markAssistantDirty(): void {
    this.pendingAssistantFlush = true;
  }

  markThinkingDirty(): void {
    this.pendingThinkingFlush = true;
  }

  // ---------------------------------------------------------------------------
  // Text streaming
  // ---------------------------------------------------------------------------

  flushThinkingToTranscript(nextMode: LivePaneState['mode'] = 'idle'): void {
    this.flushNow();
    if (this.thinkingDraft.length === 0) {
      this.host.patchLivePane({ mode: nextMode });
      return;
    }
    this.thinkingDraft = '';
    this.onThinkingEnd();
    this.host.patchLivePane({ mode: nextMode });
  }

  finalizeAssistantStream(): void {
    this.flushNow();
    if (this.streamingBlock !== null) {
      this.onStreamingTextEnd();
    }
    this.assistantDraft = '';
    this.host.updateActivityPane();
    this.host.state.ui.requestRender();
  }

  resetLiveText(): void {
    this.pendingAssistantFlush = false;
    this.pendingThinkingFlush = false;
    this.clearFlushTimerIfIdle();
    this.assistantDraft = '';
    this.streamingBlock = null;
    this.thinkingDraft = '';
    this.disposeActiveThinkingComponent();
  }

  resetToolUi(): void {
    this.pendingToolCallFlushIds.clear();
    this.clearFlushTimerIfIdle();
    this.streamingToolCallArguments.clear();
    this.disposeAndClearPendingToolComponents();
    this.pendingAgentGroup = null;
    this.pendingReadGroup = null;
  }

  resetToolCallState(): void {
    this.activeToolCalls.clear();
  }

  finalizeLiveTextBuffers(nextMode: LivePaneState['mode'] = 'idle'): void {
    this.flushThinkingToTranscript(nextMode);
    this.finalizeAssistantStream();
  }

  finalizeTurn(sendQueued: (item: QueuedMessage) => void): void {
    const { state } = this.host;
    if (state.appState.streamingPhase === 'idle') return;
    this.host.deferUserMessages = false;
    const completedTurnKey =
      this.currentTurnId ?? `local:${String(state.appState.streamingStartTime)}`;
    this.finalizeLiveTextBuffers('idle');
    this.resetToolCallState();
    this.currentTurnId = undefined;

    if (state.queuedMessages.length > 0) {
      const [next, ...rest] = state.queuedMessages;
      state.queuedMessages = rest;
      this.host.setAppState({ streamingPhase: 'idle' });
      this.host.resetLivePane();
      if (next !== undefined) {
        setTimeout(() => {
          sendQueued(next);
        }, 0);
      }
      return;
    }

    this.host.setAppState({ streamingPhase: 'idle' });
    this.host.resetLivePane();
    notifyTerminalOnce(state, `turn-complete:${completedTurnKey}`, {
      title: 'Kimi Code task complete',
      body: state.appState.sessionTitle ?? undefined,
    });
  }

  // ---------------------------------------------------------------------------
  // Live Render Hooks
  // ---------------------------------------------------------------------------

  onStreamingTextStart(): void {
    const { state } = this.host;
    this.pendingAgentGroup = null;
    this.pendingReadGroup = null;
    const entry = {
      id: nextTranscriptId(),
      kind: 'assistant' as const,
      turnId: this.currentTurnId,
      renderMode: 'markdown' as const,
      content: '',
    };
    const component = new AssistantMessageComponent(
      state.theme.markdownTheme,
      state.theme.colors,
    );
    this.streamingBlock = { component, entry };
    state.transcriptEntries.push(entry);
    state.transcriptContainer.addChild(component);
    state.ui.requestRender();
  }

  onStreamingTextUpdate(fullText: string): void {
    const block = this.streamingBlock;
    if (block !== null) {
      block.entry.content = fullText;
      block.component.updateContent(fullText);
      this.host.state.ui.requestRender();
    }
  }

  onStreamingTextEnd(): void {
    this.streamingBlock = null;
  }

  onThinkingUpdate(fullText: string): void {
    const { state } = this.host;
    if (this.activeThinkingComponent === undefined) {
      this.pendingAgentGroup = null;
      this.pendingReadGroup = null;
      this.activeThinkingComponent = new ThinkingComponent(
        fullText,
        state.theme.colors,
        true,
        'live',
        state.ui,
      );
      if (state.toolOutputExpanded) this.activeThinkingComponent.setExpanded(true);
      state.transcriptContainer.addChild(this.activeThinkingComponent);
    } else {
      this.activeThinkingComponent.setText(fullText);
    }
    state.ui.requestRender();
  }

  onThinkingEnd(): void {
    if (this.activeThinkingComponent === undefined) return;
    this.activeThinkingComponent.finalize();
    this.activeThinkingComponent = undefined;
    this.host.state.ui.requestRender();
  }

  onToolCallStart(toolCall: ToolCallBlockData): void {
    if (toolCall.name === 'AskUserQuestion') return;

    const { state } = this.host;
    const tc = new ToolCallComponent(
      toolCall,
      undefined,
      state.theme.colors,
      state.ui,
      state.theme.markdownTheme,
      state.appState.workDir,
    );
    if (state.toolOutputExpanded) tc.setExpanded(true);
    if (state.planExpanded) tc.setPlanExpanded(true);
    this.pendingToolComponents.set(toolCall.id, tc);

    if (toolCall.name !== 'Agent') this.pendingAgentGroup = null;
    if (toolCall.name !== 'Read') this.pendingReadGroup = null;

    let handled = this.tryAttachAgentToolCall(toolCall, tc);
    if (!handled) handled = this.tryAttachReadToolCall(toolCall, tc);
    if (!handled) {
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
    }

    if (toolCall.name === 'ExitPlanMode' && typeof toolCall.args['plan'] !== 'string') {
      const session = this.host.requireSession();
      void (async () => {
        try {
          const plan = await session.getPlan();
          tc.setPlanInfo(plan === null ? {} : { plan: plan.content, path: plan.path });
        } catch {
          tc.setPlanInfo({});
        }
      })();
    }
  }

  onToolCallEnd(toolCallId: string, result: ToolResultBlockData): void {
    const { state } = this.host;
    const matchedCall = this.activeToolCalls.get(toolCallId);
    const tc = this.pendingToolComponents.get(toolCallId);
    if (tc) {
      tc.setResult(result);
      this.pendingToolComponents.delete(toolCallId);
      state.ui.requestRender();
      return;
    }

    if (matchedCall?.name === 'AskUserQuestion') {
      const completed = new ToolCallComponent(
        matchedCall,
        result,
        state.theme.colors,
        state.ui,
        state.theme.markdownTheme,
        state.appState.workDir,
      );
      if (state.toolOutputExpanded) completed.setExpanded(true);
      if (state.planExpanded) completed.setPlanExpanded(true);
      state.transcriptContainer.addChild(completed);
      state.ui.requestRender();
    }
  }

  setTodoList(todos: readonly TodoItem[]): void {
    const { state } = this.host;
    state.todoPanel.setTodos(todos);
    state.todoPanelContainer.clear();
    if (!state.todoPanel.isEmpty()) {
      state.todoPanelContainer.addChild(state.todoPanel);
    }
    state.ui.requestRender();
  }

  beginCompaction(instruction?: string): void {
    const { state } = this.host;
    if (this.activeCompactionBlock !== undefined) {
      this.activeCompactionBlock.markDone();
      this.activeCompactionBlock = undefined;
    }
    const block = new CompactionComponent(state.theme.colors, state.ui, instruction);
    this.activeCompactionBlock = block;
    state.transcriptContainer.addChild(block);
    state.ui.requestRender();
  }

  endCompaction(tokensBefore?: number, tokensAfter?: number): void {
    const block = this.activeCompactionBlock;
    if (block === undefined) return;
    block.markDone(tokensBefore, tokensAfter);
    this.activeCompactionBlock = undefined;
    this.host.state.ui.requestRender();
  }

  cancelCompaction(): void {
    const block = this.activeCompactionBlock;
    if (block === undefined) return;
    block.markCanceled();
    this.activeCompactionBlock = undefined;
    this.host.state.ui.requestRender();
  }

  // ---------------------------------------------------------------------------
  // Tool call grouping
  // ---------------------------------------------------------------------------

  private flushToolCallPreview(id: string): void {
    const streaming = this.streamingToolCallArguments.get(id);
    if (streaming === undefined) return;
    const toolCall: ToolCallBlockData = {
      id,
      name: streaming.name ?? this.activeToolCalls.get(id)?.name ?? 'Tool',
      args: parseStreamingArgs(streaming.argumentsText),
      streamingArguments: streaming.argumentsText,
      streamingStartedAtMs: streaming.startedAtMs,
      step: this.currentStep,
      turnId: this.currentTurnId,
    };
    this.activeToolCalls.set(id, toolCall);

    if (this.thinkingDraft.length > 0 || this.streamingBlock !== null) {
      this.finalizeLiveTextBuffers('tool');
    }

    const existingComponent = this.pendingToolComponents.get(id);
    if (existingComponent !== undefined) {
      existingComponent.updateToolCall(toolCall);
    } else if (toolCall.name !== 'Agent') {
      this.onToolCallStart(toolCall);
    }
  }

  private tryAttachAgentToolCall(toolCall: ToolCallBlockData, tc: ToolCallComponent): boolean {
    const { state } = this.host;
    if (toolCall.name !== 'Agent') {
      this.pendingAgentGroup = null;
      return false;
    }

    const step = toolCall.step ?? this.currentStep;
    const turnId = toolCall.turnId ?? this.currentTurnId;
    const pending = this.pendingAgentGroup;

    if (pending !== null && (pending.step !== step || pending.turnId !== turnId)) {
      this.pendingAgentGroup = null;
    }

    const cur = this.pendingAgentGroup;
    if (cur === null) {
      this.pendingAgentGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }

    if (cur.group !== undefined) {
      cur.group.attach(toolCall.id, tc);
      return true;
    }

    const solo = cur.solo;
    if (solo === undefined) {
      this.pendingAgentGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }
    const group = this.upgradeSoloAgentToGroup(solo);
    group.attach(toolCall.id, tc);
    this.pendingAgentGroup = { step, turnId, group };
    state.ui.requestRender();
    return true;
  }

  private upgradeSoloAgentToGroup(solo: ToolCallComponent): AgentGroupComponent {
    const { state } = this.host;
    const group = new AgentGroupComponent(state.theme.colors, state.ui);
    const children = state.transcriptContainer.children;
    const idx = children.indexOf(solo);
    if (idx >= 0) {
      children[idx] = group;
      state.transcriptContainer.invalidate();
    } else {
      state.transcriptContainer.addChild(group);
    }
    group.attach(solo.toolCallView.id, solo);
    return group;
  }

  private tryAttachReadToolCall(toolCall: ToolCallBlockData, tc: ToolCallComponent): boolean {
    const { state } = this.host;
    if (toolCall.name !== 'Read') {
      this.pendingReadGroup = null;
      return false;
    }

    const step = toolCall.step ?? this.currentStep;
    const turnId = toolCall.turnId ?? this.currentTurnId;
    const pending = this.pendingReadGroup;

    if (pending !== null && (pending.step !== step || pending.turnId !== turnId)) {
      this.pendingReadGroup = null;
    }

    const cur = this.pendingReadGroup;
    if (cur === null) {
      this.pendingReadGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }

    if (cur.group !== undefined) {
      cur.group.attach(toolCall.id, tc);
      return true;
    }

    const solo = cur.solo;
    if (solo === undefined) {
      this.pendingReadGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }
    const group = this.upgradeSoloReadToGroup(solo);
    group.attach(toolCall.id, tc);
    this.pendingReadGroup = { step, turnId, group };
    state.ui.requestRender();
    return true;
  }

  private upgradeSoloReadToGroup(solo: ToolCallComponent): ReadGroupComponent {
    const { state } = this.host;
    const group = new ReadGroupComponent(state.theme.colors, state.ui);
    const children = state.transcriptContainer.children;
    const idx = children.indexOf(solo);
    if (idx >= 0) {
      children[idx] = group;
      state.transcriptContainer.invalidate();
    } else {
      state.transcriptContainer.addChild(group);
    }
    group.attach(solo.toolCallView.id, solo);
    return group;
  }
}
