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
  durationMs?: number;
  isError?: boolean;
  truncated?: boolean;
  outputBytes?: number;
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
  contextTokens?: number;
  llmFirstTokenLatencyMs?: number;
  llmStreamDurationMs?: number;
  llmRequestBuildMs?: number;
  llmServerFirstTokenMs?: number;
  llmServerDecodeMs?: number;
  llmClientConsumeMs?: number;
  llmClientBlockedMs?: number;
  content: ContentSummary;
  toolCalls: ToolCallNode[];
}

export interface TurnNode {
  index: number;
  trigger: 'prompt' | 'steer';
  promptLineNo: number;
  promptTime?: number;
  promptText: string;
  originKind?: string;
  steps: StepNode[];
  startTime?: number;
  endTime?: number;
  durationMs?: number;
  waitBeforeMs?: number;
  turnId?: number;
  endLineNo?: number;
  outcome?: 'completed' | 'cancelled' | 'failed' | 'blocked';
  stopReason?: string;
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
  kind: 'between_turns' | 'in_turn';
}

export interface ConfigChange {
  lineNo: number;
  time?: number;
  changed: { field: string; value: string }[];
}

export interface CacheStats {
  inputOther: number;
  inputCacheRead?: number;
  inputCacheCreation: number;
  output: number;
  hitRate: number | null;
}

export interface AnalysisSummary {
  turnCount: number;
  stepCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  truncatedToolCount: number;
  totalTokens: number | undefined;
  contextTokens: number;
  peakContextTokens: number;
  wallClockMs: number | null;
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

const IDLE_GAP_MS = 3000;

function addUsage(into: TokenUsage, u: TokenUsage): void {
  into.inputOther += u.inputOther;
  into.output += u.output;
  into.inputCacheRead =
    into.inputCacheRead === undefined || u.inputCacheRead === undefined
      ? undefined
      : into.inputCacheRead + u.inputCacheRead;
  into.inputCacheCreation += u.inputCacheCreation;
}

function usageTotal(u: TokenUsage): number | undefined {
  if (u.inputCacheRead === undefined) return undefined;
  return u.inputOther + u.output + u.inputCacheRead + u.inputCacheCreation;
}

function contextFill(u: TokenUsage): number | undefined {
  return usageTotal(u);
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
      const candidate = part as { text?: string; think?: string } | undefined;
      const text = candidate?.text ?? candidate?.think;
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
  let pendingSteer: {
    lineNo: number;
    time: number | undefined;
    text: string;
    originKind: string | undefined;
  } | null = null;
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
          kind:
            rec.type === 'turn.prompt' ||
            (rec.type === 'turn.steer' &&
              (current === null || current.outcome !== undefined))
              ? 'between_turns'
              : 'in_turn',
        });
      }
      prevTime = t;
      prevLineNo = entry.lineNo;
    }

    switch (rec.type) {
      case 'turn.prompt':
        pendingSteer = null;
        current = startTurn('prompt', entry.lineNo, t, firstText(rec.input), rec.origin?.kind);
        break;
      case 'turn.steer':
        if (current === null || current.outcome !== undefined) {
          pendingSteer = null;
          current = startTurn('steer', entry.lineNo, t, firstText(rec.input), rec.origin?.kind);
        } else {
          pendingSteer = {
            lineNo: entry.lineNo,
            time: t,
            text: firstText(rec.input),
            originKind: rec.origin?.kind,
          };
        }
        break;
      case 'turn.cancel':
        if (
          current !== null &&
          rec.target !== 'queued' &&
          (rec.turnId === undefined || current.turnId === undefined || current.turnId === rec.turnId)
        ) {
          current.cancelled = true;
        }
        break;
      case 'turn.ended':
        if (current !== null) {
          current.turnId = rec.turnId;
          current.endLineNo = entry.lineNo;
          current.outcome = rec.reason;
          current.stopReason = rec.stopReason;
          current.cancelled ||= rec.reason === 'cancelled';
          if (t !== undefined) current.endTime = t;
          if (rec.durationMs !== undefined) current.durationMs = rec.durationMs;
        }
        break;

      case 'context.update_token_count':
        contextTokens = rec.tokenCount;
        contextSeries.push({
          lineNo: entry.lineNo,
          time: t,
          turnIndex: current?.index ?? -1,
          step: -1,
          contextTokens,
        });
        if (contextTokens > peakContext) peakContext = contextTokens;
        break;
      case 'token_counting.measured':
      case 'token_counting.truncated':
      case 'token_counting.rebased':
      case 'token_counting.turn_recorded':
        contextTokens = rec.tokens;
        contextSeries.push({
          lineNo: entry.lineNo,
          time: t,
          turnIndex: current?.index ?? -1,
          step: -1,
          contextTokens,
        });
        if (contextTokens > peakContext) peakContext = contextTokens;
        break;
      case 'context.clear':
        contextTokens = 0;
        break;
      case 'context.apply_compaction':
        if (rec.tokensAfter !== undefined) {
          contextTokens = rec.tokensAfter;
          contextSeries.push({ lineNo: entry.lineNo, time: t, turnIndex: current?.index ?? -1, step: -1, contextTokens });
          if (contextTokens > peakContext) peakContext = contextTokens;
        }
        break;

      case 'config.update': {
        const cwd = rec.environmentDisclosure?.cwd;
        const effort = rec.thinkingEffort ?? rec.thinkingLevel;
        const changed: { field: string; value: string }[] = [];
        if (rec.profileName !== undefined) changed.push({ field: 'profile', value: rec.profileName });
        if (rec.modelAlias !== undefined) changed.push({ field: 'model', value: rec.modelAlias });
        if (effort !== undefined) changed.push({ field: 'thinking', value: effort });
        if (cwd !== undefined) changed.push({ field: 'cwd', value: cwd });
        if (rec.systemPrompt !== undefined) changed.push({ field: 'systemPrompt', value: `${rec.systemPrompt.length} chars` });
        if (changed.length > 0) configChanges.push({ lineNo: entry.lineNo, time: t, changed });
        break;
      }

      case 'profile.bind': {
        const changed: { field: string; value: string }[] = [];
        if (rec.profileName !== undefined) changed.push({ field: 'profile', value: rec.profileName });
        if (rec.modelAlias !== undefined) changed.push({ field: 'model', value: rec.modelAlias });
        changed.push({ field: 'thinking', value: rec.thinkingEffort });
        if (rec.environmentDisclosure !== undefined) changed.push({ field: 'cwd', value: rec.environmentDisclosure.cwd });
        changed.push({ field: 'systemPrompt', value: `${rec.systemPrompt.length} chars` });
        configChanges.push({ lineNo: entry.lineNo, time: t, changed });
        break;
      }

      case 'context.append_loop_event': {
        const ev = rec.event;
        if (ev.type === 'step.begin') {
          const parsedTurnId =
            ev.turnId === undefined ? undefined : Number.parseInt(ev.turnId, 10);
          const validTurnId =
            parsedTurnId !== undefined && Number.isInteger(parsedTurnId)
              ? parsedTurnId
              : undefined;
          let turn: TurnNode | null = current;
          if (
            turn === null ||
            turn.outcome !== undefined ||
            (validTurnId !== undefined &&
              turn.turnId !== undefined &&
              turn.turnId !== validTurnId)
          ) {
            turn = pendingSteer === null
              ? startTurn('prompt', entry.lineNo, t, '(no prompt record)', undefined)
              : startTurn(
                  'steer',
                  pendingSteer.lineNo,
                  pendingSteer.time,
                  pendingSteer.text,
                  pendingSteer.originKind,
                );
          }
          pendingSteer = null;
          current = turn;
          if (validTurnId !== undefined) {
            turn.turnId ??= validTurnId;
          }
          const step: StepNode = {
            uuid: ev.uuid,
            step: ev.step ?? -1,
            turnId: ev.turnId ?? '',
            beginLineNo: entry.lineNo,
            beginTime: t,
            content: { textChars: 0, thinkChars: 0 },
            toolCalls: [],
          };
          stepByUuid.set(ev.uuid, step);
          turn.steps.push(step);
          turn.startTime ??= t;
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
            step.llmClientBlockedMs = ev.llmClientBlockedMs;
            if (step.beginTime !== undefined && t !== undefined) step.durationMs = t - step.beginTime;
            step.isError = ev.finishReason === 'filtered' || ev.finishReason === 'error';
            if ('usage' in ev && ev.usage !== undefined) {
              step.usage = ev.usage;
              if (current) addUsage(current.tokens, ev.usage);
              addUsage(cache, ev.usage);
              const fill = contextFill(ev.usage);
              if (fill !== undefined && fill > 0) {
                contextTokens = fill;
                if (contextTokens > peakContext) peakContext = contextTokens;
              }
              step.contextTokens = contextTokens;
              contextSeries.push({
                lineNo: entry.lineNo,
                time: t,
                turnIndex: current?.index ?? -1,
                step: ev.step ?? -1,
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
            description: (ev as { description?: string }).description,
            callTime: t,
          };
          toolByCallId.set(ev.toolCallId, node);
          const step = stepByUuid.get(ev.stepUuid);
          (step ? step.toolCalls : current?.steps.at(-1)?.toolCalls)?.push(node);
          if (current) current.toolCallCount += 1;
        } else if (ev.type === 'content.part') {
          const step = stepByUuid.get(ev.stepUuid);
          const part = ev.part as { type?: string; text?: string; think?: string } | undefined;
          if (step && part) {
            if (part.type === 'think') {
              step.content.thinkChars += typeof part.think === 'string' ? part.think.length : 0;
            } else {
              step.content.textChars += typeof part.text === 'string' ? part.text.length : 0;
            }
          }
        } else if (ev.type === 'tool.result') {
          const node = toolByCallId.get(ev.toolCallId);
          const isError = ev.result.isError === true;
          const result = ev.result as { truncated?: boolean; message?: string; note?: string };
          const truncated = result.truncated === true;
          const bytes = outputSize(ev.result.output);
          if (node) {
            node.resultLineNo = entry.lineNo;
            node.resultTime = t;
            node.isError = isError;
            node.truncated = truncated;
            node.outputBytes = bytes;
            node.resultMessage = result.message ?? result.note;
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
  let totalTokens: number | undefined = 0;
  let activeMs = 0;
  for (const turn of turns) {
    if (
      turn.durationMs === undefined &&
      turn.startTime !== undefined &&
      turn.endTime !== undefined
    ) {
      turn.durationMs = turn.endTime - turn.startTime;
    }
    stepCount += turn.steps.length;
    toolCallCount += turn.toolCallCount;
    toolErrorCount += turn.toolErrorCount;
    const turnTotal = usageTotal(turn.tokens);
    totalTokens =
      totalTokens === undefined || turnTotal === undefined
        ? undefined
        : totalTokens + turnTotal;
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
  const inputTotal =
    c.inputCacheRead === undefined
      ? undefined
      : c.inputOther + c.inputCacheRead + c.inputCacheCreation;
  return {
    inputOther: c.inputOther,
    inputCacheRead: c.inputCacheRead,
    inputCacheCreation: c.inputCacheCreation,
    output: c.output,
    hitRate:
      c.inputCacheRead === undefined || inputTotal === undefined || inputTotal === 0
        ? null
        : c.inputCacheRead / inputTotal,
  };
}
