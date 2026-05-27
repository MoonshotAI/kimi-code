import type { Session } from '@moonshot-ai/kimi-code-sdk';

import { AgentGroupComponent } from '../components/messages/agent-group';
import { AssistantMessageComponent } from '../components/messages/assistant-message';
import { CompactionComponent } from '../components/dialogs/compaction';
import { ReadGroupComponent } from '../components/messages/read-group';
import { ThinkingComponent } from '../components/messages/thinking';
import { ToolCallComponent } from '../components/messages/tool-call';
import { STREAMING_UI_FLUSH_MS } from '../constant/streaming';
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
} from '../types';
import type { TUIState } from '../kimi-tui';

export interface StreamingUIHost {
  state: TUIState;
  session: Session | undefined;
  setAppState(patch: Partial<AppState>): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  resetLivePane(): void;
  updateActivityPane(): void;
  updateQueueDisplay(): void;
  disposeActiveThinkingComponent(): void;
  disposeAndClearPendingToolComponents(): void;
  requireSession(): Session;
  deferUserMessages: boolean;
}

export class StreamingUIController {
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFlushAt: number | undefined;
  private pendingAssistantFlush = false;
  private pendingThinkingFlush = false;
  readonly pendingToolCallFlushIds = new Set<string>();

  constructor(private readonly host: StreamingUIHost) {}

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

    if (shouldFlushThinking && this.host.state.thinkingDraft.length > 0) {
      this.onThinkingUpdate(this.host.state.thinkingDraft);
    }
    if (shouldFlushAssistant) {
      this.onStreamingTextUpdate(this.host.state.assistantDraft);
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
    if (this.host.state.thinkingDraft.length === 0) {
      this.host.patchLivePane({ mode: nextMode });
      return;
    }
    this.host.state.thinkingDraft = '';
    this.onThinkingEnd();
    this.host.patchLivePane({ mode: nextMode });
  }

  finalizeAssistantStream(): void {
    this.flushNow();
    if (this.host.state.assistantStreamActive) {
      this.onStreamingTextEnd();
      this.host.state.assistantStreamActive = false;
    }
    this.host.state.assistantDraft = '';
    this.host.updateActivityPane();
    this.host.state.ui.requestRender();
  }

  resetLiveText(): void {
    this.pendingAssistantFlush = false;
    this.pendingThinkingFlush = false;
    this.clearFlushTimerIfIdle();
    this.host.state.assistantDraft = '';
    this.host.state.assistantStreamActive = false;
    this.host.state.streamingComponent = undefined;
    this.host.state.streamingTranscriptEntry = undefined;
    this.host.state.thinkingDraft = '';
    this.host.disposeActiveThinkingComponent();
  }

  resetToolUi(): void {
    this.pendingToolCallFlushIds.clear();
    this.clearFlushTimerIfIdle();
    this.host.state.streamingToolCallArguments.clear();
    this.host.disposeAndClearPendingToolComponents();
    this.host.state.pendingAgentGroup = null;
    this.host.state.pendingReadGroup = null;
  }

  resetToolCallState(): void {
    this.host.state.activeToolCalls.clear();
  }

  finalizeLiveTextBuffers(nextMode: LivePaneState['mode'] = 'idle'): void {
    this.flushThinkingToTranscript(nextMode);
    this.finalizeAssistantStream();
  }

  finalizeTurn(sendQueued: (item: QueuedMessage) => void): void {
    const { state } = this.host;
    if (!state.appState.isStreaming) return;
    this.host.deferUserMessages = false;
    const completedTurnKey =
      state.currentTurnId ?? `local:${String(state.appState.streamingStartTime)}`;
    this.finalizeLiveTextBuffers('idle');
    this.resetToolCallState();
    state.currentTurnId = undefined;

    if (state.queuedMessages.length > 0) {
      const [next, ...rest] = state.queuedMessages;
      state.queuedMessages = rest;
      this.host.setAppState({ isStreaming: false, streamingPhase: 'idle' });
      this.host.resetLivePane();
      if (next !== undefined) {
        setTimeout(() => {
          sendQueued(next);
        }, 0);
      }
      return;
    }

    this.host.setAppState({ isStreaming: false, streamingPhase: 'idle' });
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
    state.pendingAgentGroup = null;
    state.pendingReadGroup = null;
    const entry = {
      id: nextTranscriptId(),
      kind: 'assistant' as const,
      turnId: state.currentTurnId,
      renderMode: 'markdown' as const,
      content: '',
    };
    state.streamingComponent = new AssistantMessageComponent(
      state.theme.markdownTheme,
      state.theme.colors,
    );
    state.streamingTranscriptEntry = entry;
    state.transcriptEntries.push(entry);
    state.transcriptContainer.addChild(state.streamingComponent);
    state.ui.requestRender();
  }

  onStreamingTextUpdate(fullText: string): void {
    const { state } = this.host;
    if (state.streamingTranscriptEntry !== undefined) {
      state.streamingTranscriptEntry.content = fullText;
    }
    if (state.streamingComponent) {
      state.streamingComponent.updateContent(fullText);
      state.ui.requestRender();
    }
  }

  onStreamingTextEnd(): void {
    this.host.state.streamingComponent = undefined;
    this.host.state.streamingTranscriptEntry = undefined;
  }

  onThinkingUpdate(fullText: string): void {
    const { state } = this.host;
    if (state.activeThinkingComponent === undefined) {
      state.pendingAgentGroup = null;
      state.pendingReadGroup = null;
      state.activeThinkingComponent = new ThinkingComponent(
        fullText,
        state.theme.colors,
        true,
        'live',
        state.ui,
      );
      if (state.toolOutputExpanded) state.activeThinkingComponent.setExpanded(true);
      state.transcriptContainer.addChild(state.activeThinkingComponent);
    } else {
      state.activeThinkingComponent.setText(fullText);
    }
    state.ui.requestRender();
  }

  onThinkingEnd(): void {
    const { state } = this.host;
    if (state.activeThinkingComponent === undefined) return;
    state.activeThinkingComponent.finalize();
    state.activeThinkingComponent = undefined;
    state.ui.requestRender();
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
    state.pendingToolComponents.set(toolCall.id, tc);

    if (toolCall.name !== 'Agent') state.pendingAgentGroup = null;
    if (toolCall.name !== 'Read') state.pendingReadGroup = null;

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
    const matchedCall = state.activeToolCalls.get(toolCallId);
    const tc = state.pendingToolComponents.get(toolCallId);
    if (tc) {
      tc.setResult(result);
      state.pendingToolComponents.delete(toolCallId);
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
    if (state.activeCompactionBlock !== undefined) {
      state.activeCompactionBlock.markDone();
      state.activeCompactionBlock = undefined;
    }
    const block = new CompactionComponent(state.theme.colors, state.ui, instruction);
    state.activeCompactionBlock = block;
    state.transcriptContainer.addChild(block);
    state.ui.requestRender();
  }

  endCompaction(tokensBefore?: number, tokensAfter?: number): void {
    const block = this.host.state.activeCompactionBlock;
    if (block === undefined) return;
    block.markDone(tokensBefore, tokensAfter);
    this.host.state.activeCompactionBlock = undefined;
    this.host.state.ui.requestRender();
  }

  cancelCompaction(): void {
    const block = this.host.state.activeCompactionBlock;
    if (block === undefined) return;
    block.markCanceled();
    this.host.state.activeCompactionBlock = undefined;
    this.host.state.ui.requestRender();
  }

  // ---------------------------------------------------------------------------
  // Tool call grouping
  // ---------------------------------------------------------------------------

  private flushToolCallPreview(id: string): void {
    const { state } = this.host;
    const streaming = state.streamingToolCallArguments.get(id);
    if (streaming === undefined) return;
    const toolCall: ToolCallBlockData = {
      id,
      name: streaming.name ?? state.activeToolCalls.get(id)?.name ?? 'Tool',
      args: parseStreamingArgs(streaming.argumentsText),
      streamingArguments: streaming.argumentsText,
      streamingStartedAtMs: streaming.startedAtMs,
      step: state.currentStep,
      turnId: state.currentTurnId,
    };
    state.activeToolCalls.set(id, toolCall);

    if (state.thinkingDraft.length > 0 || state.assistantStreamActive) {
      this.finalizeLiveTextBuffers('tool');
    }

    const existingComponent = state.pendingToolComponents.get(id);
    if (existingComponent !== undefined) {
      existingComponent.updateToolCall(toolCall);
    } else if (toolCall.name !== 'Agent') {
      this.onToolCallStart(toolCall);
    }
  }

  private tryAttachAgentToolCall(toolCall: ToolCallBlockData, tc: ToolCallComponent): boolean {
    const { state } = this.host;
    if (toolCall.name !== 'Agent') {
      state.pendingAgentGroup = null;
      return false;
    }

    const step = toolCall.step ?? state.currentStep;
    const turnId = toolCall.turnId ?? state.currentTurnId;
    const pending = state.pendingAgentGroup;

    if (pending !== null && (pending.step !== step || pending.turnId !== turnId)) {
      state.pendingAgentGroup = null;
    }

    const cur = state.pendingAgentGroup;
    if (cur === null) {
      state.pendingAgentGroup = { step, turnId, solo: tc };
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
      state.pendingAgentGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }
    const group = this.upgradeSoloAgentToGroup(solo);
    group.attach(toolCall.id, tc);
    state.pendingAgentGroup = { step, turnId, group };
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
      state.pendingReadGroup = null;
      return false;
    }

    const step = toolCall.step ?? state.currentStep;
    const turnId = toolCall.turnId ?? state.currentTurnId;
    const pending = state.pendingReadGroup;

    if (pending !== null && (pending.step !== step || pending.turnId !== turnId)) {
      state.pendingReadGroup = null;
    }

    const cur = state.pendingReadGroup;
    if (cur === null) {
      state.pendingReadGroup = { step, turnId, solo: tc };
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
      state.pendingReadGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }
    const group = this.upgradeSoloReadToGroup(solo);
    group.attach(toolCall.id, tc);
    state.pendingReadGroup = { step, turnId, group };
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
