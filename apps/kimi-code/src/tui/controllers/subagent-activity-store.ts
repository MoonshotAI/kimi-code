/**
 * SubagentActivityStore — per-agent activity records feeding the background
 * agent detail view (AgentActivityViewer).
 *
 * Child-agent events arrive at `SubAgentEventHandler.routeChildAgentEvent`
 * regardless of foreground/background state, but are dropped there when the
 * parent tool card is gone (Ctrl+B) or never existed (run_in_background).
 * This store tees those events into a bounded per-agent fold so the tasks
 * browser can show what a background agent is actually doing.
 *
 * Retention: only the most recent `MAX_SUBAGENT_ACTIVITY_STEPS` steps are
 * kept (older steps are discarded whole — a step is the core loop's natural
 * "one model response + tool execution" unit, bounded by the core's own
 * `turn.step.started` events). Per-step assistant text keeps a trailing
 * window; per-call result output is capped. Everything lives in memory and
 * is released on session switch (`clear`).
 *
 * Pure logic — no TUI state, no components — so it is unit-testable.
 */

import type { Event } from '@moonshot-ai/kimi-code-sdk';

import {
  MAX_SUBAGENT_ACTIVITY_STEPS,
  SUBAGENT_STEP_TEXT_TAIL_CHARS,
  SUBAGENT_TOOL_OUTPUT_MAX_CHARS,
} from '#/tui/constant/rendering';
import type { ToolResultBlockData } from '../types';
import {
  argsRecord,
  appendStreamingArgsPreview,
  parseStreamingArgs,
  serializeToolResultOutput,
} from '../utils/event-payload';

/** A single tool call inside a step, shaped so the viewer can feed the
 *  main-flow renderers (`ToolCallBlockData` / `ToolResultBlockData`). */
export interface SubToolCallActivity {
  readonly id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'done' | 'error';
  readonly startedAt: number;
  durationMs?: number;
  result?: ToolResultBlockData;
  /** Last line of stdout/stderr live progress, while the call is running. */
  liveOutputTail?: string;
}

/** One step = one core loop iteration (`turn.step.started` … next start). */
export interface SubagentStepActivity {
  readonly step: number;
  /** Assistant text of this step, trailing window only. */
  textTail: string;
  readonly toolCalls: SubToolCallActivity[];
  retrying?: string;
}

export interface SubagentActivityRecord {
  readonly agentId: string;
  readonly agentName: string;
  readonly description?: string;
  readonly parentToolCallId: string;
  model?: string;
  effort?: string;
  readonly steps: SubagentStepActivity[];
  /** Count of real `turn.step.started` events seen (monotonic). */
  totalSteps: number;
  status: 'running' | 'completed' | 'failed';
  resultSummary?: string;
  error?: string;
  /** Bumped on every mutation; the viewer caches its render against this. */
  version: number;
}

export interface SubagentActivitySpawn {
  readonly agentId: string;
  readonly agentName: string;
  readonly description?: string;
  readonly parentToolCallId: string;
  readonly model?: string;
  readonly effort?: string;
}

const LIVE_OUTPUT_TAIL_CHARS = 200;

function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

export class SubagentActivityStore {
  private readonly records = new Map<string, SubagentActivityRecord>();
  /** Raw streaming-arguments buffer per in-flight tool call (from deltas). */
  private readonly streamingArgs = new Map<string, string>();

  ensureRecord(spawn: SubagentActivitySpawn): SubagentActivityRecord {
    const existing = this.records.get(spawn.agentId);
    if (existing !== undefined) {
      // A resumed subagent re-spawns under the same id: keep the accumulated
      // steps and flip the record back to running.
      existing.status = 'running';
      existing.resultSummary = undefined;
      existing.error = undefined;
      return existing;
    }
    const record: SubagentActivityRecord = {
      agentId: spawn.agentId,
      agentName: spawn.agentName,
      description: spawn.description,
      parentToolCallId: spawn.parentToolCallId,
      model: spawn.model,
      effort: spawn.effort,
      steps: [],
      totalSteps: 0,
      status: 'running',
      version: 0,
    };
    this.records.set(spawn.agentId, record);
    return record;
  }

  get(agentId: string): SubagentActivityRecord | undefined {
    return this.records.get(agentId);
  }

  applyEvent(event: Event): void {
    switch (event.type) {
      case 'turn.step.started': {
        const record = this.recordFor(event.agentId);
        record.steps.push({ step: event.step, textTail: '', toolCalls: [] });
        record.totalSteps += 1;
        while (record.steps.length > MAX_SUBAGENT_ACTIVITY_STEPS) record.steps.shift();
        this.bump(record);
        return;
      }
      case 'assistant.delta': {
        const record = this.recordFor(event.agentId);
        const step = this.currentStep(record);
        step.textTail = tail(step.textTail + event.delta, SUBAGENT_STEP_TEXT_TAIL_CHARS);
        this.bump(record);
        return;
      }
      case 'tool.call.started': {
        const record = this.recordFor(event.agentId);
        const existing = this.findToolCall(record, event.toolCallId);
        const args = argsRecord(event.args);
        if (existing === undefined) {
          this.currentStep(record).toolCalls.push({
            id: event.toolCallId,
            name: event.name,
            args,
            status: 'running',
            startedAt: Date.now(),
          });
        } else {
          // Authoritative full args arrive with the start; replace the
          // best-effort record assembled from streaming deltas.
          existing.name = event.name;
          existing.args = args;
        }
        this.streamingArgs.delete(this.streamKey(event.agentId, event.toolCallId));
        this.bump(record);
        return;
      }
      case 'tool.call.delta': {
        const record = this.recordFor(event.agentId);
        const key = this.streamKey(event.agentId, event.toolCallId);
        // parseStreamingArgs only reads the preview window, so keep the raw
        // buffer capped at the same size — an uncapped buffer would outgrow
        // the store's retention caps on large Write/Edit argument streams.
        const buffered = appendStreamingArgsPreview(
          this.streamingArgs.get(key),
          event.argumentsPart,
        );
        this.streamingArgs.set(key, buffered);
        let call = this.findToolCall(record, event.toolCallId);
        if (call === undefined) {
          call = {
            id: event.toolCallId,
            name: event.name ?? '',
            args: {},
            status: 'running',
            startedAt: Date.now(),
          };
          this.currentStep(record).toolCalls.push(call);
        }
        if (call.name.length === 0 && event.name !== undefined) call.name = event.name;
        call.args = parseStreamingArgs(buffered);
        this.bump(record);
        return;
      }
      case 'tool.progress': {
        if (event.update.kind !== 'stdout' && event.update.kind !== 'stderr') return;
        const text = event.update.text;
        if (text === undefined || text.trim().length === 0) return;
        const record = this.records.get(event.agentId);
        const call = record === undefined ? undefined : this.findToolCall(record, event.toolCallId);
        if (record === undefined || call === undefined) return;
        const lines = text.trimEnd().split('\n');
        call.liveOutputTail = tail(lines.at(-1) ?? '', LIVE_OUTPUT_TAIL_CHARS);
        this.bump(record);
        return;
      }
      case 'tool.result': {
        const record = this.records.get(event.agentId);
        const call = record === undefined ? undefined : this.findToolCall(record, event.toolCallId);
        if (record === undefined || call === undefined) return;
        let output = serializeToolResultOutput(event.output);
        if (output.length > SUBAGENT_TOOL_OUTPUT_MAX_CHARS) {
          output = `${output.slice(0, SUBAGENT_TOOL_OUTPUT_MAX_CHARS)}\n… [output truncated to ${String(SUBAGENT_TOOL_OUTPUT_MAX_CHARS)} chars]`;
        }
        call.result = {
          tool_call_id: call.id,
          output,
          is_error: event.isError,
          synthetic: event.synthetic,
        };
        call.status = event.isError === true ? 'error' : 'done';
        call.durationMs = Date.now() - call.startedAt;
        call.liveOutputTail = undefined;
        this.streamingArgs.delete(this.streamKey(event.agentId, event.toolCallId));
        this.bump(record);
        return;
      }
      case 'turn.step.retrying': {
        const record = this.recordFor(event.agentId);
        const step = this.currentStep(record);
        step.retrying = `retrying · attempt ${String(event.nextAttempt)}/${String(event.maxAttempts)} (${event.errorName})`;
        this.bump(record);
        return;
      }
      default:
        return;
    }
  }

  markCompleted(agentId: string, resultSummary?: string): void {
    const record = this.records.get(agentId);
    if (record === undefined) return;
    record.status = 'completed';
    record.resultSummary = resultSummary;
    this.bump(record);
  }

  markFailed(agentId: string, error?: string): void {
    const record = this.records.get(agentId);
    if (record === undefined) return;
    record.status = 'failed';
    record.error = error;
    this.bump(record);
  }

  clear(): void {
    this.records.clear();
    this.streamingArgs.clear();
  }

  /** Get-or-create: events can arrive for agents this process never saw a
   *  spawn for (e.g. switching back to a session whose background agents are
   *  still running) — keep their activity rather than dropping it. */
  private recordFor(agentId: string): SubagentActivityRecord {
    return (
      this.records.get(agentId) ??
      this.ensureRecord({ agentId, agentName: agentId, parentToolCallId: '' })
    );
  }

  /** Latest step, creating a synthetic one when content arrives ahead of any
   *  `turn.step.started` (same mid-flight case as `recordFor`). */
  private currentStep(record: SubagentActivityRecord): SubagentStepActivity {
    let step = record.steps.at(-1);
    if (step === undefined) {
      step = { step: 0, textTail: '', toolCalls: [] };
      record.steps.push(step);
    }
    return step;
  }

  private findToolCall(
    record: SubagentActivityRecord,
    toolCallId: string,
  ): SubToolCallActivity | undefined {
    for (let i = record.steps.length - 1; i >= 0; i--) {
      const call = record.steps[i]!.toolCalls.find((c) => c.id === toolCallId);
      if (call !== undefined) return call;
    }
    return undefined;
  }

  private streamKey(agentId: string, toolCallId: string): string {
    return `${agentId}:${toolCallId}`;
  }

  private bump(record: SubagentActivityRecord): void {
    record.version += 1;
  }
}
