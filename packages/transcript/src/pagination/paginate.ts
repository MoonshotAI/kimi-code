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
  return segments;
}

function page(segments: readonly Segment[], pageSize: number, direction: 'older' | 'newer'): TurnPage {
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
