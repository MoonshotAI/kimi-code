// apps/vis/web/src/lib/analysis.ts
//
// Fold a flat wire timeline into the agent's natural execution structure —
// turns → steps → tool calls — and derive the metrics a data-analysis view
// needs but the raw record list does not surface:
//   - per-turn / per-step / per-tool wall-clock duration (from record `time`)
//   - per-turn token cost (sum of step usages) and cache-hit rate
//   - context-window fill over time (mirrors agent-core's snapshot formula)
//   - tool-result truncation / size / error flags
//   - tool usage stats (count, error rate, latency)
//   - idle gaps (large wall-clock gaps between records → waiting)
//
// Pure: consumes the same `WireEntry[]` the Wire tab already fetches, so the
// Timeline view needs no extra server round-trip.

import type { TokenUsage, WireEntry } from '../types';

export interface ContentSummary {
  textChars: number;
  thinkChars: number;
}

export interface ToolCallNode {
  callLineNo: number;
  toolCallId: string;
  name: string;
  description?: string;
  callTime?: number;
  resultLineNo?: number;
  resultTime?: number;
  /** resultTime − callTime, when both are known. */
  durationMs?: number;
  isError?: boolean;
  truncated?: boolean;
  /** Approximate byte size of the tool result output. */
  outputBytes?: number;
  /** Optional human-readable side-channel message on the result. */
  resultMessage?: string;
}

export interface StepNode {
  uuid: string;
  step: number;
  turnId: string;
  beginLineNo: number;
  beginTime?: number;
  endLineNo?: number;
  endTime?: number;
  durationMs?: number;
  finishReason?: string;
  isError?: boolean;
  usage?: TokenUsage;
  /** Context-window fill after this step (the agent-core snapshot formula). */
  contextTokens?: number;
  llmFirstTokenLatencyMs?: number;
  llmStreamDurationMs?: number;
  /** TTFT split: client-side request-build vs. network + API-server time. */
  llmRequestBuildMs?: number;
  llmServerFirstTokenMs?: number;
  /** Decode split: server time awaiting parts vs. client time processing them. */
  llmServerDecodeMs?: number;
  llmClientConsumeMs?: number;
  content: ContentSummary;
  toolCalls: ToolCallNode[];
}

export interface TurnNode {
  index: number;
  /** 'prompt' | 'steer' — how the turn was kicked off. */
  trigger: 'prompt' | 'steer';
  promptLineNo: number;
  promptTime?: number;
  promptText: string;
  originKind?: string;
  steps: StepNode[];
  startTime?: number;
  endTime?: number;
  /** endTime − startTime over the turn's steps (active execution time). */
  durationMs?: number;
  /** promptTime − previous turn's endTime (time the agent sat idle/waiting). */
  waitBeforeMs?: number;
  /** Sum of this turn's step usages — total tokens processed (billing cost). */
  tokens: TokenUsage;
  toolCallCount: number;
  toolErrorCount: number;
  cancelled: boolean;
}

export interface ContextPoint {
  lineNo: number;
  time?: number;
  turnIndex: number;
  step: number;
  contextTokens: number;
}

export interface ToolStat {
  name: string;
  count: number;
  errorCount: number;
  truncatedCount: number;
  /** Number of calls that had both call and result times (so durationMs). */
  timedCount: number;
  totalMs: number;
  avgMs: number | null;
  maxMs: number | null;
  totalOutputBytes: number;
}

export interface IdleGap {
  afterLineNo: number;
  beforeLineNo: number;
  gapMs: number;
  /** Heuristic label for what the gap represents. */
  kind: 'between_turns' | 'in_turn';
}

export interface ConfigChange {
  lineNo: number;
  time?: number;
  /** Human-readable field=value pairs that this config.update changed. */
  changed: { field: string; value: string }[];
}

export interface CacheStats {
  inputOther: number;
  inputCacheRead: number;
  inputCacheCreation: number;
  output: number;
  /** cacheRead / (cacheRead + cacheCreation + inputOther). null when no input. */
  hitRate: number | null;
}

export interface AnalysisSummary {
  turnCount: number;
  stepCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  truncatedToolCount: number;
  /** Sum of all step usages — total tokens processed across the session. */
  totalTokens: number;
  /** Latest context-window fill (last step.end snapshot). */
  contextTokens: number;
  /** Peak context-window fill seen across the session. */
  peakContextTokens: number;
  /** lastRecordTime − firstRecordTime. */
  wallClockMs: number | null;
  /** Sum of turn active durations (excludes idle/waiting). */
  activeMs: number;
}

export interface Analysis {
  turns: TurnNode[];
  summary: AnalysisSummary;
  contextSeries: ContextPoint[];
  cache: CacheStats;
  toolStats: ToolStat[];
  idleGaps: IdleGap[];
  configChanges: ConfigChange[];
}

const ZERO_USAGE: TokenUsage = {
  inputOther: 0,
  output: 0,
  inputCacheRead: 0,
  inputCacheCreation: 0,
};

/** Idle gaps shorter than this are noise; only larger ones get surfaced. */
const IDLE_GAP_MS = 3000;

function addUsage(into: TokenUsage, u: TokenUsage): void {
  into.inputOther += u.inputOther;
  into.output += u.output;
  into.inputCacheRead += u.inputCacheRead;
  into.inputCacheCreation += u.inputCacheCreation;
}

function usageTotal(u: TokenUsage): number {
  return u.inputOther + u.output + u.inputCacheRead + u.inputCacheCreation;
}

/** Context-window fill after a step, mirroring agent-core ContextMemory. */
function contextFill(u: TokenUsage): number {
  return u.inputCacheRead + u.inputCacheCreation + u.inputOther + u.output;
}

function firstText(input: readonly unknown[] | undefined): string {
  if (!input) return '';
  for (const part of input) {
    if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
      return (part as { text?: string }).text ?? '';
    }
  }
  return '';
}

function outputSize(output: unknown): number {
  if (typeof output === 'string') return output.length;
  if (Array.isArray(output)) {
    let n = 0;
    for (const part of output) {
      const text = (part as { text?: string })?.text;
      n += typeof text === 'string' ? text.length : JSON.stringify(part ?? null).length;
    }
    return n;
  }
  return 0;
}

export function analyzeWire(entries: readonly WireEntry[]): Analysis {
  const turns: TurnNode[] = [];
  const contextSeries: ContextPoint[] = [];
  const toolStatMap = new Map<string, ToolStat>();
  const idleGaps: IdleGap[] = [];

  const stepByUuid = new Map<string, StepNode>();
  const toolByCallId = new Map<string, ToolCallNode>();
  const cache: TokenUsage = { ...ZERO_USAGE };
  const configChanges: ConfigChange[] = [];

  let current: TurnNode | null = null;
  let contextTokens = 0;
  let peakContext = 0;
  let firstTime: number | undefined;
  let lastTime: number | undefined;
  let prevTime: number | undefined;
  let prevLineNo = 0;

  const startTurn = (trigger: 'prompt' | 'steer', lineNo: number, time: number | undefined, text: string, originKind: string | undefined): TurnNode => {
    const node: TurnNode = {
      index: turns.length,
      trigger,
      promptLineNo: lineNo,
      promptTime: time,
      promptText: text,
      originKind,
      steps: [],
      tokens: { ...ZERO_USAGE },
      toolCallCount: 0,
      toolErrorCount: 0,
      cancelled: false,
    };
    if (time !== undefined && current?.endTime !== undefined) {
      node.waitBeforeMs = Math.max(0, time - current.endTime);
    }
    turns.push(node);
    return node;
  };

  for (const entry of entries) {
    const rec = entry.data;
    const t = rec.time;
    if (t !== undefined) {
      firstTime ??= t;
      lastTime = t;
      if (prevTime !== undefined && t - prevTime >= IDLE_GAP_MS) {
        idleGaps.push({
          afterLineNo: prevLineNo,
          beforeLineNo: entry.lineNo,
          gapMs: t - prevTime,
          // A gap straddling a turn boundary is "waiting for the user"; a gap
          // inside a turn is the agent/tool being slow.
          kind: rec.type === 'turn.prompt' || rec.type === 'turn.steer' ? 'between_turns' : 'in_turn',
        });
      }
      prevTime = t;
      prevLineNo = entry.lineNo;
    }

    switch (rec.type) {
      case 'turn.prompt':
        current = startTurn('prompt', entry.lineNo, t, firstText(rec.input), rec.origin?.kind);
        break;
      case 'turn.steer':
        current = startTurn('steer', entry.lineNo, t, firstText(rec.input), rec.origin?.kind);
        break;
      case 'turn.cancel':
        if (current) current.cancelled = true;
        break;

      case 'context.clear':
        contextTokens = 0;
        break;
      case 'context.apply_compaction':
        contextTokens = rec.tokensAfter;
        contextSeries.push({ lineNo: entry.lineNo, time: t, turnIndex: current?.index ?? -1, step: -1, contextTokens });
        if (contextTokens > peakContext) peakContext = contextTokens;
        break;

      case 'config.update': {
        const changed: { field: string; value: string }[] = [];
        if (rec.profileName !== undefined) changed.push({ field: 'profile', value: rec.profileName });
        if (rec.modelAlias !== undefined) changed.push({ field: 'model', value: rec.modelAlias });
        if (rec.thinkingEffort !== undefined) changed.push({ field: 'thinking', value: rec.thinkingEffort });
        if (rec.cwd !== undefined) changed.push({ field: 'cwd', value: rec.cwd });
        if (rec.systemPrompt !== undefined) changed.push({ field: 'systemPrompt', value: `${rec.systemPrompt.length} chars` });
        if (changed.length > 0) configChanges.push({ lineNo: entry.lineNo, time: t, changed });
        break;
      }

      case 'context.append_loop_event': {
        const ev = rec.event;
        if (ev.type === 'step.begin') {
          current ??= startTurn('prompt', entry.lineNo, t, '(no prompt record)', undefined);
          const step: StepNode = {
            uuid: ev.uuid,
            step: ev.step,
            turnId: ev.turnId,
            beginLineNo: entry.lineNo,
            beginTime: t,
            content: { textChars: 0, thinkChars: 0 },
            toolCalls: [],
          };
          stepByUuid.set(ev.uuid, step);
          current.steps.push(step);
          current.startTime ??= t;
        } else if (ev.type === 'step.end') {
          const step = stepByUuid.get(ev.uuid);
          if (step) {
            step.endLineNo = entry.lineNo;
            step.endTime = t;
            step.finishReason = ev.finishReason;
            step.llmFirstTokenLatencyMs = ev.llmFirstTokenLatencyMs;
            step.llmStreamDurationMs = ev.llmStreamDurationMs;
            step.llmRequestBuildMs = ev.llmRequestBuildMs;
            step.llmServerFirstTokenMs = ev.llmServerFirstTokenMs;
            step.llmServerDecodeMs = ev.llmServerDecodeMs;
            step.llmClientConsumeMs = ev.llmClientConsumeMs;
            if (step.beginTime !== undefined && t !== undefined) step.durationMs = t - step.beginTime;
            // Steps don't carry a generic 'error' finish reason (errors are
            // thrown, not recorded). 'filtered' means the provider blocked the
            // response — the closest persisted step-level failure signal.
            step.isError = ev.finishReason === 'filtered';
            if ('usage' in ev && ev.usage !== undefined) {
              step.usage = ev.usage;
              if (current) addUsage(current.tokens, ev.usage);
              addUsage(cache, ev.usage);
              // A zero-usage step.end (e.g. a content-filtered response) must
              // not reset the context-window fill to 0 — agent-core's
              // ContextMemory keeps the prior snapshot in that case. Carry the
              // running value so the chart shows no false drop.
              const fill = contextFill(ev.usage);
              if (fill > 0) {
                contextTokens = fill;
                if (contextTokens > peakContext) peakContext = contextTokens;
              }
              step.contextTokens = contextTokens;
              contextSeries.push({
                lineNo: entry.lineNo,
                time: t,
                turnIndex: current?.index ?? -1,
                step: ev.step,
                contextTokens,
              });
            }
            if (current && t !== undefined) current.endTime = t;
          }
        } else if (ev.type === 'tool.call') {
          const node: ToolCallNode = {
            callLineNo: entry.lineNo,
            toolCallId: ev.toolCallId,
            name: ev.name,
            description: ev.description,
            callTime: t,
          };
          toolByCallId.set(ev.toolCallId, node);
          const step = stepByUuid.get(ev.stepUuid);
          (step ? step.toolCalls : current?.steps.at(-1)?.toolCalls)?.push(node);
          if (current) current.toolCallCount += 1;
        } else if (ev.type === 'content.part') {
          const step = stepByUuid.get(ev.stepUuid);
          const part = ev.part as { type?: string; text?: string } | undefined;
          if (step && part) {
            const chars = typeof part.text === 'string' ? part.text.length : 0;
            if (part.type === 'think') step.content.thinkChars += chars;
            else step.content.textChars += chars;
          }
        } else if (ev.type === 'tool.result') {
          const node = toolByCallId.get(ev.toolCallId);
          const isError = ev.result.isError === true;
          const truncated = ev.result.truncated === true;
          const bytes = outputSize(ev.result.output);
          if (node) {
            node.resultLineNo = entry.lineNo;
            node.resultTime = t;
            node.isError = isError;
            node.truncated = truncated;
            node.outputBytes = bytes;
            node.resultMessage = ev.result.message;
            if (node.callTime !== undefined && t !== undefined) node.durationMs = t - node.callTime;
            if (isError && current) current.toolErrorCount += 1;
            recordToolStat(toolStatMap, node);
          }
        }
        break;
      }

      default:
        break;
    }
  }

  // Tool calls that never resolved still count toward stats (no duration).
  for (const node of toolByCallId.values()) {
    if (node.resultLineNo === undefined) recordToolStat(toolStatMap, node);
  }

  const summary = summarize(turns, contextTokens, peakContext, firstTime, lastTime);
  for (const s of toolStatMap.values()) {
    s.avgMs = s.timedCount > 0 ? s.totalMs / s.timedCount : null;
  }
  const toolStats = [...toolStatMap.values()].toSorted((a, b) => b.count - a.count);
  const sortedGaps = idleGaps.toSorted((a, b) => b.gapMs - a.gapMs);

  return {
    turns,
    summary,
    contextSeries,
    cache: cacheStats(cache),
    toolStats,
    idleGaps: sortedGaps,
    configChanges,
  };
}

function recordToolStat(map: Map<string, ToolStat>, node: ToolCallNode): void {
  let s = map.get(node.name);
  if (!s) {
    s = { name: node.name, count: 0, errorCount: 0, truncatedCount: 0, timedCount: 0, totalMs: 0, avgMs: null, maxMs: null, totalOutputBytes: 0 };
    map.set(node.name, s);
  }
  s.count += 1;
  if (node.isError) s.errorCount += 1;
  if (node.truncated) s.truncatedCount += 1;
  if (node.outputBytes !== undefined) s.totalOutputBytes += node.outputBytes;
  if (node.durationMs !== undefined) {
    s.timedCount += 1;
    s.totalMs += node.durationMs;
    s.maxMs = s.maxMs === null ? node.durationMs : Math.max(s.maxMs, node.durationMs);
  }
}

function summarize(
  turns: readonly TurnNode[],
  contextTokens: number,
  peakContext: number,
  firstTime: number | undefined,
  lastTime: number | undefined,
): AnalysisSummary {
  let stepCount = 0;
  let toolCallCount = 0;
  let toolErrorCount = 0;
  let truncatedToolCount = 0;
  let totalTokens = 0;
  let activeMs = 0;
  for (const turn of turns) {
    if (turn.startTime !== undefined && turn.endTime !== undefined) {
      turn.durationMs = turn.endTime - turn.startTime;
    }
    stepCount += turn.steps.length;
    toolCallCount += turn.toolCallCount;
    toolErrorCount += turn.toolErrorCount;
    totalTokens += usageTotal(turn.tokens);
    activeMs += turn.durationMs ?? 0;
    for (const step of turn.steps) {
      for (const tc of step.toolCalls) if (tc.truncated) truncatedToolCount += 1;
    }
  }
  return {
    turnCount: turns.length,
    stepCount,
    toolCallCount,
    toolErrorCount,
    truncatedToolCount,
    totalTokens,
    contextTokens,
    peakContextTokens: peakContext,
    wallClockMs: firstTime !== undefined && lastTime !== undefined ? lastTime - firstTime : null,
    activeMs,
  };
}

function cacheStats(c: TokenUsage): CacheStats {
  const inputTotal = c.inputOther + c.inputCacheRead + c.inputCacheCreation;
  return {
    inputOther: c.inputOther,
    inputCacheRead: c.inputCacheRead,
    inputCacheCreation: c.inputCacheCreation,
    output: c.output,
    hitRate: inputTotal > 0 ? c.inputCacheRead / inputTotal : null,
  };
}
