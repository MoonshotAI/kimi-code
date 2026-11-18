import type { Event } from '@moonshot-ai/kimi-code-sdk';

import {
  MAX_SUBAGENT_ACTIVITY_STEPS,
  SUBAGENT_ARG_STRING_MAX_CHARS,
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

export interface SubToolCallActivity {
  readonly id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'done' | 'error';
  readonly startedAt: number;
  durationMs?: number;
  result?: ToolResultBlockData;
  liveOutputTail?: string;
}

export interface SubagentStepActivity {
  readonly step: number;
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
  totalSteps: number;
  status: 'running' | 'completed' | 'failed';
  resultSummary?: string;
  error?: string;
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

function capArgStrings(args: Record<string, unknown>): Record<string, unknown> {
  let capped: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string' || value.length <= SUBAGENT_ARG_STRING_MAX_CHARS) continue;
    capped ??= { ...args };
    capped[key] = `${value.slice(0, SUBAGENT_ARG_STRING_MAX_CHARS)}…`;
  }
  return capped ?? args;
}

export class SubagentActivityStore {
  private readonly records = new Map<string, SubagentActivityRecord>();
  private readonly startedSteps = new Set<string>();
  private readonly streamingArgs = new Map<string, string>();

  ensureRecord(spawn: SubagentActivitySpawn): SubagentActivityRecord {
    const existing = this.records.get(spawn.agentId);
    if (existing !== undefined) {
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

  agentIds(): readonly string[] {
    return [...this.records.keys()];
  }

  applyEvent(event: Event): void {
    switch (event.type) {
      case 'turn.step.started': {
        const key = `${event.agentId}:${event.turnId}:${event.stepId ?? event.step}`;
        const record = this.recordFor(event.agentId);
        if (this.startedSteps.has(key)) {
          this.currentStep(record).retrying = undefined;
          this.bump(record);
          return;
        }
        this.startedSteps.add(key);
        record.steps.push({ step: event.step, textTail: '', toolCalls: [] });
        record.totalSteps += 1;
        while (record.steps.length > MAX_SUBAGENT_ACTIVITY_STEPS) {
          const evicted = record.steps.shift();
          if (evicted === undefined) break;
          for (const call of evicted.toolCalls) {
            this.streamingArgs.delete(this.streamKey(record.agentId, call.id));
          }
        }
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
        const args = capArgStrings(argsRecord(event.args));
        if (existing === undefined) {
          this.currentStep(record).toolCalls.push({
            id: event.toolCallId,
            name: event.name,
            args,
            status: 'running',
            startedAt: Date.now(),
          });
        } else {
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
        call.args = capArgStrings(parseStreamingArgs(buffered));
        this.bump(record);
        return;
      }
      case 'tool.updated': {
        const status = event.fields['status'];
        const text = event.output?.text ?? (event.output === undefined && typeof status === 'string' ? status : undefined);
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
    this.dropStreamingBuffers(agentId);
    this.bump(record);
  }

  markFailed(agentId: string, error?: string): void {
    const record = this.records.get(agentId);
    if (record === undefined) return;
    record.status = 'failed';
    record.error = error;
    this.dropStreamingBuffers(agentId);
    this.bump(record);
  }

  clear(): void {
    this.records.clear();
    this.startedSteps.clear();
    this.streamingArgs.clear();
  }

  drop(agentId: string): void {
    this.records.delete(agentId);
    this.dropStreamingBuffers(agentId);
  }

  private dropStreamingBuffers(agentId: string): void {
    const prefix = `${agentId}:`;
    for (const key of this.streamingArgs.keys()) {
      if (key.startsWith(prefix)) this.streamingArgs.delete(key);
    }
  }

  private recordFor(agentId: string): SubagentActivityRecord {
    return (
      this.records.get(agentId) ??
      this.ensureRecord({ agentId, agentName: agentId, parentToolCallId: '' })
    );
  }

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
