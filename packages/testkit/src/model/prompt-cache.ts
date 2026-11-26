import { estimateTokens } from '#/model/emission';
import type { BuiltInLaneName } from '#/model/lanes';
import type { ProtocolName } from '#/model/types';

export type PromptRegion = 'params' | 'system' | 'tools' | 'messages';

export type CacheBreakPart = 'header' | 'history';

export interface PromptSegment {
  readonly region: PromptRegion;
  readonly label: string;
  readonly text: string;
}

export interface PromptPrefix {
  readonly cacheKey?: string;
  readonly model?: string;
  readonly segments: readonly PromptSegment[];
}

export interface ObservedRequest {
  readonly request: number;
  readonly lane: string;
  readonly role: BuiltInLaneName;
  readonly protocol: ProtocolName;
  readonly agent?: string;
  readonly continues?: boolean;
}

export interface CacheBreakOptions {
  readonly at?: CacheBreakPart;
}

export interface PromptCacheBreak {
  readonly index: number;
  readonly region: PromptRegion;
  readonly part: CacheBreakPart;
  readonly previous: string;
  readonly next?: string;
  readonly detail: string;
}

export interface PromptCacheEntry extends ObservedRequest {
  readonly cacheKey?: string;
  readonly model?: string;
  readonly rejected: boolean;
  readonly totalTokens: number;
  readonly reusedTokens: number;
  readonly reusedFrom?: number;
  readonly baseline?: number;
  readonly break?: PromptCacheBreak;
  readonly explanation?: string;
}

interface Observation {
  readonly source: ObservedRequest;
  readonly cacheKey?: string;
  readonly model?: string;
  readonly segments: readonly PromptSegment[];
  readonly totalTokens: number;
  readonly reusedTokens: number;
  readonly reusedFrom?: number;
  rejected: boolean;
}

interface Comparison {
  readonly observation: Observation;
  readonly baseline?: number;
  readonly break?: PromptCacheBreak;
  readonly allowance?: string;
}

interface Expectation {
  readonly reason: string;
  readonly at?: CacheBreakPart;
}

interface Explained {
  readonly comparisons: readonly Comparison[];
  readonly explanations: ReadonlyMap<number, string>;
  readonly unexplained: readonly Comparison[];
  readonly unused: readonly Expectation[];
}

const AFTER_COMPACTION = 'the history restarts after compaction';
const UNKEYED_HINT = 'Requests without a prompt cache key carry nothing that tells conversations apart, so every such request to this model counts as one conversation; give each conversation its own model if the test runs several.';
const EXCERPT_BEFORE = 24;
const EXCERPT_AFTER = 48;

export function promptSegment(region: PromptRegion, label: string, value: unknown): PromptSegment {
  return { region, label, text: JSON.stringify(value) ?? '' };
}

export function pickedFields(record: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
}

export class PromptCacheLedger {
  private readonly observations: Observation[] = [];
  private readonly expectations: Expectation[] = [];

  observe(source: ObservedRequest, prefix: PromptPrefix): void {
    const thread: Thread = { protocol: source.protocol, cacheKey: prefix.cacheKey, model: prefix.model };
    let reusedCharacters = 0;
    let reusedFrom: number | undefined;
    for (const earlier of this.observations) {
      if (earlier.rejected || !sameThread(earlier, thread)) continue;
      const shared = sharedCharacters(earlier.segments, prefix.segments);
      if (shared <= reusedCharacters) continue;
      reusedCharacters = shared;
      reusedFrom = earlier.source.request;
    }
    this.observations.push({
      source,
      cacheKey: prefix.cacheKey,
      model: prefix.model,
      segments: prefix.segments,
      totalTokens: tokensOf(prefix.segments.reduce((total, segment) => total + segment.text.length, 0)),
      reusedTokens: tokensOf(reusedCharacters),
      reusedFrom,
      rejected: false,
    });
  }

  reject(request: number): void {
    const observation = this.observations.find((candidate) => candidate.source.request === request);
    if (observation !== undefined) observation.rejected = true;
  }

  reusedTokens(request: number): number {
    return this.observations.find((observation) => observation.source.request === request)?.reusedTokens ?? 0;
  }

  expect(reason: string, options: CacheBreakOptions): void {
    this.expectations.push({ reason, at: options.at });
  }

  entries(): readonly PromptCacheEntry[] {
    const { comparisons, explanations } = this.explain();
    return comparisons.map(({ observation, baseline, break: found }) => {
      const { source, segments: _segments, ...rest } = observation;
      const entry: PromptCacheEntry = { ...source, ...rest, baseline, break: found };
      const explanation = explanations.get(source.request);
      return explanation === undefined ? entry : { ...entry, explanation };
    });
  }

  problems(): readonly string[] {
    const { unexplained, unused } = this.explain();
    return [
      ...unexplained.map(describeUnexplained),
      ...unused.map(({ reason, at }) => `expected a prompt cache break${at === undefined ? '' : ` in the ${at}`} (${reason}), but no request made one`),
    ];
  }

  private compare(): readonly Comparison[] {
    return this.observations.map((observation, position) => {
      const role = observation.source.role;
      if (role === 'side') return { observation };
      const thread = threadOf(observation);
      const pool = this.observations.slice(0, position).filter((earlier) => !earlier.rejected && sameThread(earlier, thread));
      if (role === 'subagent') {
        if (observation.source.continues !== true) return { observation };
        const own = previousStepOf(observation, pool);
        return own === undefined ? { observation } : { observation, baseline: own.source.request, break: breakBetween(own.segments, observation.segments) };
      }
      const baseline = pool.findLast((earlier) => earlier.source.role === 'main');
      if (baseline === undefined) return { observation };
      const found = breakBetween(baseline.segments, observation.segments);
      const compactedSinceBaseline = pool.some((earlier) => earlier.source.role === 'compaction' && earlier.source.request > baseline.source.request);
      const restartsAfterCompaction = observation.source.role === 'main' && found?.part === 'history' && compactedSinceBaseline;
      return { observation, baseline: baseline.source.request, break: found, allowance: restartsAfterCompaction ? AFTER_COMPACTION : undefined };
    });
  }

  private explain(): Explained {
    const comparisons = this.compare();
    const remaining = [...this.expectations];
    const explanations = new Map<number, string>();
    const unexplained: Comparison[] = [];
    for (const comparison of comparisons) {
      const found = comparison.break;
      const request = comparison.observation.source.request;
      if (found === undefined || comparison.observation.rejected) continue;
      if (comparison.allowance !== undefined) {
        explanations.set(request, comparison.allowance);
        continue;
      }
      const index = remaining.findIndex((expectation) => expectation.at === undefined || expectation.at === found.part);
      const expectation = remaining[index];
      if (expectation === undefined) {
        unexplained.push(comparison);
        continue;
      }
      explanations.set(request, expectation.reason);
      remaining.splice(index, 1);
    }
    return { comparisons, explanations, unexplained, unused: remaining };
  }
}

interface Thread {
  readonly protocol: ProtocolName;
  readonly cacheKey?: string;
  readonly model?: string;
}

function threadOf(observation: Observation): Thread {
  return { protocol: observation.source.protocol, cacheKey: observation.cacheKey, model: observation.model };
}

function sameThread(observation: Observation, thread: Thread): boolean {
  return observation.source.protocol === thread.protocol && observation.cacheKey === thread.cacheKey && observation.model === thread.model;
}

function previousStepOf(observation: Observation, pool: readonly Observation[]): Observation | undefined {
  const candidates = pool.filter((earlier) => earlier.source.role === 'subagent' && earlier.source.agent === observation.source.agent);
  const extended = candidates.findLast((earlier) => breakBetween(earlier.segments, observation.segments) === undefined);
  if (extended !== undefined) return extended;
  const history = observation.segments.filter((segment) => segment.region === 'messages');
  let best: Observation | undefined;
  let bestShared = 0;
  for (const earlier of candidates) {
    const shared = sharedSegments(earlier.segments.filter((segment) => segment.region === 'messages'), history);
    if (shared === 0 || shared < bestShared) continue;
    best = earlier;
    bestShared = shared;
  }
  return best;
}

function sharedSegments(previous: readonly PromptSegment[], next: readonly PromptSegment[]): number {
  let shared = 0;
  while (shared < previous.length && shared < next.length && sameSegment(previous[shared]!, next[shared]!)) shared += 1;
  return shared;
}

function sharedCharacters(previous: readonly PromptSegment[], next: readonly PromptSegment[]): number {
  let shared = 0;
  for (let index = 0; index < previous.length && index < next.length; index += 1) {
    if (!sameSegment(previous[index]!, next[index]!)) break;
    shared += previous[index]!.text.length;
  }
  return shared;
}

function breakBetween(previous: readonly PromptSegment[], next: readonly PromptSegment[]): PromptCacheBreak | undefined {
  const index = previous.findIndex((segment, position) => {
    const counterpart = next[position];
    return counterpart === undefined || !sameSegment(segment, counterpart);
  });
  const before = previous[index];
  if (before === undefined) return undefined;
  const after = next[index];
  return {
    index,
    region: before.region,
    part: before.region === 'messages' ? 'history' : 'header',
    previous: before.label,
    next: after?.label,
    detail: describeChange(previous, next, index),
  };
}

function sameSegment(previous: PromptSegment, next: PromptSegment): boolean {
  return previous.region === next.region && previous.text === next.text;
}

function describeChange(previous: readonly PromptSegment[], next: readonly PromptSegment[], index: number): string {
  const before = previous[index]!;
  const after = next[index];
  if (after === undefined) return `${before.label} is missing`;
  if (after.region !== before.region) {
    return countIn(next, before.region) < countIn(previous, before.region)
      ? `${before.label} is missing`
      : `${after.label} was inserted before ${before.label}`;
  }
  if (after.label !== before.label) return `${before.label} became ${after.label}`;
  let start = 0;
  while (start < before.text.length && start < after.text.length && before.text[start] === after.text[start]) start += 1;
  const from = Math.max(0, start - EXCERPT_BEFORE);
  const excerpt = (text: string): string =>
    `${from > 0 ? '…' : ''}${text.slice(from, start + EXCERPT_AFTER)}${text.length > start + EXCERPT_AFTER ? '…' : ''}`;
  return `${before.label} changed from ${excerpt(before.text)} to ${excerpt(after.text)}`;
}

function countIn(segments: readonly PromptSegment[], region: PromptRegion): number {
  return segments.filter((segment) => segment.region === region).length;
}

function describeUnexplained({ observation, baseline, break: found }: Comparison): string {
  const key = observation.cacheKey === undefined ? 'without a prompt cache key' : `under prompt cache key ${JSON.stringify(observation.cacheKey)}`;
  return [
    `request #${observation.source.request} (${observation.source.lane}) does not extend request #${baseline} ${key}: ${found?.detail}.`,
    `It reuses ${observation.reusedTokens} of ${observation.totalTokens} estimated tokens.`,
    ...(observation.cacheKey === undefined ? [UNKEYED_HINT] : []),
    'Declare an intended break with model.expectCacheBreak(reason).',
  ].join(' ');
}

function tokensOf(characters: number): number {
  return characters === 0 ? 0 : estimateTokens(characters);
}
