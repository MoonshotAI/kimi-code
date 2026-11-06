import type { Component } from '@moonshot-ai/pi-tui';

import { transcriptGroupingActive, type TranscriptPresentationOptions } from '#/tui/config';
import { combineOutcomes, formatDuration } from '#/tui/utils/transcript-items';
import type {
  LogicalTranscriptItem,
  SummaryEvent,
  TranscriptItem,
} from '#/tui/utils/transcript-items';

export interface SingleProjection {
  readonly kind: 'single';
  readonly item: TranscriptItem;
}

export interface GroupProjection {
  readonly kind: 'group';
  readonly anchor: Component;
  readonly sourceIndex: number;
  readonly members: readonly [LogicalTranscriptItem, ...LogicalTranscriptItem[]];
  readonly external: readonly LogicalTranscriptItem[];
  readonly running: boolean;
}

export type TranscriptProjection = SingleProjection | GroupProjection;

export function projectTranscript(
  items: readonly TranscriptItem[],
  options: TranscriptPresentationOptions,
  isOpened: (component: Component) => boolean = () => false,
): readonly TranscriptProjection[] {
  if (!transcriptGroupingActive(options)) {
    return items.map((item) => ({ kind: 'single', item }));
  }
  const projections: TranscriptProjection[] = [];
  let run: LogicalTranscriptItem[] = [];
  const flush = (): void => {
    const first = run[0];
    if (first === undefined) return;
    const external = run.filter((item) => item.current && item.family === 'thinking');
    const externalSet = new Set(external);
    const members = run.filter((item) => !externalSet.has(item));
    const hasSummaryFragment = members.some(
      (item) => item.family === 'thinking' || item.event.kind !== 'silent',
    );
    if (members.length > 0 && hasSummaryFragment) {
      projections.push({
        kind: 'group',
        anchor: first.source,
        sourceIndex: first.sourceIndex,
        members: members as [LogicalTranscriptItem, ...LogicalTranscriptItem[]],
        external,
        running: members.some((member) => member.current),
      });
    } else {
      for (const item of run) projections.push({ kind: 'single', item });
    }
    run = [];
  };

  for (const item of items) {
    if (item.kind === 'transparent') continue;
    if (item.kind === 'logical' && canFoldItem(item, options) && !isOpened(item.display)) {
      run.push(item);
      continue;
    }
    flush();
    projections.push({ kind: 'single', item });
  }
  flush();
  return projections;
}

export function canFoldItem(
  item: LogicalTranscriptItem,
  options: TranscriptPresentationOptions,
): boolean {
  if (item.foldClass === 'thinking') return options.groupThinking;
  if (item.foldClass === 'explore') return options.groupTools !== 'off';
  return options.groupTools === 'auto';
}

export interface GroupSummary {
  readonly fragments: readonly string[];
  readonly added: number;
  readonly removed: number;
  readonly failed: number;
  readonly interrupted: number;
  readonly allFailed: boolean;
}

export function summarizeGroup(
  members: readonly [LogicalTranscriptItem, ...LogicalTranscriptItem[]],
): GroupSummary {
  const events = members.map((member) => member.event);
  const running = new Set(members.filter((member) => member.current).map((member) => member.event.kind));
  const verb = (kind: SummaryEvent['kind'], past: string, present: string): string =>
    running.has(kind) ? present : past;
  const fragments: string[] = [];
  const thought = events.filter((event) => event.kind === 'thought');
  if (thought.length > 0) fragments.push(formatThought(thought, running.has('thought')));
  const readPaths = new Set(events.filter((event) => event.kind === 'read').map((event) => event.path));
  if (readPaths.size > 0) fragments.push(`${verb('read', 'read', 'reading')} ${countLabel(readPaths.size, 'file')}`);
  const searches = events.filter((event) => event.kind === 'search').length;
  if (searches > 0) fragments.push(`${verb('search', 'searched', 'searching')} ${countLabel(searches, 'pattern')}`);
  const fetches = events.filter((event) => event.kind === 'fetch').length;
  if (fetches > 0) fragments.push(`${verb('fetch', 'fetched', 'fetching')} ${countLabel(fetches, 'page')}`);
  const webSearches = events.filter((event) => event.kind === 'webSearch').length;
  if (webSearches > 0) fragments.push(`${verb('webSearch', 'ran', 'running')} ${countLabel(webSearches, 'web search', 'web searches')}`);
  const skills = events.filter((event) => event.kind === 'skill').length;
  if (skills > 0) fragments.push(`${verb('skill', 'loaded', 'loading')} ${countLabel(skills, 'skill')}`);
  if (events.some((event) => event.kind === 'todo')) fragments.push(verb('todo', 'updated todos', 'updating todos'));
  const commands = events.filter((event) => event.kind === 'command').length;
  if (commands > 0) fragments.push(`${verb('command', 'ran', 'running')} ${countLabel(commands, 'command')}`);
  const edits = events.filter((event) => event.kind === 'edit');
  const editPaths = new Set(edits.map((event) => event.path));
  if (editPaths.size > 0) fragments.push(`${verb('edit', 'edited', 'editing')} ${countLabel(editPaths.size, 'file')}`);
  const taskChecks = events.filter((event) => event.kind === 'taskCheck').length;
  if (taskChecks > 0) fragments.push(`${verb('taskCheck', 'checked', 'checking')} ${countLabel(taskChecks, 'task')}`);
  const mcpServers = new Map<string, number>();
  for (const event of events) {
    if (event.kind === 'mcp') mcpServers.set(event.server, (mcpServers.get(event.server) ?? 0) + 1);
  }
  for (const [server, count] of mcpServers) {
    fragments.push(`${verb('mcp', 'called', 'calling')} ${server} ${countLabel(count, 'time')}`);
  }
  const otherTools = events.filter((event) => event.kind === 'query' || event.kind === 'other').length;
  if (otherTools > 0) {
    const present = running.has('query') || running.has('other');
    fragments.push(`${present ? 'using' : 'used'} ${countLabel(otherTools, 'tool')}`);
  }
  if (fragments.length > 0) {
    const first = fragments[0];
    if (first !== undefined) fragments[0] = first.charAt(0).toUpperCase() + first.slice(1);
  }
  const landedEdits = edits.filter((event) => event.outcome.failed === 0 && event.outcome.interrupted === 0);
  const outcomes = events.flatMap((event) => 'outcome' in event ? [event.outcome] : []);
  const outcome = combineOutcomes(outcomes);
  return {
    fragments,
    added: landedEdits.reduce((total, event) => total + event.added, 0),
    removed: landedEdits.reduce((total, event) => total + event.removed, 0),
    failed: outcome.failed,
    interrupted: outcome.interrupted,
    allFailed: outcome.calls > 0 && outcome.failed === outcome.calls,
  };
}

function formatThought(
  events: readonly Extract<SummaryEvent, { kind: 'thought' }>[],
  running: boolean,
): string {
  if (running) return 'thinking';
  if (events.some((event) => event.durationMs === undefined)) return 'thought';
  const totalMs = events.reduce((total, event) => total + (event.durationMs ?? 0), 0);
  return `thought for ${formatDuration(totalMs)}`;
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}
