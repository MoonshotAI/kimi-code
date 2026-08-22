import type { WireEntry } from '../types';

export const LOOP_EVAL_REPORT_VERSION = 1;
export const DEFAULT_REPETITION_WINDOW_CALLS = 20;
export const DEFAULT_STEER_COMPARISON_CALLS = 10;

export interface LoopEvalOptions {
  /** Exact-size rolling window used for local repetition measurements. */
  repetitionWindowCalls?: number;
  /** Calls sampled on each side of a turn.steer marker. */
  steerComparisonCalls?: number;
}

export interface LoopEvalSettings {
  repetitionWindowCalls: number;
  steerComparisonCalls: number;
}

export type LoopEvalMarker =
  | { kind: 'steer'; lineNo: number; recordType: 'turn.steer' }
  | { kind: 'cancel'; lineNo: number; recordType: 'turn.cancel' }
  | {
      kind: 'compaction';
      lineNo: number;
      recordType:
        | 'full_compaction.begin'
        | 'full_compaction.complete'
        | 'full_compaction.cancel'
        | 'context.apply_compaction';
    };

export interface ExactRun {
  length: number;
  toolName: string;
  startLineNo: number;
  endLineNo: number;
}

export interface RepetitionWindow {
  callCount: number;
  repeatedCallCount: number;
  repeatedCallRate: number;
  startLineNo: number;
  endLineNo: number;
}

export interface PromptPhaseEvaluation {
  /** Phase 0 is the preamble before the first accepted turn.prompt. */
  index: number;
  /** Accepted prompt that starts this phase; null for phase 0. Prompt text is excluded. */
  promptLineNo: number | null;
  /** Accepted prompt that ends this phase; null for the final phase. */
  nextPromptLineNo: number | null;
  toolCallCount: number;
  distinctCallCount: number;
  /** Calls whose exact (tool, canonical args) pair appeared earlier in this phase. */
  repeatedCallCount: number;
  repeatedCallRate: number;
  longestExactRun: ExactRun | null;
  /** Null until a phase contains one complete configured-size window. */
  peakRepetitionWindow: RepetitionWindow | null;
  /** Marker metadata only. Prompt/steer content is intentionally excluded. */
  markers: LoopEvalMarker[];
}

export interface SteerComparison {
  phaseIndex: number;
  steerLineNo: number;
  beforeCallCount: number;
  afterCallCount: number;
  beforeDistinctCallCount: number;
  afterDistinctCallCount: number;
  /** True when both sides contain the configured number of calls. */
  complete: boolean;
  /**
   * Histogram intersection for exact (tool, canonical args) pairs.
   * 0 means disjoint distributions and 1 means identical distributions.
   * Null means at least one side has no calls.
   */
  histogramOverlap: number | null;
  beforeStartLineNo: number | null;
  beforeEndLineNo: number | null;
  afterStartLineNo: number | null;
  afterEndLineNo: number | null;
}

export interface LoopEvalSummary {
  phaseCount: number;
  toolCallCount: number;
  repeatedCallCount: number;
  repeatedCallRate: number;
  steerCount: number;
  cancelCount: number;
  compactionApplyCount: number;
  longestExactRun: (ExactRun & { phaseIndex: number }) | null;
  peakRepetitionWindow: (RepetitionWindow & { phaseIndex: number }) | null;
  completeSteerComparisonCount: number;
  /** Mean overlap across complete steer windows only. */
  meanCompleteSteerHistogramOverlap: number | null;
}

export interface LoopEvaluation {
  version: typeof LOOP_EVAL_REPORT_VERSION;
  settings: LoopEvalSettings;
  summary: LoopEvalSummary;
  phases: PromptPhaseEvaluation[];
  steerComparisons: SteerComparison[];
}

type CompactionRecordType = Extract<
  LoopEvalMarker,
  { kind: 'compaction' }
>['recordType'];

interface FingerprintedCall {
  key: string;
  lineNo: number;
  toolName: string;
}

interface PendingSteer {
  lineNo: number;
  callIndex: number;
}

interface MutablePhase {
  index: number;
  promptLineNo: number | null;
  nextPromptLineNo: number | null;
  calls: FingerprintedCall[];
  markers: LoopEvalMarker[];
  steers: PendingSteer[];
}

const COMPACTION_RECORD_TYPES = new Set<CompactionRecordType>([
  'full_compaction.begin',
  'full_compaction.complete',
  'full_compaction.cancel',
  'context.apply_compaction',
]);

/**
 * Evaluate repetition and steer-response signals from a persisted wire.
 *
 * The report intentionally contains no prompt text, tool arguments, tool
 * results, or fingerprints. Those values exist only while this pure function
 * is running and are omitted from the aggregate report.
 */
export function evaluateLoopTrace(
  entries: readonly WireEntry[],
  options: LoopEvalOptions = {},
): LoopEvaluation {
  const settings: LoopEvalSettings = {
    repetitionWindowCalls: positiveInteger(
      options.repetitionWindowCalls,
      DEFAULT_REPETITION_WINDOW_CALLS,
    ),
    steerComparisonCalls: positiveInteger(
      options.steerComparisonCalls,
      DEFAULT_STEER_COMPARISON_CALLS,
    ),
  };

  if (entries.length === 0) return emptyEvaluation(settings);

  const acceptedPromptLineNos = findAcceptedPromptLineNos(entries);
  const mutablePhases: MutablePhase[] = [];
  let current = createPhase(0, null);

  for (const entry of entries) {
    const record = entry.data;

    if (record.type === 'turn.prompt') {
      if (!acceptedPromptLineNos.has(entry.lineNo)) continue;
      current.nextPromptLineNo = entry.lineNo;
      mutablePhases.push(current);
      current = createPhase(mutablePhases.length, entry.lineNo);
      continue;
    }

    if (record.type === 'turn.steer') {
      current.markers.push({
        kind: 'steer',
        lineNo: entry.lineNo,
        recordType: 'turn.steer',
      });
      current.steers.push({ lineNo: entry.lineNo, callIndex: current.calls.length });
      continue;
    }

    if (record.type === 'turn.cancel') {
      current.markers.push({
        kind: 'cancel',
        lineNo: entry.lineNo,
        recordType: 'turn.cancel',
      });
      continue;
    }

    if (isCompactionRecordType(record.type)) {
      current.markers.push({
        kind: 'compaction',
        lineNo: entry.lineNo,
        recordType: record.type,
      });
      continue;
    }

    if (
      record.type === 'context.append_loop_event' &&
      record.event.type === 'tool.call'
    ) {
      current.calls.push({
        key: toolCallKey(record.event.name, record.event.args),
        lineNo: entry.lineNo,
        toolName: record.event.name,
      });
    }
  }
  mutablePhases.push(current);

  const phases = mutablePhases.map((phase) =>
    evaluatePhase(phase, settings.repetitionWindowCalls),
  );
  const steerComparisons = mutablePhases.flatMap((phase) =>
    compareSteers(phase, settings.steerComparisonCalls),
  );

  return {
    version: LOOP_EVAL_REPORT_VERSION,
    settings,
    summary: summarize(phases, steerComparisons),
    phases,
    steerComparisons,
  };
}

function findAcceptedPromptLineNos(entries: readonly WireEntry[]): ReadonlySet<number> {
  const accepted = new Set<number>();
  let currentTurnId: string | undefined;
  let pendingPromptLineNo: number | undefined;

  for (const entry of entries) {
    const record = entry.data;
    if (record.type === 'turn.prompt') {
      pendingPromptLineNo = entry.lineNo;
      continue;
    }
    if (
      record.type !== 'context.append_loop_event' ||
      !('turnId' in record.event)
    ) {
      continue;
    }

    const nextTurnId = record.event.turnId;
    if (pendingPromptLineNo !== undefined && nextTurnId !== currentTurnId) {
      accepted.add(pendingPromptLineNo);
    }
    pendingPromptLineNo = undefined;
    currentTurnId = nextTurnId;
  }

  return accepted;
}

function createPhase(index: number, promptLineNo: number | null): MutablePhase {
  return {
    index,
    promptLineNo,
    nextPromptLineNo: null,
    calls: [],
    markers: [],
    steers: [],
  };
}

function evaluatePhase(
  phase: MutablePhase,
  repetitionWindowCalls: number,
): PromptPhaseEvaluation {
  const seen = new Set<string>();
  let repeatedCallCount = 0;
  for (const call of phase.calls) {
    if (seen.has(call.key)) repeatedCallCount += 1;
    else seen.add(call.key);
  }

  return {
    index: phase.index,
    promptLineNo: phase.promptLineNo,
    nextPromptLineNo: phase.nextPromptLineNo,
    toolCallCount: phase.calls.length,
    distinctCallCount: seen.size,
    repeatedCallCount,
    repeatedCallRate: rate(repeatedCallCount, phase.calls.length),
    longestExactRun: longestExactRun(phase.calls),
    peakRepetitionWindow: peakRepetitionWindow(
      phase.calls,
      repetitionWindowCalls,
    ),
    markers: [...phase.markers],
  };
}

function longestExactRun(calls: readonly FingerprintedCall[]): ExactRun | null {
  const first = calls[0];
  if (first === undefined) return null;

  let best: ExactRun = {
    length: 1,
    toolName: first.toolName,
    startLineNo: first.lineNo,
    endLineNo: first.lineNo,
  };
  let currentKey = first.key;
  let currentToolName = first.toolName;
  let currentStartLineNo = first.lineNo;
  let currentLength = 1;

  for (let index = 1; index < calls.length; index += 1) {
    const call = calls[index]!;
    if (call.key === currentKey) {
      currentLength += 1;
    } else {
      currentKey = call.key;
      currentToolName = call.toolName;
      currentStartLineNo = call.lineNo;
      currentLength = 1;
    }
    if (currentLength > best.length) {
      best = {
        length: currentLength,
        toolName: currentToolName,
        startLineNo: currentStartLineNo,
        endLineNo: call.lineNo,
      };
    }
  }

  return best;
}

function peakRepetitionWindow(
  calls: readonly FingerprintedCall[],
  windowCalls: number,
): RepetitionWindow | null {
  if (calls.length < windowCalls) return null;

  const counts = new Map<string, number>();
  for (let index = 0; index < windowCalls; index += 1) {
    increment(counts, calls[index]!.key);
  }

  let bestStart = 0;
  let bestRepeated = windowCalls - counts.size;
  for (let start = 1; start + windowCalls <= calls.length; start += 1) {
    decrement(counts, calls[start - 1]!.key);
    increment(counts, calls[start + windowCalls - 1]!.key);
    const repeated = windowCalls - counts.size;
    if (repeated > bestRepeated) {
      bestStart = start;
      bestRepeated = repeated;
    }
  }

  return {
    callCount: windowCalls,
    repeatedCallCount: bestRepeated,
    repeatedCallRate: bestRepeated / windowCalls,
    startLineNo: calls[bestStart]!.lineNo,
    endLineNo: calls[bestStart + windowCalls - 1]!.lineNo,
  };
}

function compareSteers(
  phase: MutablePhase,
  comparisonCalls: number,
): SteerComparison[] {
  return phase.steers.map((steer) => {
    const before = phase.calls.slice(
      Math.max(0, steer.callIndex - comparisonCalls),
      steer.callIndex,
    );
    const after = phase.calls.slice(
      steer.callIndex,
      steer.callIndex + comparisonCalls,
    );
    return {
      phaseIndex: phase.index,
      steerLineNo: steer.lineNo,
      beforeCallCount: before.length,
      afterCallCount: after.length,
      beforeDistinctCallCount: distinctCount(before),
      afterDistinctCallCount: distinctCount(after),
      complete:
        before.length === comparisonCalls && after.length === comparisonCalls,
      histogramOverlap: histogramOverlap(before, after),
      beforeStartLineNo: before[0]?.lineNo ?? null,
      beforeEndLineNo: before.at(-1)?.lineNo ?? null,
      afterStartLineNo: after[0]?.lineNo ?? null,
      afterEndLineNo: after.at(-1)?.lineNo ?? null,
    };
  });
}

function summarize(
  phases: readonly PromptPhaseEvaluation[],
  steerComparisons: readonly SteerComparison[],
): LoopEvalSummary {
  let toolCallCount = 0;
  let repeatedCallCount = 0;
  let steerCount = 0;
  let cancelCount = 0;
  let compactionApplyCount = 0;
  let longest: LoopEvalSummary['longestExactRun'] = null;
  let peak: LoopEvalSummary['peakRepetitionWindow'] = null;

  for (const phase of phases) {
    toolCallCount += phase.toolCallCount;
    repeatedCallCount += phase.repeatedCallCount;
    for (const marker of phase.markers) {
      if (marker.kind === 'steer') steerCount += 1;
      else if (marker.kind === 'cancel') cancelCount += 1;
      else if (marker.recordType === 'context.apply_compaction') {
        compactionApplyCount += 1;
      }
    }

    if (
      phase.longestExactRun !== null &&
      (longest === null || phase.longestExactRun.length > longest.length)
    ) {
      longest = { ...phase.longestExactRun, phaseIndex: phase.index };
    }
    if (
      phase.peakRepetitionWindow !== null &&
      (peak === null ||
        phase.peakRepetitionWindow.repeatedCallRate > peak.repeatedCallRate)
    ) {
      peak = { ...phase.peakRepetitionWindow, phaseIndex: phase.index };
    }
  }

  const completeOverlaps = steerComparisons.flatMap((comparison) =>
    comparison.complete && comparison.histogramOverlap !== null
      ? [comparison.histogramOverlap]
      : [],
  );

  return {
    phaseCount: phases.length,
    toolCallCount,
    repeatedCallCount,
    repeatedCallRate: rate(repeatedCallCount, toolCallCount),
    steerCount,
    cancelCount,
    compactionApplyCount,
    longestExactRun: longest,
    peakRepetitionWindow: peak,
    completeSteerComparisonCount: completeOverlaps.length,
    meanCompleteSteerHistogramOverlap:
      completeOverlaps.length === 0
        ? null
        : completeOverlaps.reduce((sum, value) => sum + value, 0) /
          completeOverlaps.length,
  };
}

function histogramOverlap(
  before: readonly FingerprintedCall[],
  after: readonly FingerprintedCall[],
): number | null {
  if (before.length === 0 || after.length === 0) return null;
  const beforeCounts = histogram(before);
  const afterCounts = histogram(after);
  let overlap = 0;
  for (const [key, beforeCount] of beforeCounts) {
    const afterCount = afterCounts.get(key) ?? 0;
    overlap += Math.min(
      beforeCount / before.length,
      afterCount / after.length,
    );
  }
  return overlap;
}

function histogram(calls: readonly FingerprintedCall[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const call of calls) increment(counts, call.key);
  return counts;
}

function distinctCount(calls: readonly FingerprintedCall[]): number {
  return new Set(calls.map((call) => call.key)).size;
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function decrement(counts: Map<string, number>, key: string): void {
  const count = counts.get(key);
  if (count === undefined || count <= 1) counts.delete(key);
  else counts.set(key, count - 1);
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

function isCompactionRecordType(
  type: string,
): type is CompactionRecordType {
  return COMPACTION_RECORD_TYPES.has(type as CompactionRecordType);
}

function toolCallKey(toolName: string, args: unknown): string {
  const canonicalArgs = JSON.stringify(sortJsonValue(args)) ?? String(args);
  return JSON.stringify([toolName, canonicalArgs]);
}

// Mirrors agent-core's recursive object-key ordering. Kept local because vis
// is also shipped as a standalone browser bundle and the runtime helper is not
// part of agent-core's public API.
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isPlainRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    sorted[key] = sortJsonValue(value[key]);
  }
  return sorted;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function emptyEvaluation(settings: LoopEvalSettings): LoopEvaluation {
  return {
    version: LOOP_EVAL_REPORT_VERSION,
    settings,
    summary: {
      phaseCount: 0,
      toolCallCount: 0,
      repeatedCallCount: 0,
      repeatedCallRate: 0,
      steerCount: 0,
      cancelCount: 0,
      compactionApplyCount: 0,
      longestExactRun: null,
      peakRepetitionWindow: null,
      completeSteerComparisonCount: 0,
      meanCompleteSteerHistogramOverlap: null,
    },
    phases: [],
    steerComparisons: [],
  };
}
