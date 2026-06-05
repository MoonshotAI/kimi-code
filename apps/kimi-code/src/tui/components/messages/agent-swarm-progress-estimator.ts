const DEFAULT_RATE_WINDOW_MS = 45_000;
const DEFAULT_CATCHUP_TIME_MS = 1_500;
const DEFAULT_WORKLOAD_SPREAD_FACTOR = 1.5;
const DEFAULT_UNFINISHED_PROGRESS_CAP = 0.85;
const DEFAULT_MAX_BOOST_GAIN = 0.75;
const RATE_TOOL_CONFIDENCE_SCALE = 4;
const BOOST_TOOL_CONFIDENCE_SCALE = 3;
const MIN_RATE_FACTOR = 0.25;
const HALF_TICK = 0.5;

export type AgentSwarmProgressEstimatorPhase =
  | 'pending'
  | 'queued'
  | 'suspended'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentSwarmProgressEstimatorOptions {
  readonly rateWindowMs?: number;
  readonly catchupTimeMs?: number;
  readonly maxCatchupTicksPerSecond?: number;
  readonly workloadSpreadFactor?: number;
  readonly unfinishedProgressCap?: number;
  readonly maxBoostGain?: number;
}

export interface AgentSwarmProgressEstimateInput {
  readonly memberKey: string;
  readonly phase: AgentSwarmProgressEstimatorPhase;
  readonly capacityTicks: number;
  readonly nowMs: number;
}

export interface AgentSwarmProgressEstimate {
  readonly rawTicks: number;
  readonly displayTicks: number;
  readonly estimatedTotalToolCalls?: number;
  readonly estimatedProgress?: number;
  readonly targetProgress?: number;
  readonly targetTicks?: number;
  readonly boosted: boolean;
  readonly confidence?: number;
}

interface MemberProgressState {
  startedAtMs?: number;
  pausedAtMs?: number;
  pausedDurationMs: number;
  terminalAtMs?: number;
  terminalKind?: 'completed' | 'failed' | 'cancelled';
  rawTicks: number;
  readonly seenToolCallIds: Set<string>;
  toolCallActiveTimesMs: number[];
  displayTicks: number;
  lastEstimateAtMs?: number;
  lastTargetTicks?: number;
}

interface CompletedSample {
  readonly totalMs: number;
  readonly rawTicks: number;
}

interface EstimatePrior {
  readonly completedCount: number;
  readonly typicalTotalMs: number;
  readonly typicalToolCalls: number;
  readonly typicalRatePerMs: number;
}

export class AgentSwarmProgressEstimator {
  private readonly members = new Map<string, MemberProgressState>();
  private readonly rateWindowMs: number;
  private readonly catchupTimeMs: number;
  private readonly maxCatchupTicksPerSecond: number | undefined;
  private readonly workloadSpreadFactor: number;
  private readonly unfinishedProgressCap: number;
  private readonly maxBoostGain: number;

  constructor(options: AgentSwarmProgressEstimatorOptions = {}) {
    this.rateWindowMs = positiveOrDefault(options.rateWindowMs, DEFAULT_RATE_WINDOW_MS);
    this.catchupTimeMs = positiveOrDefault(options.catchupTimeMs, DEFAULT_CATCHUP_TIME_MS);
    this.maxCatchupTicksPerSecond = positiveOrUndefined(options.maxCatchupTicksPerSecond);
    this.workloadSpreadFactor = spreadFactorOrDefault(
      options.workloadSpreadFactor,
      DEFAULT_WORKLOAD_SPREAD_FACTOR,
    );
    this.unfinishedProgressCap = clampPositiveRatio(
      options.unfinishedProgressCap,
      DEFAULT_UNFINISHED_PROGRESS_CAP,
    );
    this.maxBoostGain = clampPositiveRatio(options.maxBoostGain, DEFAULT_MAX_BOOST_GAIN);
  }

  ensureMember(memberKey: string, nowMs: number): void {
    void nowMs;
    this.getOrCreateMember(memberKey);
  }

  removeMissingMembers(memberKeys: readonly string[]): void {
    const live = new Set(memberKeys);
    for (const memberKey of this.members.keys()) {
      if (!live.has(memberKey)) this.members.delete(memberKey);
    }
  }

  markStarted(memberKey: string, nowMs: number): void {
    const state = this.getOrCreateMember(memberKey);
    this.startWork(state, nowMs);
    if (state.rawTicks === 0) {
      state.rawTicks = 1;
      state.displayTicks = Math.max(state.displayTicks, 1);
    }
    delete state.terminalAtMs;
    delete state.terminalKind;
  }

  markQueued(memberKey: string, nowMs: number): void {
    const state = this.getOrCreateMember(memberKey);
    if (state.startedAtMs === undefined || state.terminalKind !== undefined) return;
    state.pausedAtMs ??= nowMs;
    state.lastEstimateAtMs = nowMs;
    delete state.lastTargetTicks;
  }

  recordToolCall(input: {
    readonly memberKey: string;
    readonly toolCallId: string;
    readonly nowMs: number;
  }): { readonly accepted: boolean; readonly rawTicks: number } {
    const state = this.getOrCreateMember(input.memberKey);
    this.startWork(state, input.nowMs);
    if (state.seenToolCallIds.has(input.toolCallId)) {
      return { accepted: false, rawTicks: state.rawTicks };
    }
    state.seenToolCallIds.add(input.toolCallId);
    state.toolCallActiveTimesMs.push(this.activeElapsedMs(state, input.nowMs));
    state.rawTicks += 1;
    state.displayTicks = Math.max(state.displayTicks + 1, state.rawTicks);
    delete state.terminalAtMs;
    delete state.terminalKind;
    return { accepted: true, rawTicks: state.rawTicks };
  }

  markCompleted(memberKey: string, nowMs: number): void {
    this.markTerminal(memberKey, nowMs, 'completed');
  }

  markFailed(memberKey: string, nowMs: number): void {
    this.markTerminal(memberKey, nowMs, 'failed');
  }

  markCancelled(memberKey: string, nowMs: number): void {
    this.markTerminal(memberKey, nowMs, 'cancelled');
  }

  estimate(input: AgentSwarmProgressEstimateInput): AgentSwarmProgressEstimate {
    const state = this.getOrCreateMember(input.memberKey);
    const capacityTicks = Math.max(1, input.capacityTicks);
    const rawTicks = state.rawTicks;
    const previousDisplayTicks = Math.max(state.displayTicks, rawTicks);
    const prior = this.buildPrior();
    const baseEstimate = {
      rawTicks,
      displayTicks: previousDisplayTicks,
      boosted: false,
    };

    if (input.phase !== 'running' || rawTicks <= 0 || prior === undefined) {
      state.displayTicks = previousDisplayTicks;
      state.lastEstimateAtMs = input.nowMs;
      delete state.lastTargetTicks;
      return baseEstimate;
    }

    const completedConfidence = this.completedSampleConfidence(prior.completedCount);
    const estimatedTotalToolCalls = this.estimateTotalToolCalls(
      state,
      prior,
      input.nowMs,
      completedConfidence,
    );
    const estimatedProgress = Math.min(
      this.unfinishedProgressCap,
      rawTicks / estimatedTotalToolCalls,
    );
    const rawProgress = Math.min(1, rawTicks / capacityTicks);
    if (estimatedProgress <= rawProgress) {
      state.displayTicks = previousDisplayTicks;
      state.lastEstimateAtMs = input.nowMs;
      delete state.lastTargetTicks;
      return {
        ...baseEstimate,
        estimatedTotalToolCalls,
        estimatedProgress,
        boosted: false,
      };
    }

    const toolConfidence = confidence(rawTicks, BOOST_TOOL_CONFIDENCE_SCALE);
    const boostConfidence = completedConfidence * toolConfidence;
    const boostGain = this.maxBoostGain * boostConfidence;
    const targetProgress = rawProgress + boostGain * (estimatedProgress - rawProgress);
    const targetTicks = Math.max(rawTicks, targetProgress * capacityTicks);
    const displayTicks = this.catchUpDisplayTicks(
      state,
      previousDisplayTicks,
      targetTicks,
      capacityTicks,
      input.nowMs,
    );

    state.displayTicks = displayTicks;
    state.lastEstimateAtMs = input.nowMs;
    state.lastTargetTicks = targetTicks;
    return {
      rawTicks,
      displayTicks,
      estimatedTotalToolCalls,
      estimatedProgress,
      targetProgress,
      targetTicks,
      boosted: displayTicks > rawTicks,
      confidence: boostConfidence,
    };
  }

  estimateAll(
    inputs: readonly AgentSwarmProgressEstimateInput[],
  ): Map<string, AgentSwarmProgressEstimate> {
    const estimates = new Map<string, AgentSwarmProgressEstimate>();
    for (const input of inputs) {
      estimates.set(input.memberKey, this.estimate(input));
    }
    return estimates;
  }

  hasPendingCatchup(): boolean {
    return Array.from(this.members.values()).some(
      (state) => state.lastTargetTicks !== undefined && state.lastTargetTicks > state.displayTicks + 0.1,
    );
  }

  private markTerminal(
    memberKey: string,
    nowMs: number,
    terminalKind: 'completed' | 'failed' | 'cancelled',
  ): void {
    const state = this.getOrCreateMember(memberKey);
    this.finishPausedInterval(state, nowMs);
    state.terminalAtMs = nowMs;
    state.terminalKind = terminalKind;
    state.displayTicks = Math.max(state.displayTicks, state.rawTicks);
    delete state.lastTargetTicks;
  }

  private startWork(state: MemberProgressState, nowMs: number): void {
    const wasQueued = state.startedAtMs === undefined || state.pausedAtMs !== undefined;
    state.startedAtMs ??= nowMs;
    this.finishPausedInterval(state, nowMs);
    if (!wasQueued) return;
    delete state.lastEstimateAtMs;
    delete state.lastTargetTicks;
  }

  private finishPausedInterval(state: MemberProgressState, nowMs: number): void {
    if (state.pausedAtMs === undefined) return;
    state.pausedDurationMs += Math.max(0, nowMs - state.pausedAtMs);
    delete state.pausedAtMs;
  }

  private activeElapsedMs(state: MemberProgressState, nowMs: number): number {
    if (state.startedAtMs === undefined) return 0;
    const currentPausedMs =
      state.pausedAtMs === undefined ? 0 : Math.max(0, nowMs - state.pausedAtMs);
    return Math.max(0, nowMs - state.startedAtMs - state.pausedDurationMs - currentPausedMs);
  }

  private getOrCreateMember(memberKey: string): MemberProgressState {
    const state = this.members.get(memberKey) ?? {
      pausedDurationMs: 0,
      rawTicks: 0,
      seenToolCallIds: new Set(),
      toolCallActiveTimesMs: [],
      displayTicks: 0,
    };
    this.members.set(memberKey, state);
    return state;
  }

  private buildPrior(): EstimatePrior | undefined {
    const samples = this.completedSamples();
    if (samples.length === 0) return undefined;
    return {
      completedCount: samples.length,
      typicalTotalMs: logMedian(samples.map((sample) => sample.totalMs)),
      typicalToolCalls: logMedian(samples.map((sample) => sample.rawTicks)),
      typicalRatePerMs: logMedian(
        samples.map((sample) => (sample.rawTicks + HALF_TICK) / sample.totalMs),
      ),
    };
  }

  private completedSamples(): CompletedSample[] {
    const samples: CompletedSample[] = [];
    for (const state of this.members.values()) {
      if (state.terminalKind !== 'completed') continue;
      if (state.startedAtMs === undefined || state.terminalAtMs === undefined) continue;
      if (state.rawTicks <= 0) continue;
      const totalMs = this.activeElapsedMs(state, state.terminalAtMs);
      if (totalMs <= 0) continue;
      samples.push({ totalMs, rawTicks: state.rawTicks });
    }
    return samples;
  }

  private estimateTotalToolCalls(
    state: MemberProgressState,
    prior: EstimatePrior,
    nowMs: number,
    completedConfidence: number,
  ): number {
    const elapsedMs = this.activeElapsedMs(state, nowMs);
    const localRatePerMs = this.estimateLocalRatePerMs(state, elapsedMs);
    const rateWeight = confidence(state.rawTicks, RATE_TOOL_CONFIDENCE_SCALE);
    const clampedLocalRatePerMs = Math.max(
      localRatePerMs,
      prior.typicalRatePerMs * MIN_RATE_FACTOR,
    );
    const ratePerMs = geometricInterpolate(
      prior.typicalRatePerMs,
      clampedLocalRatePerMs,
      rateWeight,
    );
    const totalMs = Math.max(prior.typicalTotalMs, elapsedMs / this.unfinishedProgressCap);
    const estimatedTotalToolCalls = ratePerMs * totalMs;
    const boundedTotalToolCalls = this.softBoundTotalToolCalls(
      estimatedTotalToolCalls,
      prior,
      completedConfidence,
    );
    return Math.max(
      boundedTotalToolCalls,
      state.rawTicks / this.unfinishedProgressCap,
      1,
    );
  }

  private softBoundTotalToolCalls(
    totalToolCalls: number,
    prior: EstimatePrior,
    completedConfidence: number,
  ): number {
    const lowerBound = prior.typicalToolCalls / this.workloadSpreadFactor;
    const upperBound = prior.typicalToolCalls * this.workloadSpreadFactor;
    const bounded = Math.max(lowerBound, Math.min(upperBound, totalToolCalls));
    if (bounded === totalToolCalls) return totalToolCalls;
    return geometricInterpolate(totalToolCalls, bounded, completedConfidence);
  }

  private estimateLocalRatePerMs(
    state: MemberProgressState,
    elapsedMs: number,
  ): number {
    if (elapsedMs <= 0 || state.toolCallActiveTimesMs.length === 0) return 0;
    let decayedToolCalls = 0;
    for (const timeMs of state.toolCallActiveTimesMs) {
      decayedToolCalls += Math.exp(-Math.max(0, elapsedMs - timeMs) / this.rateWindowMs);
    }
    const decayedElapsedMs = this.rateWindowMs * (1 - Math.exp(-elapsedMs / this.rateWindowMs));
    if (decayedElapsedMs <= 0) return 0;
    return decayedToolCalls / decayedElapsedMs;
  }

  private catchUpDisplayTicks(
    state: MemberProgressState,
    previousDisplayTicks: number,
    targetTicks: number,
    capacityTicks: number,
    nowMs: number,
  ): number {
    if (targetTicks <= previousDisplayTicks) return previousDisplayTicks;
    const lastEstimateAtMs = state.lastEstimateAtMs ?? nowMs;
    const elapsedMs = Math.max(0, nowMs - lastEstimateAtMs);
    if (elapsedMs <= 0) return previousDisplayTicks;
    const alpha = 1 - Math.exp(-elapsedMs / this.catchupTimeMs);
    const desiredDelta = (targetTicks - previousDisplayTicks) * alpha;
    const maxCatchupTicksPerSecond = this.maxCatchupTicksPerSecond ?? capacityTicks / 2;
    const maxDelta = Math.max(0, maxCatchupTicksPerSecond * (elapsedMs / 1_000));
    return previousDisplayTicks + Math.min(desiredDelta, maxDelta);
  }

  private completedSampleConfidence(completedCount: number): number {
    return confidence(completedCount, 1 + this.workloadSpreadFactor);
  }
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveOrUndefined(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

function spreadFactorOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 1 ? value : fallback;
}

function clampPositiveRatio(value: number | undefined, fallback: number): number {
  const ratio = positiveOrDefault(value, fallback);
  return Math.max(0.01, Math.min(0.99, ratio));
}

function confidence(count: number, scale: number): number {
  return 1 - Math.exp(-Math.max(0, count) / scale);
}

function geometricInterpolate(low: number, high: number, weight: number): number {
  const safeLow = Math.max(Number.EPSILON, low);
  const safeHigh = Math.max(Number.EPSILON, high);
  return Math.exp((1 - weight) * Math.log(safeLow) + weight * Math.log(safeHigh));
}

function logMedian(values: readonly number[]): number {
  const logs = values
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.log(value))
    .toSorted((left, right) => left - right);
  if (logs.length === 0) return 1;
  const middle = Math.floor(logs.length / 2);
  if (logs.length % 2 === 1) return Math.exp(logs[middle]!);
  return Math.exp((logs[middle - 1]! + logs[middle]!) / 2);
}
