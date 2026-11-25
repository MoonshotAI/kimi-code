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
  readonly entry: Omit<PromptCacheEntry, 'explanation' | 'rejected'>;
  readonly allowance?: string;
  readonly segments: readonly PromptSegment[];
  rejected: boolean;
}

interface Expectation {
  readonly reason: string;
  readonly at?: CacheBreakPart;
}

interface Explained {
  readonly explanations: ReadonlyMap<number, string>;
  readonly unexplained: readonly Observation[];
  readonly unused: readonly Expectation[];
}

const CHECKED_ROLES: ReadonlySet<BuiltInLaneName> = new Set(['main', 'compaction']);
const AFTER_COMPACTION = 'the history restarts after compaction';
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
    const { role } = source;
    const pool = this.observations.filter(
      ({ rejected, entry }) =>
        !rejected && entry.protocol === source.protocol && entry.cacheKey === prefix.cacheKey && entry.model === prefix.model,
    );
    let reusedCharacters = 0;
    let reusedFrom: number | undefined;
    for (const earlier of pool) {
      const shared = sharedCharacters(earlier.segments, prefix.segments);
      if (shared <= reusedCharacters) continue;
      reusedCharacters = shared;
      reusedFrom = earlier.entry.request;
    }
    const baseline = CHECKED_ROLES.has(role) ? pool.findLast((observation) => observation.entry.role === 'main') : undefined;
    const found = baseline === undefined ? undefined : breakBetween(baseline.segments, prefix.segments);
    const compactedSinceBaseline =
      baseline !== undefined && pool.some((observation) => observation.entry.role === 'compaction' && observation.entry.request > baseline.entry.request);
    this.observations.push({
      entry: {
        ...source,
        cacheKey: prefix.cacheKey,
        model: prefix.model,
        totalTokens: tokensOf(prefix.segments.reduce((total, segment) => total + segment.text.length, 0)),
        reusedTokens: tokensOf(reusedCharacters),
        reusedFrom,
        baseline: baseline?.entry.request,
        break: found,
      },
      allowance: role === 'main' && found?.part === 'history' && compactedSinceBaseline ? AFTER_COMPACTION : undefined,
      segments: prefix.segments,
      rejected: false,
    });
  }

  reject(request: number): void {
    const observation = this.observations.find((candidate) => candidate.entry.request === request);
    if (observation !== undefined) observation.rejected = true;
  }

  reusedTokens(request: number): number {
    return this.observations.find((observation) => observation.entry.request === request)?.entry.reusedTokens ?? 0;
  }

  expect(reason: string, options: CacheBreakOptions): void {
    this.expectations.push({ reason, at: options.at });
  }

  entries(): readonly PromptCacheEntry[] {
    const { explanations } = this.explain();
    return this.observations.map(({ entry, rejected }) => {
      const explanation = explanations.get(entry.request);
      return explanation === undefined ? { ...entry, rejected } : { ...entry, rejected, explanation };
    });
  }

  problems(): readonly string[] {
    const { unexplained, unused } = this.explain();
    return [
      ...unexplained.map(({ entry }) => describeUnexplained(entry)),
      ...unused.map(({ reason, at }) => `expected a prompt cache break${at === undefined ? '' : ` in the ${at}`} (${reason}), but no request made one`),
    ];
  }

  private explain(): Explained {
    const remaining = [...this.expectations];
    const explanations = new Map<number, string>();
    const unexplained: Observation[] = [];
    for (const observation of this.observations) {
      const found = observation.entry.break;
      if (found === undefined || observation.rejected) continue;
      if (observation.allowance !== undefined) {
        explanations.set(observation.entry.request, observation.allowance);
        continue;
      }
      const index = remaining.findIndex((expectation) => expectation.at === undefined || expectation.at === found.part);
      const expectation = remaining[index];
      if (expectation === undefined) {
        unexplained.push(observation);
        continue;
      }
      explanations.set(observation.entry.request, expectation.reason);
      remaining.splice(index, 1);
    }
    return { explanations, unexplained, unused: remaining };
  }
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

function describeUnexplained(entry: Observation['entry']): string {
  const key = entry.cacheKey === undefined ? 'without a prompt cache key' : `under prompt cache key ${JSON.stringify(entry.cacheKey)}`;
  return [
    `request #${entry.request} (${entry.lane}) does not extend request #${entry.baseline} ${key}: ${entry.break?.detail}.`,
    `It reuses ${entry.reusedTokens} of ${entry.totalTokens} estimated tokens.`,
    'Declare an intended break with model.expectCacheBreak(reason).',
  ].join(' ');
}

function tokensOf(characters: number): number {
  return characters === 0 ? 0 : estimateTokens(characters);
}
