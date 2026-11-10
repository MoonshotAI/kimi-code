import { sliceByColumn, visibleWidth } from '@moonshot-ai/pi-tui';

import {
  TRANSCRIPT_GROUP_TAIL_ELAPSED_MS,
  TRANSCRIPT_TAIL_ENTER_MS,
  TRANSCRIPT_TAIL_MIN_NAME_COLUMNS,
  TRANSCRIPT_TAIL_TIMER_COLUMNS,
  TRUNCATION_ELLIPSIS,
} from '#/tui/constant/rendering';
import { decodeMcpToolName } from '#/tui/utils/mcp-tool-name';
import {
  formatDuration,
  type ItemStatus,
  type LogicalTranscriptItem,
  type SummaryEvent,
} from '#/tui/utils/transcript-items';
import {
  countedAt,
  phaseAt,
  preparingAt,
  settledAt,
  slowAt,
  slowSince,
  thinkingTextAt,
  turnLiveAt,
  type CallFacts,
  type Instant,
  type TimelineReader,
} from '#/tui/utils/turn-timeline';

type NonEmpty<T> = readonly [T, ...T[]];

export interface GroupViewInput {
  readonly members: NonEmpty<LogicalTranscriptItem>;
  readonly pending: readonly LogicalTranscriptItem[];
  readonly last: boolean;
  readonly expanded?: boolean;
  readonly timeline: TimelineReader;
}

export type RowStatus =
  | { readonly kind: 'running'; readonly since?: Instant }
  | Exclude<ItemStatus, { readonly kind: 'running' }>;

export type GroupTitleView =
  | {
      readonly kind: 'summary';
      readonly text: string;
      readonly added: number;
      readonly removed: number;
      readonly failed: number;
      readonly interrupted: number;
    }
  | { readonly kind: 'item'; readonly item: LogicalTranscriptItem; readonly status: RowStatus };

export interface RunningKind {
  readonly verb: string;
  readonly names: NonEmpty<string>;
}

export type TailView =
  | { readonly kind: 'blank' }
  | { readonly kind: 'running'; readonly kinds: NonEmpty<RunningKind>; readonly since: Instant }
  | { readonly kind: 'thinking'; readonly text: string }
  | { readonly kind: 'preparing'; readonly tool: string | undefined; readonly since: Instant }
  | { readonly kind: 'waiting'; readonly since: Instant }
  | { readonly kind: 'thought'; readonly text: string };

export interface GroupView {
  readonly title: GroupTitleView;
  readonly tail: TailView | undefined;
  readonly working: boolean;
  readonly live: boolean;
}

interface ToolKind {
  readonly events: readonly SummaryEvent['kind'][];
  readonly present: string;
  readonly past: string;
  readonly noun?: readonly [singular: string, plural: string];
  readonly countsPaths?: true;
  readonly category: string;
  readonly names: 'subject' | 'row';
}

const OTHER_TOOLS: ToolKind = {
  events: ['query', 'other'],
  present: 'using',
  past: 'used',
  noun: ['tool', 'tools'],
  category: 'using tools',
  names: 'row',
};

export const TOOL_KINDS: readonly ToolKind[] = [
  { events: ['read'], present: 'reading', past: 'read', noun: ['file', 'files'], countsPaths: true, category: 'reading files', names: 'subject' },
  { events: ['search'], present: 'searching', past: 'searched', noun: ['pattern', 'patterns'], category: 'searching patterns', names: 'subject' },
  { events: ['fetch'], present: 'fetching', past: 'fetched', noun: ['page', 'pages'], category: 'fetching pages', names: 'subject' },
  { events: ['webSearch'], present: 'running', past: 'ran', noun: ['web search', 'web searches'], category: 'running web searches', names: 'subject' },
  { events: ['skill'], present: 'loading', past: 'loaded', noun: ['skill', 'skills'], category: 'loading skills', names: 'subject' },
  { events: ['todo'], present: 'updating todos', past: 'updated todos', category: 'updating todos', names: 'subject' },
  { events: ['command'], present: 'running', past: 'ran', noun: ['command', 'commands'], category: 'running commands', names: 'subject' },
  { events: ['edit'], present: 'editing', past: 'edited', noun: ['file', 'files'], countsPaths: true, category: 'editing files', names: 'subject' },
  { events: ['taskCheck'], present: 'checking', past: 'checked', noun: ['task', 'tasks'], category: 'checking tasks', names: 'subject' },
  { events: ['mcp'], present: 'calling', past: 'called', noun: ['time', 'times'], category: 'calling', names: 'subject' },
  OTHER_TOOLS,
];

const BLANK: TailView = { kind: 'blank' };
const UNKNOWN_TOOL = 'a tool call';

interface MemberState {
  readonly item: LogicalTranscriptItem;
  readonly facts: CallFacts | undefined;
  readonly status: RowStatus;
}

interface Bucket {
  readonly kind: ToolKind;
  readonly server: string | undefined;
  readonly members: [MemberState, ...MemberState[]];
}

export function deriveGroupView(input: GroupViewInput, now: Instant): GroupView {
  const { timeline } = input;
  const [first, ...rest] = input.members;
  const state = (item: LogicalTranscriptItem): MemberState => memberState(item, timeline, now);
  const members: NonEmpty<MemberState> = [state(first), ...rest.map(state)];
  const title = deriveTitle(members, now);
  const owned = input.last && ownsLiveTurn(input, members, now);
  let tail = input.last ? BLANK : undefined;
  if (owned) tail = deriveTail(input, members, now);
  else if (input.last) tail = reviewTail(input, members, now) ?? BLANK;
  if (tail !== undefined && tailBody(tail) === titleText(title)) tail = BLANK;
  const working = owned || members.some((member) => phaseAt(member.facts, now).kind === 'executing');
  const calls = [...members.map((member) => member.facts), ...input.pending.map((item) => factsOf(item, timeline))];
  return {
    title,
    tail,
    working,
    live: working || calls.some((facts) => facts !== undefined && !settledAt(facts, now)),
  };
}

export function rowStatusOf(item: LogicalTranscriptItem, timeline: TimelineReader, now: Instant): RowStatus {
  if (item.status.kind !== 'running') return item.status;
  if (item.callId === undefined) {
    const thinking = item.family === 'thinking' ? timeline.latestThinking(now) : undefined;
    return { kind: 'running', since: thinking?.end === undefined ? thinking?.start : undefined };
  }
  const facts = timeline.call(item.callId);
  if (facts === undefined) return { kind: 'done' };
  const { settle } = facts;
  if (settle === undefined || settle.at > now) return { kind: 'running', since: facts.start };
  return settle.kind === 'result' ? { kind: 'done' } : { kind: 'interrupted' };
}

export function titleText(title: GroupTitleView): string {
  return title.kind === 'summary' ? title.text : itemText(title.item);
}

export function tailText(tail: TailView, columns: number, now: Instant): string {
  let text: string;
  switch (tail.kind) {
    case 'blank': return '';
    case 'thinking':
    case 'thought':
      text = clip(tail.text, columns);
      break;
    case 'running':
      text = timed((room) => fitRunningTail(tail.kinds, room), tail.since, columns, now);
      break;
    case 'preparing':
    case 'waiting':
      text = timed((room) => clip(tailBody(tail), room), tail.since, columns, now);
      break;
  }
  return clip(text, columns);
}

export function fitRunningTail(kinds: NonEmpty<RunningKind>, room: number): string {
  const most = Math.max(...kinds.map((kind) => kind.names.length));
  for (let perKind = most; perKind >= 1; perKind--) {
    const text = runningBody(kinds, perKind, Infinity);
    if (visibleWidth(text) <= room) return text;
  }
  const longest = Math.max(...kinds.map((kind) => visibleWidth(kind.names[0])));
  for (let nameWidth = Math.min(longest - 1, room); nameWidth >= TRANSCRIPT_TAIL_MIN_NAME_COLUMNS; nameWidth--) {
    const text = runningBody(kinds, 1, nameWidth);
    if (visibleWidth(text) <= room) return text;
  }
  return clip(runningBody(kinds, 1, TRANSCRIPT_TAIL_MIN_NAME_COLUMNS), room);
}

export function elapsedText(since: Instant, now: Instant): string {
  const elapsed = now - since;
  return elapsed >= TRANSCRIPT_GROUP_TAIL_ELAPSED_MS ? ` · ${formatDuration(elapsed)}` : '';
}

export function itemText(item: LogicalTranscriptItem): string {
  const { verb, subject } = item.label;
  return subject === undefined ? verb : `${verb} ${oneLine(subject)}`;
}

export function oneLine(subject: string): string {
  const newline = subject.indexOf('\n');
  return newline < 0 ? subject : `${subject.slice(0, newline)}${TRUNCATION_ELLIPSIS}`;
}

function memberState(item: LogicalTranscriptItem, timeline: TimelineReader, now: Instant): MemberState {
  return { item, facts: factsOf(item, timeline), status: rowStatusOf(item, timeline, now) };
}

function factsOf(item: LogicalTranscriptItem, timeline: TimelineReader): CallFacts | undefined {
  return item.callId === undefined ? undefined : timeline.call(item.callId);
}

function deriveTitle(members: NonEmpty<MemberState>, now: Instant): GroupTitleView {
  const [first, ...rest] = members;
  if (rest.length === 0 && first.status.kind !== 'running') {
    return { kind: 'item', item: first.item, status: first.status };
  }
  const fragments: string[] = [];
  const thoughts = members.filter((member) => member.item.event.kind === 'thought');
  if (thoughts.length > 0) fragments.push(thoughtFragment(thoughts));
  const counted = members.filter((member) => member.item.event.kind !== 'thought' && countedAt(member.facts, now));
  for (const bucket of bucketsOf(counted)) fragments.push(countFragment(bucket));
  let added = 0;
  let removed = 0;
  for (const { item, status } of counted) {
    if (item.event.kind !== 'edit' || status.kind === 'failed' || status.kind === 'interrupted') continue;
    added += item.event.added;
    removed += item.event.removed;
  }
  return {
    kind: 'summary',
    text: capitalize(fragments.length > 0 ? fragments.join(', ') : categoryOf(members)),
    added,
    removed,
    failed: counted.filter((member) => member.status.kind === 'failed').length,
    interrupted: counted.filter((member) => member.status.kind === 'interrupted').length,
  };
}

function thoughtFragment(thoughts: readonly MemberState[]): string {
  if (thoughts.some((member) => member.status.kind === 'running')) return 'thinking';
  let totalMs = 0;
  for (const { item } of thoughts) {
    if (item.event.kind !== 'thought' || item.event.durationMs === undefined) return 'thought';
    totalMs += item.event.durationMs;
  }
  return `thought for ${formatDuration(totalMs)}`;
}

function countFragment(bucket: Bucket): string {
  const { kind, members } = bucket;
  const present = members.some((member) => member.status.kind === 'running');
  const verb = withServer(present ? kind.present : kind.past, bucket.server);
  if (kind.noun === undefined) return verb;
  const count = kind.countsPaths === true
    ? new Set(members.map((member) => pathOf(member.item.event))).size
    : members.length;
  return `${verb} ${String(count)} ${count === 1 ? kind.noun[0] : kind.noun[1]}`;
}

function categoryOf(members: NonEmpty<MemberState>): string {
  for (const { item } of members) {
    const kind = kindOf(item.event);
    if (kind !== undefined) return withServer(kind.category, serverOf(item.event));
  }
  return OTHER_TOOLS.category;
}

function bucketsOf(members: readonly MemberState[]): readonly Bucket[] {
  const buckets: Bucket[] = [];
  for (const member of members) {
    const kind = kindOf(member.item.event);
    if (kind === undefined) continue;
    const server = serverOf(member.item.event);
    const bucket = buckets.find((candidate) => candidate.kind === kind && candidate.server === server);
    if (bucket === undefined) buckets.push({ kind, server, members: [member] });
    else bucket.members.push(member);
  }
  return buckets.toSorted((left, right) => TOOL_KINDS.indexOf(left.kind) - TOOL_KINDS.indexOf(right.kind));
}

function ownsLiveTurn(input: GroupViewInput, members: readonly MemberState[], now: Instant): boolean {
  const { timeline } = input;
  const turn = timeline.turn();
  if (turn === undefined || !turnLiveAt(turn, now)) return false;
  const calls = [...members.map((member) => member.facts), ...input.pending.map((item) => factsOf(item, timeline))];
  if (calls.some((facts) => facts !== undefined && facts.start >= turn.start)) return true;
  return hasThinking(members) && timeline.latestThinking(now) !== undefined;
}

function reviewTail(input: GroupViewInput, members: readonly MemberState[], now: Instant): TailView | undefined {
  if (input.expanded === true && members.some((member) => member.item.autoReviewing === true)) return undefined;
  const items = reviewingItems(input, members);
  const kind = reviewingKind(items);
  if (kind === undefined) return undefined;
  return { kind: 'running', kinds: [kind], since: reviewingSince(items, input.timeline, now) };
}

function reviewingItems(input: GroupViewInput, members: readonly MemberState[]): LogicalTranscriptItem[] {
  const seen = new Set<string>();
  const items: LogicalTranscriptItem[] = [];
  for (const item of [...members.map((member) => member.item), ...input.pending]) {
    if (item.autoReviewing !== true) continue;
    const key = item.callId ?? `${item.label.rowVerb}\0${item.label.subject ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
}

function reviewingKind(items: readonly LogicalTranscriptItem[]): RunningKind | undefined {
  const names = items.map(reviewName);
  const [first, ...rest] = names;
  if (first === undefined) return undefined;
  return { verb: 'reviewing', names: [first, ...rest] };
}

function reviewName(item: LogicalTranscriptItem): string {
  const kind = kindOf(item.event);
  return kind === undefined ? item.label.subject ?? item.label.rowVerb : nameOf(kind, item);
}

function reviewingSince(items: readonly LogicalTranscriptItem[], timeline: TimelineReader, now: Instant): Instant {
  let since = now;
  for (const item of items) {
    const start = item.callId === undefined ? undefined : timeline.call(item.callId)?.start;
    if (start !== undefined && start < since) since = start;
  }
  return since;
}

function deriveTail(input: GroupViewInput, members: readonly MemberState[], now: Instant): TailView {
  const { timeline } = input;
  const review = reviewTail(input, members, now);
  const slowMembers = members.filter((member) => member.item.autoReviewing !== true && slowAt(member.facts, now));
  const [firstSlow, ...otherSlow] = bucketsOf(slowMembers);
  const slowKinds = firstSlow === undefined ? [] : [runningKind(firstSlow), ...otherSlow.map(runningKind)];
  const kinds = [...(review?.kind === 'running' ? review.kinds : []), ...slowKinds];
  const [first, ...rest] = kinds;
  if (first !== undefined) {
    return {
      kind: 'running',
      kinds: [first, ...rest],
      since: review?.kind === 'running' ? review.since : slowSince(slowMembers.map((member) => member.facts), now) ?? now,
    };
  }
  const thinking = hasThinking(members) ? timeline.latestThinking(now) : undefined;
  if (thinking !== undefined && (thinking.end === undefined || thinking.end > now)) {
    return { kind: 'thinking', text: latestParagraph(thinkingTextAt(thinking, now)) };
  }
  const preparing = [...members.map((member) => member.facts), ...input.pending.map((item) => factsOf(item, timeline))]
    .find((facts) => preparingAt(facts, now));
  if (preparing !== undefined) return { kind: 'preparing', tool: shownToolName(preparing.name), since: preparing.start };
  const waiting = timeline.waitingSince(now);
  if (waiting !== undefined && waiting + TRANSCRIPT_TAIL_ENTER_MS <= now) return { kind: 'waiting', since: waiting };
  if (thinking !== undefined) {
    const heldUntil = timeline.thoughtHeldUntil(thinking);
    if (heldUntil !== undefined && now < heldUntil) {
      return { kind: 'thought', text: latestParagraph(thinkingTextAt(thinking, now)) };
    }
  }
  return BLANK;
}

function tailBody(tail: TailView): string {
  switch (tail.kind) {
    case 'blank': return '';
    case 'running': return runningBody(tail.kinds, Infinity, Infinity);
    case 'thinking':
    case 'thought': return tail.text;
    case 'preparing': return `Preparing ${tail.tool ?? UNKNOWN_TOOL}`;
    case 'waiting': return 'Waiting for response';
  }
}

function runningKind(bucket: Bucket): RunningKind {
  const [first, ...rest] = bucket.members;
  const name = (member: MemberState): string => nameOf(bucket.kind, member.item);
  return { verb: withServer(bucket.kind.present, bucket.server), names: [name(first), ...rest.map(name)] };
}

function runningBody(kinds: NonEmpty<RunningKind>, perKind: number, nameWidth: number): string {
  return capitalize(kinds.map((kind) => {
    const shown = kind.names.slice(0, perKind).map((name) => clip(name, nameWidth));
    const hidden = kind.names.length - shown.length;
    return `${kind.verb} ${shown.join(', ')}${hidden > 0 ? ` +${String(hidden)} more` : ''}`;
  }).join('; '));
}

function timed(body: (room: number) => string, since: Instant, columns: number, now: Instant): string {
  const timer = elapsedText(since, now);
  return `${body(columns - Math.max(TRANSCRIPT_TAIL_TIMER_COLUMNS, visibleWidth(timer)))}${timer}`;
}

function clip(text: string, columns: number): string {
  if (visibleWidth(text) <= columns) return text;
  if (columns <= 0) return '';
  return `${sliceByColumn(text, 0, columns - 1, true).trimEnd()}${TRUNCATION_ELLIPSIS}`;
}

function nameOf(kind: ToolKind, item: LogicalTranscriptItem): string {
  const { rowVerb, subject } = item.label;
  if (subject === undefined) return rowVerb;
  return kind.names === 'row' ? `${rowVerb} ${oneLine(subject)}` : oneLine(subject);
}

function shownToolName(name: string | undefined): string | undefined {
  if (name === undefined || name.length === 0) return undefined;
  return decodeMcpToolName(name)?.toolName ?? name;
}

function latestParagraph(text: string): string {
  const paragraph = text
    .split(/\n\s*\n/)
    .map((part) => part.replaceAll(/\s+/g, ' ').trim())
    .findLast((part) => part.length > 0);
  return paragraph ?? 'Thinking';
}

function hasThinking(members: readonly MemberState[]): boolean {
  return members.some((member) => member.item.family === 'thinking');
}

function kindOf(event: SummaryEvent): ToolKind | undefined {
  return TOOL_KINDS.find((kind) => kind.events.includes(event.kind));
}

function serverOf(event: SummaryEvent): string | undefined {
  return event.kind === 'mcp' ? event.server : undefined;
}

function pathOf(event: SummaryEvent): string | undefined {
  return event.kind === 'read' || event.kind === 'edit' ? event.path : undefined;
}

function withServer(text: string, server: string | undefined): string {
  return server === undefined ? text : `${text} ${server}`;
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
