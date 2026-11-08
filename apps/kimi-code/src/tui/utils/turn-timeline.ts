import {
  TRANSCRIPT_GROUP_COUNT_DELAY_MS,
  TRANSCRIPT_TAIL_ENTER_MS,
  TRANSCRIPT_TAIL_THINKING_THROTTLE_MS,
  TRANSCRIPT_TAIL_THINKING_TICK_MS,
  TRANSCRIPT_TAIL_THOUGHT_HOLD_MS,
} from '#/tui/constant/rendering';

export type Instant = number & { readonly __brand: 'Instant' };
export type ToolCallId = string & { readonly __brand: 'ToolCallId' };
export type Clock = () => Instant;

function isInstant(ms: number): ms is Instant {
  return Number.isFinite(ms);
}

export function instant(ms: number): Instant {
  if (!isInstant(ms)) throw new RangeError(`An instant must be a finite number of milliseconds, got ${ms}`);
  return ms;
}

export function monotonicNow(): Instant {
  return instant(performance.now());
}

export function isToolCallId(id: string): id is ToolCallId {
  return id.length > 0;
}

export type CallSettle =
  | { readonly kind: 'result'; readonly at: Instant }
  | { readonly kind: 'abandoned'; readonly at: Instant };

export interface CallFacts {
  readonly start: Instant;
  readonly name?: string;
  readonly argsEnd?: Instant;
  readonly exec?: Instant;
  readonly settle?: CallSettle;
}

export interface TextMark {
  readonly at: Instant;
  readonly length: number;
}

export interface ThinkingFacts {
  readonly start: Instant;
  readonly end?: Instant;
  readonly text: string;
  readonly marks: readonly [TextMark, ...TextMark[]];
}

export type TurnFacts =
  | { readonly kind: 'live'; readonly start: Instant }
  | { readonly kind: 'ended'; readonly start: Instant; readonly end: Instant };

export type CallPhase =
  | { readonly kind: 'history' }
  | { readonly kind: 'writing'; readonly since: Instant }
  | { readonly kind: 'queued'; readonly since: Instant }
  | { readonly kind: 'executing'; readonly since: Instant }
  | { readonly kind: 'settled'; readonly settle: CallSettle };

export interface TimelineReader {
  call(id: ToolCallId): CallFacts | undefined;
  turn(): TurnFacts | undefined;
  latestThinking(now: Instant): ThinkingFacts | undefined;
  waitingSince(now: Instant): Instant | undefined;
  thoughtHeldUntil(thinking: ThinkingFacts): Instant | undefined;
}

const happened = (at: Instant | undefined, now: Instant): at is Instant => at !== undefined && at <= now;

export function phaseAt(facts: CallFacts | undefined, now: Instant): CallPhase {
  if (facts === undefined) return { kind: 'history' };
  if (facts.settle !== undefined && facts.settle.at <= now) return { kind: 'settled', settle: facts.settle };
  if (happened(facts.exec, now)) return { kind: 'executing', since: facts.exec };
  if (happened(facts.argsEnd, now)) return { kind: 'queued', since: facts.argsEnd };
  return { kind: 'writing', since: facts.start };
}

export function countedAt(facts: CallFacts | undefined, now: Instant): boolean {
  if (facts === undefined) return true;
  if (facts.settle?.kind === 'result' && facts.settle.at <= now) return true;
  return facts.exec !== undefined && facts.exec + TRANSCRIPT_GROUP_COUNT_DELAY_MS <= now;
}

export function settledAt(facts: CallFacts | undefined, now: Instant): boolean {
  return facts === undefined || happened(facts.settle?.at, now);
}

export function turnLiveAt(turn: TurnFacts | undefined, now: Instant): boolean {
  if (turn === undefined || turn.start > now) return false;
  return turn.kind === 'live' || turn.end > now;
}

export function thinkingTextAt(thinking: ThinkingFacts, now: Instant): string {
  const tick = TRANSCRIPT_TAIL_THINKING_TICK_MS;
  const firstChange = Math.ceil((thinking.start + TRANSCRIPT_TAIL_THINKING_THROTTLE_MS) / tick) * tick;
  const sample = now < firstChange ? thinking.start : Math.floor(now / tick) * tick;
  let shown = thinking.marks[0];
  for (const mark of thinking.marks) {
    if (mark.at > sample) break;
    shown = mark;
  }
  return thinking.text.slice(0, shown.length);
}

interface Interval {
  readonly from: number;
  readonly to: number;
}

function slowInterval(facts: CallFacts): Interval | undefined {
  if (facts.exec === undefined) return undefined;
  const interval = { from: facts.exec + TRANSCRIPT_TAIL_ENTER_MS, to: facts.settle?.at ?? Infinity };
  return interval.from < interval.to ? interval : undefined;
}

function preparingInterval(facts: CallFacts): Interval | undefined {
  const interval = { from: facts.start + TRANSCRIPT_TAIL_ENTER_MS, to: facts.argsEnd ?? Infinity };
  return interval.from < interval.to ? interval : undefined;
}

const contains = (interval: Interval | undefined, now: Instant): boolean =>
  interval !== undefined && interval.from <= now && now < interval.to;

export function slowAt(facts: CallFacts | undefined, now: Instant): boolean {
  return facts !== undefined && contains(slowInterval(facts), now);
}

export function preparingAt(facts: CallFacts | undefined, now: Instant): boolean {
  return facts !== undefined && contains(preparingInterval(facts), now);
}

export function slowSince(calls: readonly (CallFacts | undefined)[], now: Instant): Instant | undefined {
  const slow = calls
    .flatMap((facts) => {
      if (facts?.exec === undefined) return [];
      const interval = slowInterval(facts);
      return interval === undefined || interval.from > now ? [] : [{ ...interval, exec: facts.exec }];
    })
    .toSorted((left, right) => left.from - right.from);
  let since: Instant | undefined;
  let reach = -Infinity;
  for (const interval of slow) {
    if (interval.from > reach) since = interval.exec;
    reach = Math.max(reach, interval.to);
  }
  return now < reach ? since : undefined;
}

interface MutableCall {
  readonly start: Instant;
  name?: string;
  argsEnd?: Instant;
  exec?: Instant;
  settle?: CallSettle;
}

interface ThinkingSegment {
  readonly kind: 'thinking';
  readonly start: Instant;
  end?: Instant;
  text: string;
  readonly marks: [TextMark, ...TextMark[]];
}

interface TextSegment {
  readonly kind: 'text';
  readonly start: Instant;
  end?: Instant;
}

type Segment = ThinkingSegment | TextSegment;

type OpenOutput = Segment | { readonly kind: 'args'; readonly call: MutableCall };

export class TurnTimeline implements TimelineReader {
  private readonly calls = new Map<ToolCallId, MutableCall>();
  private turnCalls: MutableCall[] = [];
  private segments: Segment[] = [];
  private open: OpenOutput | undefined;
  private current: TurnFacts | undefined;

  constructor(private readonly clock: Clock = monotonicNow) {}

  turnStarted(): void {
    if (this.current?.kind === 'live') return;
    const at = this.clock();
    this.settleOutput(at, () => true);
    this.current = { kind: 'live', start: at };
    this.segments = [];
    this.turnCalls = [];
  }

  turnEnded(): void {
    const at = this.clock();
    this.settleOutput(at, () => true);
    if (this.current?.kind !== 'live') return;
    this.current = { kind: 'ended', start: this.current.start, end: at };
  }

  thinkingDelta(delta: string): void {
    const at = this.clock();
    if (this.open?.kind === 'thinking') {
      this.open.text += delta;
      this.open.marks.push({ at, length: this.open.text.length });
      return;
    }
    this.openOutput(at, { kind: 'thinking', start: at, text: delta, marks: [{ at, length: delta.length }] });
  }

  textDelta(): void {
    if (this.open?.kind === 'text') return;
    const at = this.clock();
    this.openOutput(at, { kind: 'text', start: at });
  }

  callDelta(id: ToolCallId, name?: string): void {
    const known = this.calls.get(id);
    if (known !== undefined) {
      known.name ??= name;
      return;
    }
    const at = this.clock();
    this.openOutput(at, { kind: 'args', call: this.register(id, { start: at, name }) });
  }

  callStarted(id: ToolCallId, name: string): void {
    const at = this.clock();
    const call = this.calls.get(id) ?? this.register(id, { start: at });
    if (call.settle !== undefined) return;
    this.closeOpen(at);
    call.name ??= name;
    call.argsEnd ??= at;
    call.exec ??= at;
  }

  callResult(id: ToolCallId): void {
    const at = this.clock();
    const call = this.calls.get(id) ?? this.register(id, { start: at });
    if (call.settle !== undefined) return;
    if (this.open?.kind === 'args' && this.open.call === call) this.closeOpen(at);
    call.argsEnd ??= at;
    call.settle = { kind: 'result', at };
  }

  approvalRequested(id: ToolCallId, name: string): void {
    const at = this.clock();
    this.closeOpen(at);
    const call = this.calls.get(id) ?? this.register(id, { start: at });
    call.name ??= name;
    call.argsEnd ??= at;
  }

  outputEnded(): void {
    this.closeOpen(this.clock());
  }

  abandonUnstarted(): void {
    this.settleOutput(this.clock(), (call) => call.exec === undefined);
  }

  reset(): void {
    this.calls.clear();
    this.turnCalls = [];
    this.segments = [];
    this.open = undefined;
    this.current = undefined;
  }

  call(id: ToolCallId): CallFacts | undefined {
    return this.calls.get(id);
  }

  turn(): TurnFacts | undefined {
    return this.current;
  }

  latestThinking(now: Instant): ThinkingFacts | undefined {
    return this.segments.findLast(
      (segment): segment is ThinkingSegment => segment.kind === 'thinking' && segment.start <= now,
    );
  }

  waitingSince(now: Instant): Instant | undefined {
    const turn = this.current;
    if (turn === undefined || !turnLiveAt(turn, now)) return undefined;
    let since = turn.start;
    for (const { start, end } of this.busy()) {
      if (start > now) continue;
      if (end === undefined || end > now) return undefined;
      if (end > since) since = end;
    }
    return since;
  }

  thoughtHeldUntil(thinking: ThinkingFacts): Instant | undefined {
    const { end } = thinking;
    if (end === undefined) return undefined;
    const index = this.segments.findIndex((segment) => segment === thinking);
    if (index < 0) return end;
    const firstTaken = (interval: Interval | undefined): number => {
      if (interval === undefined) return Infinity;
      const from = Math.max(interval.from, end);
      return from < interval.to ? from : Infinity;
    };
    const nextThought = this.segments.slice(index + 1).find((segment) => segment.kind === 'thinking');
    return instant(Math.min(
      end + TRANSCRIPT_TAIL_THOUGHT_HOLD_MS,
      nextThought?.start ?? Infinity,
      ...this.turnCalls.map((call) => firstTaken(slowInterval(call))),
      ...this.turnCalls.map((call) => firstTaken(preparingInterval(call))),
      this.firstWaitAfter(end),
    ));
  }

  private firstWaitAfter(from: Instant): number {
    let idleFrom: number = from;
    const busy = this.busy().toSorted((left, right) => left.start - right.start);
    for (const { start, end } of busy) {
      const until = end ?? Infinity;
      if (until <= idleFrom) continue;
      if (start > idleFrom + TRANSCRIPT_TAIL_ENTER_MS) break;
      idleFrom = Math.max(idleFrom, until);
    }
    return idleFrom + TRANSCRIPT_TAIL_ENTER_MS;
  }

  private busy(): readonly { readonly start: Instant; readonly end?: Instant }[] {
    return [
      ...this.segments,
      ...this.turnCalls.map((call) => ({ start: call.start, end: call.settle?.at })),
    ];
  }

  private register(id: ToolCallId, call: MutableCall): MutableCall {
    this.calls.set(id, call);
    this.turnCalls.push(call);
    return call;
  }

  private openOutput(at: Instant, output: OpenOutput): void {
    this.closeOpen(at);
    if (output.kind !== 'args') this.segments.push(output);
    this.open = output;
  }

  private closeOpen(at: Instant): void {
    const open = this.open;
    if (open === undefined) return;
    if (open.kind === 'args') open.call.argsEnd ??= at;
    else open.end ??= at;
    this.open = undefined;
  }

  private settleOutput(at: Instant, abandons: (call: MutableCall) => boolean): void {
    this.closeOpen(at);
    for (const call of this.turnCalls) {
      if (call.settle === undefined && abandons(call)) call.settle = { kind: 'abandoned', at };
    }
  }
}
