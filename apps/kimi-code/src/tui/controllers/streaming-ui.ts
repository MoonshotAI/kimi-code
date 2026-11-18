import type { Session } from '@moonshot-ai/kimi-code-sdk';

import { AgentGroupComponent } from '../components/messages/agent-group';
import { AssistantMessageComponent } from '../components/messages/assistant-message';
import { CompactionComponent } from '../components/dialogs/compaction';
import { ReadGroupComponent } from '../components/messages/read-group';
import { ThinkingComponent } from '../components/messages/thinking';
import { ToolCallComponent } from '../components/messages/tool-call';
import { STREAMING_UI_FLUSH_MS, UNNAMED_TOOL_CALL_NAME } from '../constant/streaming';
import { hasDispose } from '../utils/component-capabilities';
import { appendStreamingArgsPreview, parseStreamingArgs } from '../utils/event-payload';
import { notifyTerminalOnce } from '../utils/terminal-notification';
import {
  getTranscriptComponentTurnId,
  markTranscriptComponent,
  markTranscriptComponentTurnId,
} from '../utils/transcript-component-metadata';
import { nextTranscriptId } from '../utils/transcript-id';
import { TurnTimeline } from '../utils/turn-timeline';
import type {
  AppState,
  Elapsed,
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
  updateActivityPaneForTranscriptGrouping(): void;
  updateQueueDisplay(): void;
  requireSession(): Session;
  deferUserMessages: boolean;
  shiftQueuedMessage(): QueuedMessage | undefined;
  pushTranscriptEntry(entry: TranscriptEntry): void;
  mergeCurrentTurnSteps(): void;
  mergeCompletedTurnAssistants(): void;
}

export class StreamingUIController {
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFlushAt: number | undefined;
  private pendingAssistantFlush = false;
  private pendingThinkingFlush = false;
  readonly pendingToolCallFlushIds = new Set<string>();

  private _currentTurnId: string | undefined = undefined;
  private _currentStep = 0;
  private _assistantDraft = '';
  private _thinkingDraft = '';
  private _streamingBlock: { component: AssistantMessageComponent; entry: TranscriptEntry } | null = null;
  private _activeThinkingComponent: ThinkingComponent | undefined = undefined;
  private _activeCompaction: { instruction: string | undefined } | undefined = undefined;
  private _activeToolCalls = new Map<string, ToolCallBlockData>();
  private _runningWaitForCalls = new Set<string>();
  private _streamingToolCallArguments = new Map<
    string,
    { name?: string; argumentsText: string; startedAtMs: number }
  >();
  private _pendingToolComponents = new Map<string, ToolCallComponent>();
  private _pendingAgentGroup: {
    readonly turnId: string | undefined;
    readonly step: number;
    solo?: ToolCallComponent;
    group?: AgentGroupComponent;
  } | null = null;
  private _pendingReadGroup: {
    readonly turnId: string | undefined;
    readonly step: number;
    solo?: ToolCallComponent;
    group?: ReadGroupComponent;
  } | null = null;

  readonly timeline = new TurnTimeline();

  constructor(private readonly host: StreamingUIHost) {}

  getTurnContext(): { turnId: string | undefined; step: number } {
    return { turnId: this._currentTurnId, step: this._currentStep };
  }

  setTurnId(turnId: string | undefined): void {
    this._currentTurnId = turnId;
  }

  setStep(step: number): void {
    this._currentStep = step;
  }

  hasActiveTurn(): boolean {
    return this._currentTurnId !== undefined;
  }

  appendThinkingDelta(delta: string): void {
    this._thinkingDraft += delta;
    this.pendingThinkingFlush = true;
  }

  appendAssistantDelta(delta: string): void {
    if (this._streamingBlock === null) {
      this.onStreamingTextStart();
    }
    this._assistantDraft += delta;
    this.pendingAssistantFlush = true;
  }

  hasThinkingDraft(): boolean {
    return this._thinkingDraft.length > 0;
  }

  hasActiveThinkingComponent(): boolean {
    return this._activeThinkingComponent !== undefined;
  }

  hasStreamingBlock(): boolean {
    return this._streamingBlock !== null;
  }

  getStreamingBlockComponent(): AssistantMessageComponent | undefined {
    return this._streamingBlock?.component;
  }

  clearAssistantDraft(): void {
    this._assistantDraft = '';
  }

  getActiveToolCall(id: string): ToolCallBlockData | undefined {
    return this._activeToolCalls.get(id);
  }

  hasActiveToolCall(id: string): boolean {
    return this._activeToolCalls.has(id);
  }

  markWaitForRunning(toolCallId: string): boolean {
    if (this._activeToolCalls.get(toolCallId)?.name !== 'WaitFor') return false;
    if (this._runningWaitForCalls.has(toolCallId)) return false;
    this._runningWaitForCalls.add(toolCallId);
    return true;
  }

  isWaitForRunning(): boolean {
    return this._runningWaitForCalls.size > 0;
  }

  setActiveToolCall(id: string, toolCall: ToolCallBlockData): void {
    this._activeToolCalls.set(id, toolCall);
  }

  removeActiveToolCall(id: string): void {
    this._activeToolCalls.delete(id);
  }

  getToolComponent(id: string): ToolCallComponent | undefined {
    return this._pendingToolComponents.get(id);
  }

  removeToolComponent(id: string): void {
    this._pendingToolComponents.delete(id);
  }

  hasPendingAgentGroup(): boolean {
    return this._pendingAgentGroup !== null;
  }

  hasPendingReadGroup(): boolean {
    return this._pendingReadGroup !== null;
  }

  removeToolComponentIfInactive(toolCallId: string): void {
    if (!this._activeToolCalls.has(toolCallId)) {
      this._pendingToolComponents.delete(toolCallId);
    }
  }

  discardToolCall(toolCallId: string): void {
    const component = this._pendingToolComponents.get(toolCallId);
    this._pendingToolComponents.delete(toolCallId);
    this._activeToolCalls.delete(toolCallId);
    if (component === undefined) return;
    this.host.state.transcriptContainer.removeChild(component);
    this.host.state.ui.requestRender();
  }

  applyBackgroundTaskTerminalStatus(args: {
    agentId?: string | undefined;
    description: string;
    status: 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';
    errorText?: string | undefined;
  }): boolean {
    const useAgentIdOnly = args.agentId !== undefined;
    let agentIdMatch: ToolCallComponent | undefined;
    let descMatch: ToolCallComponent | undefined;
    let descAmbiguous = false;
    const visit = (tc: ToolCallComponent): void => {
      if (agentIdMatch !== undefined) return;
      if (useAgentIdOnly) {
        if (tc.getSubagentAgentId() === args.agentId) agentIdMatch = tc;
        return;
      }
      if (tc.getAgentToolDescription() !== args.description) return;
      if (descMatch !== undefined) {
        descAmbiguous = true;
        return;
      }
      descMatch = tc;
    };

    for (const tc of this._pendingToolComponents.values()) {
      visit(tc);
      if (agentIdMatch !== undefined) break;
    }
    if (agentIdMatch === undefined) {
      for (const child of this.host.state.transcriptContainer.children) {
        if (child instanceof ToolCallComponent) {
          visit(child);
        } else if (child instanceof AgentGroupComponent) {
          for (const tc of child.getToolComponents()) {
            visit(tc);
            if (agentIdMatch !== undefined) break;
          }
        }
        if (agentIdMatch !== undefined) break;
      }
    }
    const target = useAgentIdOnly
      ? agentIdMatch
      : descAmbiguous
        ? undefined
        : descMatch;
    if (target === undefined) return false;
    target.setBackgroundTaskTerminalStatus(args.status, { errorText: args.errorText });
    return true;
  }

  markSubagentBackgrounded(agentId: string | undefined): boolean {
    if (agentId === undefined) return false;
    const visit = (tc: ToolCallComponent): boolean => {
      if (tc.getSubagentAgentId() !== agentId) return false;
      const phase = tc.getSubagentSnapshot().phase;
      if (phase !== 'running' && phase !== 'queued' && phase !== 'spawning') return false;
      tc.markBackgrounded();
      return true;
    };
    for (const tc of this._pendingToolComponents.values()) {
      if (visit(tc)) return true;
    }
    for (const child of this.host.state.transcriptContainer.children) {
      if (child instanceof ToolCallComponent) {
        if (visit(child)) return true;
      } else if (child instanceof AgentGroupComponent) {
        for (const tc of child.getToolComponents()) {
          if (visit(tc)) return true;
        }
      }
    }
    return false;
  }

  registerToolCall(toolCall: ToolCallBlockData): boolean {
    const existing = this._activeToolCalls.get(toolCall.id);
    this._activeToolCalls.set(toolCall.id, toolCall);
    this.pendingToolCallFlushIds.delete(toolCall.id);
    this._streamingToolCallArguments.delete(toolCall.id);
    const existingComponent = this._pendingToolComponents.get(toolCall.id);
    if (existingComponent !== undefined) {
      existingComponent.updateToolCall(toolCall);
      this.host.updateActivityPaneForTranscriptGrouping();
    } else if (existing === undefined) {
      this.finalizeLiveTextBuffers('tool');
      if (toolCall.name !== 'Agent' && toolCall.name !== 'AgentSwarm') {
        this.onToolCallStart(toolCall);
      }
    }
    return existing === undefined;
  }

  accumulateToolCallDelta(
    id: string,
    eventName: string | undefined,
    argumentsPart: string | null | undefined,
  ): void {
    const existing = this._streamingToolCallArguments.get(id);
    const argumentsText = appendStreamingArgsPreview(existing?.argumentsText, argumentsPart);
    const name = eventName ?? existing?.name ?? this._activeToolCalls.get(id)?.name ?? UNNAMED_TOOL_CALL_NAME;
    const startedAtMs = existing?.startedAtMs ?? Date.now();
    this._streamingToolCallArguments.set(id, { name, argumentsText, startedAtMs });
    this.pendingToolCallFlushIds.add(id);
  }

  getStreamingToolCallPreview(
    id: string,
  ): { name: string; args: Record<string, unknown>; argumentsText: string; startedAtMs: number } | undefined {
    const streaming = this._streamingToolCallArguments.get(id);
    if (streaming === undefined) return undefined;
    return {
      name: streaming.name ?? this._activeToolCalls.get(id)?.name ?? UNNAMED_TOOL_CALL_NAME,
      args: parseStreamingArgs(streaming.argumentsText),
      argumentsText: streaming.argumentsText,
      startedAtMs: streaming.startedAtMs,
    };
  }

  completeToolResult(toolCallId: string, result: ToolResultBlockData): ToolCallBlockData | undefined {
    const matchedCall = this._activeToolCalls.get(toolCallId);
    if (matchedCall !== undefined) {
      this.onToolCallEnd(toolCallId, result);
    }
    this._activeToolCalls.delete(toolCallId);
    this._runningWaitForCalls.delete(toolCallId);
    this._streamingToolCallArguments.delete(toolCallId);
    return matchedCall;
  }

  markStepTruncated(turnId: string, step: number): number {
    let count = 0;
    for (const toolCall of this._activeToolCalls.values()) {
      if (toolCall.result !== undefined) continue;
      if (toolCall.streamingArguments === undefined) continue;
      if (toolCall.turnId !== turnId) continue;
      if (toolCall.step !== step) continue;
      toolCall.truncated = true;
      const component = this._pendingToolComponents.get(toolCall.id);
      if (component !== undefined) {
        component.updateToolCall(toolCall);
      }
      count += 1;
    }
    this._streamingToolCallArguments.clear();
    return count;
  }

  cleanupAfterReplay(completedToolCallIds: Set<string>): void {
    this._activeToolCalls.clear();
    for (const toolCallId of completedToolCallIds) {
      this._pendingToolComponents.delete(toolCallId);
    }
    this._pendingAgentGroup = null;
    this._pendingReadGroup = null;
    this._currentTurnId = undefined;
    this._currentStep = 0;
    this._streamingToolCallArguments.clear();
    this.pendingToolCallFlushIds.clear();
    this.host.state.ui.requestRender();
  }

  disposeActiveThinkingComponent(): void {
    if (this._activeThinkingComponent !== undefined) {
      this._activeThinkingComponent.dispose();
      this._activeThinkingComponent = undefined;
    }
  }

  disposeAndClearPendingToolComponents(): void {
    for (const component of this._pendingToolComponents.values()) {
      if (hasDispose(component)) component.dispose();
    }
    this._pendingToolComponents.clear();
  }

  clearActiveCompaction(): void {
    this._activeCompaction = undefined;
  }

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

    if (shouldFlushThinking && this._thinkingDraft.length > 0) {
      this.onThinkingUpdate(this._thinkingDraft);
    }
    if (shouldFlushAssistant) {
      this.onStreamingTextUpdate(this._assistantDraft);
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

  flushThinkingToTranscript(nextMode: LivePaneState['mode'] = 'idle'): void {
    this.flushNow();
    this._thinkingDraft = '';
    this.onThinkingEnd();
    this.host.patchLivePane({ mode: nextMode });
  }

  finalizeAssistantStream(): void {
    this.flushNow();
    if (this._streamingBlock !== null) {
      this.onStreamingTextEnd();
    }
    this._assistantDraft = '';
    this.host.updateActivityPane();
    this.host.state.ui.requestRender();
  }

  resetLiveText(): void {
    this.pendingAssistantFlush = false;
    this.pendingThinkingFlush = false;
    this.clearFlushTimerIfIdle();
    this._assistantDraft = '';
    this._streamingBlock = null;
    this._thinkingDraft = '';
    this.disposeActiveThinkingComponent();
  }

  resetToolUi(): void {
    this.pendingToolCallFlushIds.clear();
    this.clearFlushTimerIfIdle();
    this._streamingToolCallArguments.clear();
    this.disposeAndClearPendingToolComponents();
    this._pendingAgentGroup = null;
    this._pendingReadGroup = null;
    this.resetToolCallState();
  }

  resetToolCallState(): void {
    this._activeToolCalls.clear();
    this._runningWaitForCalls.clear();
  }

  finalizeLiveTextBuffers(nextMode: LivePaneState['mode'] = 'idle'): void {
    this.flushThinkingToTranscript(nextMode);
    this.finalizeAssistantStream();
  }

  finalizeTurn(sendQueued: (item: QueuedMessage) => void): void {
    this.timeline.turnEnded();
    const { state } = this.host;
    if (state.appState.streamingPhase === 'idle') return;
    this.host.deferUserMessages = false;
    const completedTurnKey =
      this._currentTurnId ?? `local:${String(state.appState.streamingStartTime)}`;
    this.finalizeLiveTextBuffers('idle');
    this.host.mergeCompletedTurnAssistants();
    this.resetToolCallState();
    this._currentTurnId = undefined;

    const next = this.host.shiftQueuedMessage();
    if (next !== undefined) {
      state.queuedMessageDispatchPending = true;
      this.host.setAppState({ streamingPhase: 'idle' });
      this.host.resetLivePane();
      setTimeout(() => {
        state.queuedMessageDispatchPending = false;
        sendQueued(next);
      }, 0);
      return;
    }

    this.host.setAppState({ streamingPhase: 'idle' });
    this.host.resetLivePane();
    notifyTerminalOnce(state, `turn-complete:${completedTurnKey}`, {
      title: 'Kimi Code task complete',
      body: state.appState.sessionTitle ?? undefined,
    });
  }

  onStreamingTextStart(): void {
    const { state } = this.host;
    this._pendingAgentGroup = null;
    this._pendingReadGroup = null;
    const entry = {
      id: nextTranscriptId(),
      kind: 'assistant' as const,
      turnId: this._currentTurnId,
      renderMode: 'markdown' as const,
      content: '',
      modelText: true,
    };
    const component = new AssistantMessageComponent();
    this._streamingBlock = { component, entry };
    markTranscriptComponent(component, entry);
    state.transcriptContainer.addChild(component);
    this.host.pushTranscriptEntry(entry);
    state.ui.requestRender();
  }

  onStreamingTextUpdate(fullText: string): void {
    const block = this._streamingBlock;
    if (block !== null) {
      block.entry.content = fullText;
      block.component.updateContent(fullText, { transient: true });
      this.host.state.ui.requestRender();
    }
  }

  onStreamingTextEnd(): void {
    const block = this._streamingBlock;
    if (block !== null) {
      block.component.updateContent(block.entry.content, { transient: false });
    }
    this._streamingBlock = null;
  }

  onThinkingUpdate(fullText: string): void {
    if (fullText.trim().length === 0 && this._activeThinkingComponent === undefined) return;
    const { state } = this.host;
    if (this._activeThinkingComponent === undefined) {
      this._pendingAgentGroup = null;
      this._pendingReadGroup = null;
      this._activeThinkingComponent = new ThinkingComponent(
        fullText,
        true,
        'live',
        state.ui,
      );
      if (state.transcriptContainer.toolOutputExpanded) this._activeThinkingComponent.setExpanded(true);
      markTranscriptComponentTurnId(this._activeThinkingComponent, this._currentTurnId);
      state.transcriptContainer.addChild(this._activeThinkingComponent);
    } else {
      this._activeThinkingComponent.setText(fullText);
    }
    state.ui.requestRender();
  }

  onThinkingEnd(): void {
    if (this._activeThinkingComponent === undefined) return;
    const component = this._activeThinkingComponent;
    component.finalize(elapsedSince(component.startedAtMs, this.host.state.appState.isReplaying));
    this._activeThinkingComponent = undefined;
    this.host.state.ui.requestRender();
    this.host.mergeCurrentTurnSteps();
  }

  onToolCallStart(toolCall: ToolCallBlockData): void {
    if (toolCall.name === 'AskUserQuestion') return;

    const { state } = this.host;
    const tc = new ToolCallComponent(
      toolCall,
      undefined,
      state.ui,
      state.appState.workDir,
    );
    if (state.transcriptContainer.toolOutputExpanded) tc.setExpanded(true);
    markTranscriptComponentTurnId(tc, toolCall.turnId ?? this._currentTurnId);
    this._pendingToolComponents.set(toolCall.id, tc);

    if (toolCall.name !== 'Agent') this._pendingAgentGroup = null;
    if (toolCall.name !== 'Read') this._pendingReadGroup = null;

    let handled = this.tryAttachAgentToolCall(toolCall, tc);
    if (!handled) handled = this.tryAttachReadToolCall(toolCall, tc);
    if (!handled) {
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
    }
    this.host.updateActivityPaneForTranscriptGrouping();

    if (toolCall.name === 'ExitPlanMode' && typeof toolCall.args['plan'] !== 'string') {
      const session = this.host.requireSession();
      void (async () => {
        try {
          const plan = await session.getPlan();
          tc.setPlanInfo(plan === null ? {} : { plan: plan.content, path: plan.path ?? undefined });
        } catch {
          tc.setPlanInfo({});
        }
      })();
    }
  }

  onToolCallEnd(toolCallId: string, result: ToolResultBlockData): void {
    const { state } = this.host;
    const matchedCall = this._activeToolCalls.get(toolCallId);
    const tc = this._pendingToolComponents.get(toolCallId);
    if (tc) {
      tc.setResult(result, elapsedSince(tc.startedAtMs, state.appState.isReplaying));
      this._pendingToolComponents.delete(toolCallId);
      this.host.updateActivityPaneForTranscriptGrouping();
      state.ui.requestRender();
      this.host.mergeCurrentTurnSteps();
      return;
    }

    if (matchedCall?.name === 'AskUserQuestion') {
      const completed = new ToolCallComponent(
        matchedCall,
        result,
        state.ui,
        state.appState.workDir,
      );
      if (state.transcriptContainer.toolOutputExpanded) completed.setExpanded(true);
      markTranscriptComponentTurnId(completed, matchedCall.turnId ?? this._currentTurnId);
      state.transcriptContainer.addChild(completed);
      state.ui.requestRender();
    }
    this.host.mergeCurrentTurnSteps();
  }

  beginCompaction(instruction?: string): void {
    if (this._activeCompaction !== undefined) this.endCompaction();
    this._activeCompaction = { instruction };
    this.host.state.ui.requestRender();
  }

  endCompaction(tokensBefore?: number, tokensAfter?: number, summary?: string): void {
    const compaction = this._activeCompaction;
    if (compaction === undefined) return;
    const { state } = this.host;
    const block = new CompactionComponent(state.ui, compaction.instruction);
    block.markDone(tokensBefore, tokensAfter, summary);
    this._activeCompaction = undefined;
    this.mountCompactionBlock(block);
    state.ui.requestRender();
  }

  cancelCompaction(): void {
    const compaction = this._activeCompaction;
    if (compaction === undefined) return;
    const { state } = this.host;
    const block = new CompactionComponent(state.ui, compaction.instruction);
    block.markCanceled();
    this._activeCompaction = undefined;
    this.mountCompactionBlock(block);
    state.ui.requestRender();
  }

  private mountCompactionBlock(block: CompactionComponent): void {
    const { state } = this.host;
    markTranscriptComponentTurnId(block, this._currentTurnId);
    state.transcriptContainer.addChild(block);
    if (state.transcriptContainer.toolOutputExpanded) block.setExpanded(true);
  }

  private flushToolCallPreview(id: string): void {
    const streaming = this._streamingToolCallArguments.get(id);
    if (streaming === undefined) return;
    const toolCall: ToolCallBlockData = {
      id,
      name: streaming.name ?? this._activeToolCalls.get(id)?.name ?? UNNAMED_TOOL_CALL_NAME,
      args: parseStreamingArgs(streaming.argumentsText),
      streamingArguments: streaming.argumentsText,
      streamingStartedAtMs: streaming.startedAtMs,
      step: this._currentStep,
      turnId: this._currentTurnId,
    };
    this._activeToolCalls.set(id, toolCall);

    if (this._thinkingDraft.length > 0 || this._streamingBlock !== null) {
      this.finalizeLiveTextBuffers('tool');
    }

    const existingComponent = this._pendingToolComponents.get(id);
    if (existingComponent !== undefined) {
      existingComponent.updateToolCall(toolCall);
    } else if (toolCall.name !== 'Agent' && toolCall.name !== 'AgentSwarm') {
      this.onToolCallStart(toolCall);
    }
  }

  private tryAttachAgentToolCall(toolCall: ToolCallBlockData, tc: ToolCallComponent): boolean {
    const { state } = this.host;
    if (toolCall.name !== 'Agent') {
      this._pendingAgentGroup = null;
      return false;
    }

    const step = toolCall.step ?? this._currentStep;
    const turnId = toolCall.turnId ?? this._currentTurnId;
    const pending = this._pendingAgentGroup;

    if (pending !== null && (pending.step !== step || pending.turnId !== turnId)) {
      this._pendingAgentGroup = null;
    }

    const cur = this._pendingAgentGroup;
    if (cur === null) {
      this._pendingAgentGroup = { step, turnId, solo: tc };
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
      this._pendingAgentGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }
    const group = this.upgradeSoloAgentToGroup(solo);
    group.attach(toolCall.id, tc);
    this._pendingAgentGroup = { step, turnId, group };
    state.ui.requestRender();
    return true;
  }

  private upgradeSoloAgentToGroup(solo: ToolCallComponent): AgentGroupComponent {
    const { state } = this.host;
    const group = new AgentGroupComponent(state.ui);
    markTranscriptComponentTurnId(group, getTranscriptComponentTurnId(solo) ?? this._currentTurnId);
    if (state.transcriptContainer.children.includes(solo)) {
      state.transcriptContainer.replaceChild(solo, group);
    } else {
      state.transcriptContainer.addChild(group);
    }
    group.attach(solo.toolCallView.id, solo);
    return group;
  }

  private tryAttachReadToolCall(toolCall: ToolCallBlockData, tc: ToolCallComponent): boolean {
    const { state } = this.host;
    if (toolCall.name !== 'Read') {
      this._pendingReadGroup = null;
      return false;
    }

    const step = toolCall.step ?? this._currentStep;
    const turnId = toolCall.turnId ?? this._currentTurnId;
    const pending = this._pendingReadGroup;

    if (pending !== null && (pending.step !== step || pending.turnId !== turnId)) {
      this._pendingReadGroup = null;
    }

    const cur = this._pendingReadGroup;
    if (cur === null) {
      this._pendingReadGroup = { step, turnId, solo: tc };
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
      this._pendingReadGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }
    const group = this.upgradeSoloReadToGroup(solo);
    group.attach(toolCall.id, tc);
    this._pendingReadGroup = { step, turnId, group };
    state.ui.requestRender();
    return true;
  }

  private upgradeSoloReadToGroup(solo: ToolCallComponent): ReadGroupComponent {
    const { state } = this.host;
    const group = new ReadGroupComponent(state.ui);
    markTranscriptComponentTurnId(group, getTranscriptComponentTurnId(solo) ?? this._currentTurnId);
    if (state.transcriptContainer.toolOutputExpanded) group.setExpanded(true);
    if (state.transcriptContainer.children.includes(solo)) {
      state.transcriptContainer.replaceChild(solo, group);
    } else {
      state.transcriptContainer.addChild(group);
    }
    group.attach(solo.toolCallView.id, solo);
    return group;
  }
}

function elapsedSince(startedAtMs: number, isReplaying: boolean): Elapsed {
  return isReplaying ? { known: false } : { known: true, ms: Date.now() - startedAtMs };
}
