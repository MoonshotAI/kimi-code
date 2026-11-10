import type { Component } from '@moonshot-ai/pi-tui';

import { DENSITY, transcriptGroupingActive, type TranscriptPresentationOptions } from '#/tui/config';
import type { LogicalTranscriptItem, TranscriptItem } from '#/tui/utils/transcript-items';

export interface SingleProjection {
  readonly kind: 'single';
  readonly item: TranscriptItem;
}

export interface GroupProjection {
  readonly kind: 'group';
  readonly anchor: Component;
  readonly sourceIndex: number;
  readonly members: readonly [LogicalTranscriptItem, ...LogicalTranscriptItem[]];
  readonly pending: readonly LogicalTranscriptItem[];
}

export interface RowProjection {
  readonly kind: 'row';
  readonly item: LogicalTranscriptItem;
}

export type TranscriptProjection = SingleProjection | GroupProjection | RowProjection;

export type FoldRule = 'fold' | 'join' | 'pending' | 'none';

export function foldRule(item: LogicalTranscriptItem, options: TranscriptPresentationOptions): FoldRule {
  const { folding } = DENSITY[options.toolCallDensity];
  switch (item.fold.kind) {
    case 'thinking': return options.thinking === 'grouped' ? 'fold' : 'none';
    case 'explore': return folding === 'none' ? 'none' : 'fold';
    case 'all': return folding === 'all' ? 'fold' : 'none';
    case 'command':
      if (folding !== 'readonly') return folding === 'all' ? 'fold' : 'none';
      if (!item.fold.argsComplete) return 'pending';
      return item.fold.readonly ? 'join' : 'none';
    case 'unnamed': return folding === 'none' ? 'none' : 'pending';
  }
}

export function projectTranscript(
  items: readonly TranscriptItem[],
  options: TranscriptPresentationOptions,
  isOpened: (component: Component) => boolean = () => false,
  mayStillBeWritten: (item: LogicalTranscriptItem) => boolean = () => true,
): readonly TranscriptProjection[] {
  if (!transcriptGroupingActive(options)) {
    return items.map((item) => ({ kind: 'single', item }));
  }
  const { folding, unfolded } = DENSITY[options.toolCallDensity];
  const foldsUnplaced = folding === 'all';
  const projections: TranscriptProjection[] = [];
  const place = (item: TranscriptItem): TranscriptProjection =>
    unfolded === 'row' && item.kind === 'logical' && item.family === 'tool' && item.event.kind !== 'silent'
      ? { kind: 'row', item }
      : { kind: 'single', item };
  let run: LogicalTranscriptItem[] = [];
  let pending: LogicalTranscriptItem[] = [];
  const flush = (): void => {
    const [first, ...rest] = run;
    if (first !== undefined && titled(run)) {
      projections.push({
        kind: 'group',
        anchor: first.source,
        sourceIndex: first.sourceIndex,
        members: [first, ...rest],
        pending,
      });
    } else {
      for (const item of run) projections.push(place(item));
    }
    run = [];
    pending = [];
  };

  for (const item of items) {
    if (item.kind === 'transparent') continue;
    const opened = isOpened(item.display);
    const rule = item.kind === 'logical' && !opened ? foldRule(item, options) : 'none';
    if (item.kind === 'logical') {
      if (rule === 'fold' || (rule === 'join' && titled(run))) {
        run.push(item);
        continue;
      }
      if (rule === 'pending') {
        if (titled(run) && item.current && mayStillBeWritten(item)) {
          pending.push(item);
          continue;
        }
        if (foldsUnplaced) {
          run.push(item);
          continue;
        }
      }
    }
    flush();
    projections.push(opened ? { kind: 'single', item } : place(item));
  }
  flush();
  return projections;
}

function titled(run: readonly LogicalTranscriptItem[]): boolean {
  return run.some((item) => item.family === 'thinking' || item.event.kind !== 'silent');
}
