import type { TuiMouseEvent, TuiMouseEventResult } from '@moonshot-ai/pi-tui';

import type { SearchableList } from '#/tui/utils/searchable-list';
import { isSettlingClick } from '#/tui/utils/terminal-focus';

export interface MouseRowRegion {
  readonly start: number;
  readonly end: number;
  readonly index: number;
}

export interface MouseColRegion {
  readonly start: number;
  readonly end: number;
  readonly index: number;
}

export interface MouseActionSpan {
  readonly start: number;
  readonly end: number;
  readonly onClick: () => void;
}

export function focusOnUnfocusedMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
  if (event.type === 'press') return { handled: true };
  if (event.type === 'click') return { handled: true, focus: true };
  return undefined;
}

export function rowIndexAt(regions: readonly MouseRowRegion[], y: number): number | undefined {
  return regions.find((region) => y >= region.start && y < region.end)?.index;
}

export function colIndexAt(regions: readonly MouseColRegion[], x: number): number | undefined {
  return regions.find((region) => x >= region.start && x < region.end)?.index;
}

export function handleSelectableListMouse(input: {
  readonly event: TuiMouseEvent;
  readonly focused: boolean;
  readonly shownAt: number;
  readonly regions: readonly MouseRowRegion[];
  readonly select: (index: number) => boolean;
  readonly activate: (index: number, event: TuiMouseEvent) => void;
  readonly selectOnHover?: boolean;
}): TuiMouseEventResult | undefined {
  const { event, focused, shownAt, regions, select, activate, selectOnHover = true } = input;
  if (!focused) return focusOnUnfocusedMouse(event);
  if (event.type === 'wheel') return undefined;
  const index = rowIndexAt(regions, event.y);
  if (event.type === 'move') {
    if (!selectOnHover || index === undefined) return undefined;
    return { handled: true, render: select(index) };
  }
  if (event.button !== 'left' || index === undefined) return undefined;
  if (event.type === 'press') {
    return selectOnHover ? { handled: true, render: select(index) } : { handled: true };
  }
  if (event.type === 'click' && !isSettlingClick(shownAt)) {
    select(index);
    activate(index, event);
    return { handled: true, render: true };
  }
  return { handled: true };
}

export function handleSegmentedMouse(input: {
  readonly event: TuiMouseEvent;
  readonly focused: boolean;
  readonly shownAt: number;
  readonly row: number;
  readonly regions: readonly MouseColRegion[];
  readonly select: (index: number) => boolean;
  readonly activate?: (index: number, event: TuiMouseEvent) => void;
}): TuiMouseEventResult | undefined {
  const { event, focused, shownAt, row, regions, select, activate } = input;
  if (!focused) return focusOnUnfocusedMouse(event);
  if (event.button !== 'left' || event.y !== row) return undefined;
  const index = colIndexAt(regions, event.x);
  if (index === undefined) return undefined;
  if (event.type === 'press') return { handled: true };
  if (event.type === 'click' && !isSettlingClick(shownAt)) {
    const changed = select(index);
    if (activate !== undefined) {
      activate(index, event);
      return { handled: true, render: true };
    }
    return { handled: true, render: changed };
  }
  return { handled: true };
}

export function handleActionBarMouse(input: {
  readonly event: TuiMouseEvent;
  readonly focused: boolean;
  readonly shownAt: number;
  readonly spans: readonly MouseActionSpan[];
}): TuiMouseEventResult | undefined {
  const { event, focused, shownAt, spans } = input;
  if (!focused) return focusOnUnfocusedMouse(event);
  if (event.button !== 'left' || event.y !== 0) return undefined;
  const hit = spans.find((span) => event.x >= span.start && event.x < span.end);
  if (hit === undefined) return undefined;
  if (event.type === 'press') return { handled: true };
  if (event.type === 'click' && !isSettlingClick(shownAt)) {
    hit.onClick();
    return { handled: true, render: true };
  }
  return { handled: true };
}

export function handleSearchableListWheel<T>(
  list: SearchableList<T>,
  event: TuiMouseEvent,
): TuiMouseEventResult {
  const view = list.view();
  if (view.page.pageCount > 1 && event.wheelDelta !== undefined) {
    const before = view.selectedIndex;
    if (event.wheelDelta < 0) list.pageUp();
    else if (event.wheelDelta > 0) list.pageDown();
    return { handled: true, render: list.view().selectedIndex !== before };
  }
  return { handled: true };
}

export function handleSearchableListMouse<T>(
  list: SearchableList<T>,
  input: {
    readonly event: TuiMouseEvent;
    readonly focused: boolean;
    readonly shownAt: number;
    readonly regions: readonly MouseRowRegion[];
    readonly selectOnHover?: boolean;
    readonly activate: (item: T, event: TuiMouseEvent) => void;
  },
): TuiMouseEventResult | undefined {
  return handleSelectableListMouse({
    event: input.event,
    focused: input.focused,
    shownAt: input.shownAt,
    regions: input.regions,
    selectOnHover: input.selectOnHover,
    select: (index) => {
      const changed = list.view().selectedIndex !== index;
      list.moveTo(index);
      return changed;
    },
    activate: (index, clickEvent) => {
      const item = list.view().items[index];
      if (item !== undefined) input.activate(item, clickEvent);
    },
  });
}
