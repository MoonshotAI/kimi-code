import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

import { isSettlingClick } from '#/tui/utils/terminal-focus';

export interface RowRegion<T> {
  readonly start: number;
  readonly end: number;
  readonly value: T;
}

export interface ListMouseOptions<T> {
  readonly focused?: boolean;
  readonly settling?: boolean;
  readonly canActivate?: boolean;
  readonly onHover?: (value: T) => boolean;
  readonly onPress?: (value: T) => boolean;
  readonly onActivate?: (value: T, event: TuiMouseEvent) => void;
  readonly onWheel?: ((wheelDelta: number) => boolean) | 'passthrough';
}

export interface InlineSegment<T> {
  readonly text: string;
  readonly value?: T;
}

export interface InlineTarget<T> {
  readonly start: number;
  readonly end: number;
  readonly value: T;
}

export interface SpanMouseOptions<T> {
  readonly focused?: boolean;
  readonly settling?: boolean;
  readonly onHover?: (value: T) => boolean;
  readonly onPress?: (value: T) => boolean;
  readonly onActivate: (value: T, event: TuiMouseEvent) => void;
}

export interface EmbeddedRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly contentOffsetX?: number;
  readonly contentOffsetY?: number;
}

interface SpanRegion<T> {
  readonly row: number;
  readonly start: number;
  readonly end: number;
  readonly value: T;
}

interface PointerPressState<T> {
  shownAt: number;
  pressedValue: T | undefined;
  hasPress: boolean;
}

interface PointerTargetOptions<T> {
  readonly settling?: boolean;
  readonly canActivate?: boolean;
  readonly onHover?: (value: T) => boolean;
  readonly onPress?: (value: T) => boolean;
  readonly onActivate?: (value: T, event: TuiMouseEvent) => void;
}

function sameTarget<T>(a: T | undefined, b: T | undefined): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  const entriesA = Object.entries(a);
  const entriesB = Object.entries(b);
  if (entriesA.length !== entriesB.length) return false;
  const mapB = new Map(entriesB);
  return entriesA.every(([key, value]) => mapB.has(key) && Object.is(mapB.get(key), value));
}

function handlePointerTarget<T>(
  state: PointerPressState<T>,
  event: TuiMouseEvent,
  hitAt: () => T | undefined,
  options: PointerTargetOptions<T>,
): TuiMouseEventResult | undefined {
  if (event.type === 'move') {
    if (options.onHover === undefined) return undefined;
    const hit = hitAt();
    if (hit === undefined) return undefined;
    return { handled: true, render: options.onHover(hit) };
  }
  if (event.button !== 'left') return undefined;
  const hit = hitAt();
  if (event.type === 'press') {
    if (hit === undefined) {
      state.hasPress = false;
      state.pressedValue = undefined;
      return undefined;
    }
    state.pressedValue = hit;
    state.hasPress = true;
    const changed = (options.onPress ?? options.onHover)?.(hit) ?? false;
    return { handled: true, render: changed };
  }
  if (event.type === 'click') {
    const mismatched = state.hasPress && (hit === undefined || !sameTarget(state.pressedValue, hit));
    state.hasPress = false;
    state.pressedValue = undefined;
    if (mismatched) return { handled: true };
    if (hit === undefined) return undefined;
    if ((options.settling ?? true) && isSettlingClick(state.shownAt)) return { handled: true };
    if (options.canActivate === false) {
      (options.onPress ?? options.onHover)?.(hit);
      return { handled: true, render: true };
    }
    if (options.onActivate !== undefined) {
      options.onActivate(hit, event);
      return { handled: true, render: true };
    }
    (options.onPress ?? options.onHover)?.(hit);
    return { handled: true, render: true };
  }
  return undefined;
}

export function focusOnUnfocusedClick(
  focused: boolean,
  event: TuiMouseEvent,
): TuiMouseEventResult | undefined {
  if (focused) return undefined;
  if (event.type === 'press' && event.button === 'left') return { handled: true };
  if (event.type === 'click' && event.button === 'left') return { handled: true, focus: true };
  return undefined;
}

export class ListMouseTracker<T> {
  private regions: RowRegion<T>[] = [];
  private readonly pointer: PointerPressState<T> = {
    shownAt: Date.now(),
    pressedValue: undefined,
    hasPress: false,
  };

  reset(): void {
    this.regions = [];
  }

  resetSettling(): void {
    this.pointer.shownAt = Date.now();
    this.pointer.pressedValue = undefined;
    this.pointer.hasPress = false;
  }

  add(start: number, end: number, value: T): void {
    if (end <= start) return;
    this.regions.push({ start, end, value });
  }

  track(lines: readonly string[], value: T, renderItem: () => void): void {
    const start = lines.length;
    renderItem();
    this.add(start, lines.length, value);
  }

  hitAt(y: number): T | undefined {
    return this.regions.find((region) => y >= region.start && y < region.end)?.value;
  }

  rangeOf(value: T): { readonly start: number; readonly end: number } | undefined {
    const region = this.regions.find((entry) => sameTarget(entry.value, value));
    return region === undefined ? undefined : { start: region.start, end: region.end };
  }

  handle(event: TuiMouseEvent, options: ListMouseOptions<T>): TuiMouseEventResult | undefined {
    if (options.focused === false) return focusOnUnfocusedClick(false, event);
    if (event.type === 'wheel') {
      if (options.onWheel === 'passthrough') return undefined;
      if (options.onWheel === undefined) return { handled: true };
      return { handled: true, render: options.onWheel(event.wheelDelta ?? 0) };
    }
    return handlePointerTarget(this.pointer, event, () => this.hitAt(event.y), options);
  }
}

export function renderInlineSegments<T>(
  segments: readonly InlineSegment<T>[],
  maxWidth: number,
): { readonly line: string; readonly targets: readonly InlineTarget<T>[] } {
  const limit = Math.max(0, Math.floor(maxWidth));
  const rawTargets: InlineTarget<T>[] = [];
  let raw = '';
  let col = 0;
  for (const segment of segments) {
    const segWidth = visibleWidth(segment.text);
    const start = col;
    const end = col + segWidth;
    if (segment.value !== undefined && end > start) {
      rawTargets.push({ start, end, value: segment.value });
    }
    raw += segment.text;
    col = end;
  }
  const truncated = col > limit;
  const visibleLimit = truncated ? Math.max(0, limit - 3) : limit;
  const targets: InlineTarget<T>[] = [];
  for (const target of rawTargets) {
    const clippedEnd = Math.min(visibleLimit, target.end);
    if (clippedEnd > target.start) {
      targets.push({ start: target.start, end: clippedEnd, value: target.value });
    }
  }
  return {
    line: limit === 0 ? '' : truncated ? truncateToWidth(raw, limit) : raw,
    targets,
  };
}

export class SpanHitMap<T> {
  private spans: SpanRegion<T>[] = [];
  private readonly pointer: PointerPressState<T> = {
    shownAt: Date.now(),
    pressedValue: undefined,
    hasPress: false,
  };

  reset(): void {
    this.spans = [];
  }

  resetSettling(): void {
    this.pointer.shownAt = Date.now();
    this.pointer.pressedValue = undefined;
    this.pointer.hasPress = false;
  }

  add(row: number, start: number, end: number, value: T): void {
    if (end <= start) return;
    this.spans.push({ row, start, end, value });
  }

  addRow(row: number, targets: readonly InlineTarget<T>[]): void {
    for (const target of targets) {
      this.add(row, target.start, target.end, target.value);
    }
  }

  hitAt(x: number, y: number): T | undefined {
    return this.spans.find((span) => span.row === y && x >= span.start && x < span.end)?.value;
  }

  handle(event: TuiMouseEvent, options: SpanMouseOptions<T>): TuiMouseEventResult | undefined {
    if (options.focused === false) return focusOnUnfocusedClick(false, event);
    if (event.type === 'wheel') return undefined;
    return handlePointerTarget(this.pointer, event, () => this.hitAt(event.x, event.y), options);
  }
}

export function isPointInRect(rect: EmbeddedRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

export function forwardEmbeddedMouse(
  target: Component,
  rect: EmbeddedRect | undefined,
  event: TuiMouseEvent,
): TuiMouseEventResult | undefined {
  if (rect === undefined || !isPointInRect(rect, event.x, event.y)) return undefined;
  const offsetX = rect.contentOffsetX ?? 0;
  const offsetY = rect.contentOffsetY ?? 0;
  const result = target.handleMouse?.({
    ...event,
    x: event.x - rect.x + offsetX,
    y: event.y - rect.y + offsetY,
    width: rect.width + offsetX,
    height: rect.height + offsetY,
  });
  if (result === undefined) return undefined;
  const plain: TuiMouseEventResult = {};
  if (result.handled !== undefined) plain.handled = result.handled;
  if (result.capture !== undefined) plain.capture = result.capture;
  if (result.focus !== undefined) plain.focus = result.focus;
  if (result.render !== undefined) plain.render = result.render;
  return plain;
}
