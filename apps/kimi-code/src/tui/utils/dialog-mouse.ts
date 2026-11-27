import {
  truncateToWidth,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
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
  readonly activate: (index: number) => void;
}): TuiMouseEventResult | undefined {
  const { event, focused, shownAt, regions, select, activate } = input;
  if (!focused) return focusOnUnfocusedMouse(event);
  if (event.type === 'wheel') return undefined;
  const index = rowIndexAt(regions, event.y);
  if (event.type === 'move') {
    if (index === undefined) return undefined;
    return { handled: true, render: select(index) };
  }
  if (event.button !== 'left' || index === undefined) return undefined;
  if (event.type === 'press') return { handled: true, render: select(index) };
  if (event.type === 'click' && !isSettlingClick(shownAt)) {
    select(index);
    activate(index);
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
  readonly activate: (index: number, event: TuiMouseEvent) => void;
  readonly selectOnHover?: boolean;
}): TuiMouseEventResult | undefined {
  const { event, focused, shownAt, row, regions, select, activate, selectOnHover = false } = input;
  if (!focused) return focusOnUnfocusedMouse(event);
  if (event.y !== row) return undefined;
  const index = colIndexAt(regions, event.x);
  if (event.type === 'move') {
    if (!selectOnHover || index === undefined) return undefined;
    return { handled: true, render: select(index) };
  }
  if (event.button !== 'left' || index === undefined) return undefined;
  if (event.type === 'press') return { handled: true };
  if (event.type === 'click' && !isSettlingClick(shownAt)) {
    select(index);
    activate(index, event);
    return { handled: true, render: true };
  }
  return { handled: true };
}

export function finishDialogLines(
  lines: readonly string[],
  width: number,
  focused: boolean,
): string[] {
  const rendered = lines.map((line) => truncateToWidth(line, width));
  return focused ? rendered : rendered.map((line) => currentTheme.fade(line));
}
