/**
 * Turn-granular cursor pagination over `items`.
 *
 * A page is a contiguous slice of turns plus the non-turn items (markers,
 * taskrefs) that belong to those turns' segments: an item appearing after
 * turn N and before turn N+1 travels with turn N's segment, so page
 * boundaries never orphan a marker. Head items (before the first turn) form
 * their own leading unit that ships with the oldest page.
 *
 * Cursors are turn ids. `beforeTurn` pages toward older turns, `afterTurn`
 * toward newer; with neither, the newest page is returned (tail of the
 * timeline). Tasks, meta and pending interactions are global state and are
 * NOT paginated here — the REST layer ships them alongside every page.
 */

import { compareTurnIds } from '../model/ids';
import type { TranscriptItem } from '../model/item';

export interface TurnPageQuery {
  readonly beforeTurn?: string;
  readonly afterTurn?: string;
  readonly pageSize: number;
}

export interface TurnPage {
  readonly items: readonly TranscriptItem[];
  readonly hasMore: boolean;
}

export function paginateTurns(items: readonly TranscriptItem[], query: TurnPageQuery): TurnPage {
  const pageSize = Math.max(1, query.pageSize);
  const segments = splitSegments(items);
  if (segments.length === 0) return { items: [], hasMore: false };

  if (query.afterTurn !== undefined) {
    // The leading non-turn unit is the oldest content; it only travels with
    // before-cursor (older) paging, not with after-cursor (newer) paging.
    return page(segments.filter((seg) => seg.turnId && compareTurnIds(seg.turnId, query.afterTurn!) > 0), pageSize, 'newer');
  }
  if (query.beforeTurn !== undefined) {
    const older = segments.filter((seg) => !seg.turnId || compareTurnIds(seg.turnId, query.beforeTurn!) < 0);
    return page(older, pageSize, 'older');
  }
  return page(segments, pageSize, 'older');
}

interface Segment {
  readonly items: readonly TranscriptItem[];
  /** Undefined only for the leading non-turn unit. */
  readonly turnId?: string;
}

function splitSegments(items: readonly TranscriptItem[]): Segment[] {
  const segments: Segment[] = [];
  let current: TranscriptItem[] = [];
  let currentTurn: string | undefined;
  const flush = (): void => {
    if (current.length > 0) segments.push({ items: current, turnId: currentTurn });
    current = [];
    currentTurn = undefined;
  };
  for (const item of items) {
    if (item.kind === 'turn') {
      flush();
      current = [item];
      currentTurn = item.turnId;
    } else {
      current.push(item);
    }
  }
  flush();
  // A leading non-turn unit belongs with the oldest page; if the timeline
  // starts with turns only, no such segment exists.
  return segments;
}

function page(segments: readonly Segment[], pageSize: number, direction: 'older' | 'newer'): TurnPage {
  // The leading non-turn unit is not a turn slot: pages are counted in turn
  // segments, and the unit rides along only with the page that reaches the
  // first turn (the oldest page).
  const head = segments[0]?.turnId === undefined ? segments[0] : undefined;
  const turnSegments = head !== undefined ? segments.slice(1) : segments;
  if (direction === 'older') {
    const selected = turnSegments.slice(-pageSize);
    const reachesFirstTurn = selected.length === turnSegments.length;
    const hasMore = turnSegments.length > selected.length && selected.length > 0;
    return {
      items: flatten([...(reachesFirstTurn && head !== undefined ? [head] : []), ...selected]),
      hasMore,
    };
  }
  const selected = turnSegments.slice(0, pageSize);
  const hasMore = turnSegments.length > selected.length && selected.length > 0;
  return { items: flatten(selected), hasMore };
}

function flatten(segments: readonly Segment[]): readonly TranscriptItem[] {
  return segments.flatMap((seg) => seg.items);
}
