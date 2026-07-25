/**
 * SubagentStateManager — owns all subagent lifecycle state for a single
 * Agent tool call.
 *
 * Extracted from ToolCallComponent to isolate the ~20 subagent-related
 * fields and ~15 methods. The manager calls `onStateChange` whenever
 * state mutates so the component can trigger a UI rebuild.
 */

import type { TokenUsage } from '@moonshot-ai/kimi-code-sdk';

import { BRAILLE_SPINNER_FRAMES, BRAILLE_SPINNER_INTERVAL_MS } from '#/tui/constant/rendering';
import { appendStreamingArgsPreview } from '#/tui/utils/event-payload';
import { t } from '#/i18n';

import { countNonEmptyLines } from '../tool-renderers/chip';
import {
  backgroundFailureMessage,
  computeLatestActivity,
  formatSubagentContextTokens,
  formatSubagentTokens,
  makeWorkspaceRelativePath,
  str,
  usageTotal,
} from './formatters';
import { parseArgsPreview } from './streaming-preview';
import type {
  FinishedSubCall,
  OngoingSubCall,
  SubToolActivity,
  SubagentCompletedPayload,
  SubagentFailedPayload,
  SubagentMetricsPayload,
  SubagentPhase,
  SubagentSpawnedMeta,
  SubagentStartedMeta,
  ToolCallBlockData,
  ToolCallReadSnapshot,
  ToolCallSubagentSnapshot,
  ToolResultBlockData,
} from './types';

const MAX_SUB_TOOL_CALLS_SHOWN = 4;
const MAX_LIVE_OUTPUT_CHARS = 50_000;
const MAX_SUBAGENT_DESCRIPTION_LENGTH = 60;

export type StateChangeCallback = () => void;

export class SubagentStateManager {
  // ── Identification ──
  private agentId: string | undefined;
  private agentName: string | undefined;

  // ── Sub-tool call tracking ──
  private readonly ongoingSubCalls = new Map<string, OngoingSubCall>();
  private readonly finishedSubCalls: FinishedSubCall[] = [];
  private readonly subToolActivities = new Map<string, SubToolActivity>();
  private subToolOrderSeq = 0;
  private hiddenSubCallCount = 0;

  // ── Text accumulation ──
  private text = '';
  private thinkingText = '';
  private lastStreamKind: 'thinking' | 'text' = 'text';

  // ── Lifecycle ──
  private phase: SubagentPhase | undefined;
  private detachedFromForeground = false;
  private backgroundTerminalPhase: 'done' | 'failed' | undefined;

  // ── Metrics ──
  private contextTokens: number | undefined;
  private usage: TokenUsage | undefined;
  private resultSummary: string | undefined;
  private error: string | undefined;

  // ── Timing ──
  private startedAtMs: number | undefined;
  private endedAtMs: number | undefined;
  private spinnerFrame = 0;
  private elapsedTimer: ReturnType<typeof setInterval> | undefined;

  // ── External refs ──
  private toolCall: ToolCallBlockData;
  private result: ToolResultBlockData | undefined;
  private readonly workspaceDir: string | undefined;
  private onStateChange: StateChangeCallback | undefined;

  constructor(
    toolCall: ToolCallBlockData,
    result: ToolResultBlockData | undefined,
    workspaceDir: string | undefined,
  ) {
    this.toolCall = toolCall;
    this.result = result;
    this.workspaceDir = workspaceDir;
  }

  // ── Setup ──

  setOnStateChange(cb: StateChangeCallback | undefined): void {
    this.onStateChange = cb;
  }

  updateToolCall(toolCall: ToolCallBlockData): void {
    this.toolCall = toolCall;
  }

  setResult(result: ToolResultBlockData | undefined): void {
    this.result = result;
    this.finalizeElapsedIfNeeded();
  }

  getResult(): ToolResultBlockData | undefined {
    return this.result;
  }

  getToolCall(): ToolCallBlockData {
    return this.toolCall;
  }

  applyReplay(subagent: ToolCallBlockData['subagent']): void {
    if (subagent === undefined) return;
    this.agentId = subagent.id;
    this.agentName = subagent.name;
    this.text = subagent.text ?? '';
    for (const call of subagent.toolCalls ?? []) {
      if (call.result === undefined) {
        this.ongoingSubCalls.set(call.id, { name: call.name, args: call.args });
        this.upsertSubToolActivity(call.id, call.name, call.args, 'ongoing');
        continue;
      }
      this.finishedSubCalls.push({
        name: call.name,
        args: call.args,
        output: call.result.output,
        isError: call.result.is_error ?? false,
      });
      this.upsertSubToolActivity(
        call.id,
        call.name,
        call.args,
        call.result.is_error === true ? 'failed' : 'done',
        call.result.output,
      );
    }
    while (this.finishedSubCalls.length > MAX_SUB_TOOL_CALLS_SHOWN) {
      this.finishedSubCalls.shift();
      this.hiddenSubCallCount += 1;
    }
  }

  // ── Event handlers ──

  onSpawned(meta: SubagentSpawnedMeta): void {
    this.agentId = meta.agentId;
    this.agentName = meta.agentName;
    this.phase = meta.runInBackground ? 'backgrounded' : 'queued';
    this.startedAtMs = Date.now();
    this.endedAtMs = undefined;
    this.notify();
  }

  onStarted(meta: SubagentStartedMeta): void {
    this.agentId = meta.agentId;
    this.agentName = meta.agentName;
    if (
      !meta.runInBackground &&
      (this.phase === undefined || this.phase === 'queued')
    ) {
      this.phase = 'running';
    }
    this.notify();
  }

  onCompleted(payload: SubagentCompletedPayload): void {
    this.phase = 'done';
    this.endedAtMs ??= Date.now();
    if (payload.contextTokens !== undefined && payload.contextTokens > 0) {
      this.contextTokens = payload.contextTokens;
    }
    this.usage = payload.usage;
    this.resultSummary =
      payload.resultSummary.length > 0 ? payload.resultSummary : undefined;
    if (this.text.trim().length === 0 && this.resultSummary !== undefined) {
      this.text = this.resultSummary;
    }
    this.notify();
  }

  onFailed(payload: SubagentFailedPayload): void {
    this.phase = 'failed';
    this.endedAtMs ??= Date.now();
    this.error = payload.error;
    this.notify();
  }

  updateMetrics(payload: SubagentMetricsPayload): void {
    if (payload.contextTokens !== undefined && payload.contextTokens > 0) {
      this.contextTokens = payload.contextTokens;
    }
    if (payload.usage !== undefined) {
      this.usage = payload.usage;
    }
    this.notify();
  }

  setBackgroundTaskTerminalStatus(
    status: 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost',
    options: { errorText?: string | undefined } = {},
  ): void {
    const newPhase: 'done' | 'failed' = status === 'completed' ? 'done' : 'failed';
    const { errorText } = options;
    const phaseUnchanged = this.backgroundTerminalPhase === newPhase;
    let errorChanged = false;
    if (newPhase === 'failed') {
      if (errorText !== undefined && this.error !== errorText) {
        this.error = errorText;
        errorChanged = true;
      } else if (this.error === undefined) {
        const generic = backgroundFailureMessage(status);
        if (generic !== undefined) {
          this.error = generic;
          errorChanged = true;
        }
      }
    }
    if (phaseUnchanged && !errorChanged) return;
    this.backgroundTerminalPhase = newPhase;
    this.endedAtMs ??= Date.now();
    this.notify();
  }

  markBackgrounded(): void {
    if (this.detachedFromForeground) return;
    this.detachedFromForeground = true;
    this.phase = 'backgrounded';
    this.notify();
  }

  appendText(text: string, kind: 'thinking' | 'text' = 'text'): void {
    this.lastStreamKind = kind;
    if (kind === 'thinking') {
      this.thinkingText += text;
    } else {
      this.text += text;
    }
    if (
      this.phase === undefined ||
      this.phase === 'queued' ||
      this.phase === 'spawning'
    ) {
      this.phase = 'running';
    }
    this.notify();
  }

  appendSubToolCall(call: { id: string; name: string; args: Record<string, unknown> }): void {
    const existing = this.ongoingSubCalls.get(call.id);
    this.ongoingSubCalls.set(call.id, {
      name: call.name,
      args: call.args,
      ...(existing?.streamingArguments !== undefined
        ? { streamingArguments: existing.streamingArguments }
        : {}),
    });
    this.upsertSubToolActivity(call.id, call.name, call.args, 'ongoing');
    this.advanceToRunning();
    this.notify();
  }

  appendSubToolCallDelta(delta: {
    id: string;
    name?: string | undefined;
    argumentsPart: string | null;
  }): void {
    const existing = this.ongoingSubCalls.get(delta.id);
    const nextArgsText = appendStreamingArgsPreview(
      existing?.streamingArguments,
      delta.argumentsPart,
    );
    const parsed = parseArgsPreview(nextArgsText);
    const fallbackName = t('tui.messages.toolCall.toolDefault');
    this.ongoingSubCalls.set(delta.id, {
      name: delta.name ?? existing?.name ?? fallbackName,
      args: parsed,
      streamingArguments: nextArgsText,
    });
    this.upsertSubToolActivity(delta.id, delta.name ?? existing?.name ?? fallbackName, parsed, 'ongoing');
    this.advanceToRunning();
    this.notify();
  }

  appendSubToolLiveOutput(id: string, text: string): void {
    if (text.length === 0) return;
    const activity = this.subToolActivities.get(id);
    const ongoing = this.ongoingSubCalls.get(id);
    if (activity === undefined && ongoing === undefined) return;
    const fallbackName = t('tui.messages.toolCall.toolDefault');
    const name = activity?.name ?? ongoing?.name ?? fallbackName;
    const args = activity?.args ?? ongoing?.args ?? {};
    const existingOutput = activity?.output ?? '';
    let output = existingOutput + text;
    if (output.length > MAX_LIVE_OUTPUT_CHARS) {
      output = `${t('tui.messages.toolCall.truncatedMarker')}\n${output.slice(output.length - MAX_LIVE_OUTPUT_CHARS)}`;
    }
    this.upsertSubToolActivity(id, name, args, activity?.phase ?? 'ongoing', output);
    this.notify();
  }

  finishSubToolCall(result: {
    tool_call_id: string;
    output: string;
    is_error?: boolean | undefined;
  }): void {
    const ongoing = this.ongoingSubCalls.get(result.tool_call_id);
    if (ongoing === undefined) return;
    this.ongoingSubCalls.delete(result.tool_call_id);
    this.finishedSubCalls.push({
      name: ongoing.name,
      args: ongoing.args,
      output: result.output,
      isError: result.is_error ?? false,
    });
    this.upsertSubToolActivity(
      result.tool_call_id,
      ongoing.name,
      ongoing.args,
      result.is_error === true ? 'failed' : 'done',
      result.output,
    );
    while (this.finishedSubCalls.length > MAX_SUB_TOOL_CALLS_SHOWN) {
      this.finishedSubCalls.shift();
      this.hiddenSubCallCount += 1;
    }
    this.notify();
  }

  // ── Snapshot queries ──

  getSnapshot(): ToolCallSubagentSnapshot {
    const finished = this.finishedSubCalls.length + this.hiddenSubCallCount;
    const contextTokens = this.contextTokens;
    const tokens =
      contextTokens && contextTokens > 0
        ? contextTokens
        : (this.usage === undefined ? 0 : usageTotal(this.usage));
    const latestActivity = computeLatestActivity(
      this.ongoingSubCalls,
      this.finishedSubCalls,
      this.getCombinedText(),
      this.workspaceDir,
    );
    const derivedPhase = this.getDerivedPhase();
    const errorText =
      this.error ?? (derivedPhase === 'failed' ? this.result?.output : undefined);
    return {
      toolCallId: this.toolCall.id,
      toolName: this.toolCall.name,
      toolCallDescription: str(this.toolCall.args['description']) || str(this.toolCall.description),
      agentName: this.agentName,
      phase: derivedPhase,
      toolCount: finished,
      elapsedSeconds: this.getElapsedSeconds(),
      tokens,
      isError: derivedPhase === 'failed',
      errorText,
      latestActivity,
    };
  }

  getReadSnapshot(): ToolCallReadSnapshot {
    const args = this.toolCall.args;
    const filePathRaw = args['file_path'] ?? args['path'];
    const filePath =
      typeof filePathRaw === 'string'
        ? makeWorkspaceRelativePath(filePathRaw, this.workspaceDir)
        : undefined;
    if (this.result === undefined) {
      return { toolCallId: this.toolCall.id, filePath, phase: 'pending', lines: 0 };
    }
    if (this.result.is_error === true) {
      return { toolCallId: this.toolCall.id, filePath, phase: 'failed', lines: 0 };
    }
    return {
      toolCallId: this.toolCall.id,
      filePath,
      phase: 'done',
      lines: countNonEmptyLines(this.result.output),
    };
  }

  getAgentId(): string | undefined {
    if (this.agentId !== undefined) return this.agentId;
    if (this.toolCall.name !== 'Agent' || this.result === undefined) return undefined;
    const match = this.result.output.match(/^agent_id:\s*(agent-[A-Za-z0-9_-]+)/m);
    return match?.[1];
  }

  getAgentToolDescription(): string | undefined {
    if (this.toolCall.name !== 'Agent') return undefined;
    const desc = this.toolCall.args['description'];
    return typeof desc === 'string' ? desc : undefined;
  }

  // ── Timer management ──

  syncElapsedTimer(
    isSingleSubagentView: boolean,
    onTick: () => void,
  ): void {
    const phase = this.getDerivedPhase();
    const shouldTick =
      isSingleSubagentView &&
      this.startedAtMs !== undefined &&
      (phase === 'queued' || phase === 'spawning' || phase === 'running');
    if (!shouldTick) {
      this.stopElapsedTimer();
      return;
    }
    if (this.elapsedTimer !== undefined) return;
    this.elapsedTimer = setInterval(() => {
      const latestPhase = this.getDerivedPhase();
      if (latestPhase !== 'queued' && latestPhase !== 'spawning' && latestPhase !== 'running') {
        this.stopElapsedTimer();
        return;
      }
      this.spinnerFrame = (this.spinnerFrame + 1) % BRAILLE_SPINNER_FRAMES.length;
      onTick();
    }, BRAILLE_SPINNER_INTERVAL_MS);
  }

  stopElapsedTimer(): void {
    if (this.elapsedTimer === undefined) return;
    clearInterval(this.elapsedTimer);
    this.elapsedTimer = undefined;
  }

  dispose(): void {
    this.stopElapsedTimer();
  }

  // ── State getters for rendering ──

  get agentIdValue(): string | undefined { return this.agentId; }
  get agentNameValue(): string | undefined { return this.agentName; }
  get phaseValue(): SubagentPhase | undefined { return this.phase; }
  get textValue(): string { return this.text; }
  get thinkingTextValue(): string { return this.thinkingText; }
  get lastStreamKindValue(): 'thinking' | 'text' { return this.lastStreamKind; }
  get resultSummaryValue(): string | undefined { return this.resultSummary; }
  get errorValue(): string | undefined { return this.error; }
  get contextTokensValue(): number | undefined { return this.contextTokens; }
  get usageValue(): TokenUsage | undefined { return this.usage; }
  get spinnerFrameValue(): number { return this.spinnerFrame; }
  get ongoingSubCallsMap(): ReadonlyMap<string, OngoingSubCall> { return this.ongoingSubCalls; }
  get finishedSubCallsList(): readonly FinishedSubCall[] { return this.finishedSubCalls; }
  get subToolActivitiesMap(): ReadonlyMap<string, SubToolActivity> { return this.subToolActivities; }
  get hiddenSubCallCountValue(): number { return this.hiddenSubCallCount; }
  get maxSubagentDescriptionLength(): number { return MAX_SUBAGENT_DESCRIPTION_LENGTH; }

  hasState(): boolean {
    return (
      this.agentId !== undefined ||
      this.ongoingSubCalls.size > 0 ||
      this.finishedSubCalls.length > 0 ||
      this.subToolActivities.size > 0 ||
      this.text.length > 0 ||
      this.thinkingText.length > 0 ||
      this.phase !== undefined ||
      this.backgroundTerminalPhase !== undefined
    );
  }

  getCombinedText(): string {
    return [this.thinkingText, this.text].filter((s) => s.length > 0).join('\n');
  }

  getDerivedPhase(): SubagentPhase | undefined {
    if (this.backgroundTerminalPhase !== undefined) {
      return this.backgroundTerminalPhase;
    }
    if (this.detachedFromForeground && this.phase === 'backgrounded') {
      return 'backgrounded';
    }
    if (this.result !== undefined) return this.result.is_error ? 'failed' : 'done';
    return this.phase;
  }

  getElapsedSeconds(): number | undefined {
    if (this.startedAtMs === undefined) return undefined;
    const end = this.endedAtMs ?? Date.now();
    return Math.max(0, Math.floor((end - this.startedAtMs) / 1000));
  }

  formatContextTokens(): string | undefined {
    return formatSubagentContextTokens(this.contextTokens);
  }

  formatTokensDisplay(): string | undefined {
    return formatSubagentTokens(this.usage);
  }

  // ── Private helpers ──

  private advanceToRunning(): void {
    if (
      this.phase === undefined ||
      this.phase === 'queued' ||
      this.phase === 'spawning'
    ) {
      this.phase = 'running';
    }
  }

  private upsertSubToolActivity(
    id: string,
    name: string,
    args: Record<string, unknown>,
    phase: SubToolActivity['phase'],
    output?: string,
  ): void {
    const existing = this.subToolActivities.get(id);
    if (existing !== undefined) {
      existing.name = name;
      existing.args = args;
      existing.phase = phase;
      if (output !== undefined) existing.output = output;
      return;
    }
    this.subToolActivities.set(id, {
      id,
      name,
      args,
      phase,
      ...(output !== undefined ? { output } : {}),
      orderSeq: ++this.subToolOrderSeq,
    });
  }

  private finalizeElapsedIfNeeded(): void {
    if (
      this.toolCall.name === 'Agent' &&
      this.startedAtMs !== undefined &&
      this.endedAtMs === undefined
    ) {
      this.endedAtMs = Date.now();
    }
  }

  private notify(): void {
    this.onStateChange?.();
  }
}


