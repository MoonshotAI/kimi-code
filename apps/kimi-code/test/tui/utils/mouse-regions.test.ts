import { stripVTControlCharacters } from 'node:util';

import {
  visibleWidth,
  type Component,
  type TuiMouseDispatchResult,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { darkColors } from '#/tui/theme/colors';
import {
  focusOnUnfocusedClick,
  forwardEmbeddedMouse,
  isPointInRect,
  ListMouseTracker,
  renderInlineSegments,
  SpanHitMap,
  type EmbeddedRect,
} from '#/tui/utils/mouse-regions';

function mouse(
  type: TuiMouseEvent['type'],
  overrides: Partial<TuiMouseEvent> = {},
): TuiMouseEvent {
  const defaultButton = type === 'move' || type === 'wheel' ? 'none' : 'left';
  return {
    type,
    button: overrides.button ?? defaultButton,
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    screenX: overrides.screenX ?? overrides.x ?? 0,
    screenY: overrides.screenY ?? overrides.y ?? 0,
    width: overrides.width ?? 80,
    height: overrides.height ?? 24,
    shift: overrides.shift ?? false,
    alt: overrides.alt ?? false,
    ctrl: overrides.ctrl ?? false,
    ...(overrides.wheelDelta !== undefined ? { wheelDelta: overrides.wheelDelta } : {}),
    ...(overrides.clickCount !== undefined ? { clickCount: overrides.clickCount } : {}),
  };
}

function useFakeDate(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

describe('focusOnUnfocusedClick', () => {
  it('returns undefined when already focused', () => {
    expect(focusOnUnfocusedClick(true, mouse('press'))).toBeUndefined();
    expect(focusOnUnfocusedClick(true, mouse('click'))).toBeUndefined();
  });

  it('consumes left press and focuses on left click while ignoring other events', () => {
    expect(focusOnUnfocusedClick(false, mouse('press'))).toEqual({ handled: true });
    expect(focusOnUnfocusedClick(false, mouse('click'))).toEqual({ handled: true, focus: true });
    expect(focusOnUnfocusedClick(false, mouse('press', { button: 'right' }))).toBeUndefined();
    expect(focusOnUnfocusedClick(false, mouse('click', { button: 'right' }))).toBeUndefined();
    expect(focusOnUnfocusedClick(false, mouse('move'))).toBeUndefined();
    expect(focusOnUnfocusedClick(false, mouse('wheel', { wheelDelta: 1 }))).toBeUndefined();
    expect(focusOnUnfocusedClick(false, mouse('release'))).toBeUndefined();
  });
});

describe('ListMouseTracker', () => {
  it('tracks multi-line regions, resolves hits and ranges, and ignores empty ranges', () => {
    const tracker = new ListMouseTracker<string>();
    const lines: string[] = ['header'];
    tracker.track(lines, 'first', () => {
      lines.push('item 1', 'desc 1');
    });
    tracker.track(lines, 'empty', () => {});
    tracker.add(5, 5, 'zero');
    tracker.add(6, 4, 'inverted');
    tracker.track(lines, 'second', () => {
      lines.push('item 2');
    });

    expect(tracker.hitAt(0)).toBeUndefined();
    expect(tracker.hitAt(1)).toBe('first');
    expect(tracker.hitAt(2)).toBe('first');
    expect(tracker.hitAt(3)).toBe('second');
    expect(tracker.hitAt(4)).toBeUndefined();
    expect(tracker.rangeOf('first')).toEqual({ start: 1, end: 3 });
    expect(tracker.rangeOf('second')).toEqual({ start: 3, end: 4 });
    expect(tracker.rangeOf('empty')).toBeUndefined();

    tracker.reset();
    expect(tracker.hitAt(1)).toBeUndefined();
    expect(tracker.rangeOf('first')).toBeUndefined();
  });

  it('gates unfocused interactions to focus-only on left press/click', () => {
    useFakeDate();
    const tracker = new ListMouseTracker<number>();
    tracker.add(0, 1, 0);
    vi.advanceTimersByTime(300);
    const onHover = vi.fn(() => true);
    const onActivate = vi.fn();
    const onWheel = vi.fn(() => true);

    expect(tracker.handle(mouse('move', { y: 0 }), { focused: false, onHover, onActivate })).toBeUndefined();
    expect(
      tracker.handle(mouse('wheel', { y: 0, wheelDelta: 1 }), { focused: false, onWheel, onActivate }),
    ).toBeUndefined();
    expect(tracker.handle(mouse('press', { y: 0 }), { focused: false, onHover, onActivate })).toEqual({
      handled: true,
    });
    expect(tracker.handle(mouse('click', { y: 0 }), { focused: false, onHover, onActivate })).toEqual({
      handled: true,
      focus: true,
    });
    expect(onHover).not.toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
    expect(onWheel).not.toHaveBeenCalled();
  });

  it('supports default wheel consume, passthrough, and custom wheel callbacks', () => {
    const tracker = new ListMouseTracker<number>();
    expect(tracker.handle(mouse('wheel', { wheelDelta: 2 }), {})).toEqual({ handled: true });
    expect(
      tracker.handle(mouse('wheel', { wheelDelta: 2 }), { onWheel: 'passthrough' }),
    ).toBeUndefined();

    const onWheel = vi.fn((delta: number) => delta > 0);
    expect(tracker.handle(mouse('wheel', { wheelDelta: 3 }), { onWheel })).toEqual({
      handled: true,
      render: true,
    });
    expect(tracker.handle(mouse('wheel', { wheelDelta: -1 }), { onWheel })).toEqual({
      handled: true,
      render: false,
    });
    expect(onWheel).toHaveBeenNthCalledWith(1, 3);
    expect(onWheel).toHaveBeenNthCalledWith(2, -1);
  });

  it('handles hover, press, settling clicks, resetSettling, drag-off cancellation, and canActivate=false', () => {
    useFakeDate();
    const tracker = new ListMouseTracker<number>();
    tracker.add(1, 3, 0);
    tracker.add(3, 5, 1);

    let selected = 0;
    const onHover = vi.fn((idx: number) => {
      const changed = selected !== idx;
      selected = idx;
      return changed;
    });
    const onActivate = vi.fn();

    expect(tracker.handle(mouse('move', { y: 3 }), {})).toBeUndefined();
    expect(tracker.handle(mouse('move', { y: 0 }), { onHover })).toBeUndefined();
    expect(tracker.handle(mouse('move', { y: 3 }), { onHover })).toEqual({
      handled: true,
      render: true,
    });
    expect(tracker.handle(mouse('move', { y: 4 }), { onHover })).toEqual({
      handled: true,
      render: false,
    });

    expect(tracker.handle(mouse('click', { y: 3 }), { onHover, onActivate })).toEqual({
      handled: true,
    });
    expect(onActivate).not.toHaveBeenCalled();

    expect(
      tracker.handle(mouse('click', { y: 3 }), { settling: false, onHover, onActivate }),
    ).toEqual({ handled: true, render: true });
    expect(onActivate).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(300);
    tracker.resetSettling();
    expect(tracker.handle(mouse('click', { y: 3 }), { onHover, onActivate })).toEqual({
      handled: true,
    });
    expect(onActivate).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(300);
    expect(tracker.handle(mouse('press', { y: 1 }), { onHover, onActivate })).toEqual({
      handled: true,
      render: true,
    });
    expect(tracker.handle(mouse('click', { y: 3 }), { onHover, onActivate })).toEqual({
      handled: true,
    });
    expect(onActivate).toHaveBeenCalledTimes(1);

    expect(tracker.handle(mouse('press', { y: 1 }), { onHover, onActivate })).toEqual({
      handled: true,
      render: false,
    });
    expect(tracker.handle(mouse('click', { y: 0 }), { onHover, onActivate })).toEqual({
      handled: true,
    });
    expect(onActivate).toHaveBeenCalledTimes(1);

    expect(
      tracker.handle(mouse('click', { y: 3 }), {
        canActivate: false,
        onHover,
        onActivate,
      }),
    ).toEqual({ handled: true, render: true });
    expect(selected).toBe(1);
    expect(onActivate).toHaveBeenCalledTimes(1);

    expect(tracker.handle(mouse('press', { y: 1 }), { onHover, onActivate })).toEqual({
      handled: true,
      render: true,
    });
    const clickEvent = mouse('click', { y: 2, clickCount: 2 });
    expect(tracker.handle(clickEvent, { onHover, onActivate })).toEqual({
      handled: true,
      render: true,
    });
    expect(onActivate).toHaveBeenLastCalledWith(0, clickEvent);
  });

  it('preserves press-to-click match across re-renders for structured target values', () => {
    useFakeDate();
    const tracker = new ListMouseTracker<{ readonly kind: 'item'; readonly id: string }>();
    tracker.add(0, 1, { kind: 'item', id: 'alpha' });
    vi.advanceTimersByTime(300);

    const onActivate = vi.fn();
    expect(tracker.handle(mouse('press', { y: 0 }), { onActivate })).toEqual({
      handled: true,
      render: false,
    });

    tracker.reset();
    tracker.add(0, 1, { kind: 'item', id: 'alpha' });
    expect(tracker.rangeOf({ kind: 'item', id: 'alpha' })).toEqual({ start: 0, end: 1 });
    expect(tracker.handle(mouse('click', { y: 0 }), { onActivate })).toEqual({
      handled: true,
      render: true,
    });
    expect(onActivate).toHaveBeenCalledWith({ kind: 'item', id: 'alpha' }, expect.anything());
  });
});

describe('renderInlineSegments', () => {
  it('computes ANSI-aware visible column targets and clips overflowing lines to maxWidth', () => {
    const previousLevel = chalk.level;
    chalk.level = 3;
    onTestFinished(() => {
      chalk.level = previousLevel;
    });

    const styled = renderInlineSegments<string>(
      [
        { text: ' ' },
        { text: chalk.hex(darkColors.primary)('Alpha'), value: 'a' },
        { text: ' · ' },
        { text: chalk.hex(darkColors.textMuted)('Beta'), value: 'b' },
        { text: '', value: 'empty' },
      ],
      20,
    );
    expect(stripVTControlCharacters(styled.line)).toBe(' Alpha · Beta');
    expect(styled.targets).toEqual([
      { start: 1, end: 6, value: 'a' },
      { start: 9, end: 13, value: 'b' },
    ]);

    const clipped = renderInlineSegments<string>(
      [
        { text: 'Alpha', value: 'a' },
        { text: ' ' },
        { text: 'BetaGamma', value: 'b' },
        { text: 'Delta', value: 'd' },
      ],
      10,
    );
    expect(stripVTControlCharacters(clipped.line)).toBe('Alpha B...');
    expect(visibleWidth(clipped.line)).toBeLessThanOrEqual(10);
    expect(clipped.targets).toEqual([
      { start: 0, end: 5, value: 'a' },
      { start: 6, end: 7, value: 'b' },
    ]);

    const zero = renderInlineSegments([{ text: 'Alpha', value: 'a' }], 0);
    expect(zero).toEqual({ line: '', targets: [] });
  });
});

describe('SpanHitMap', () => {
  it('never requests focus when focused is omitted and passes through wheel and unsubscribed moves', () => {
    useFakeDate();
    const map = new SpanHitMap<string>();
    const rendered = renderInlineSegments(
      [
        { text: ' ' },
        { text: '[Yes]', value: 'yes' },
        { text: ' ' },
        { text: '[No]', value: 'no' },
      ],
      40,
    );
    map.addRow(2, rendered.targets);
    vi.advanceTimersByTime(300);

    const onActivate = vi.fn();
    expect(map.hitAt(0, 2)).toBeUndefined();
    expect(map.hitAt(1, 2)).toBe('yes');
    expect(map.hitAt(5, 2)).toBe('yes');
    expect(map.hitAt(6, 2)).toBeUndefined();
    expect(map.hitAt(7, 2)).toBe('no');

    expect(map.handle(mouse('move', { x: 2, y: 2 }), { onActivate })).toBeUndefined();
    expect(map.handle(mouse('wheel', { x: 2, y: 2, wheelDelta: 1 }), { onActivate })).toBeUndefined();
    expect(map.handle(mouse('click', { x: 0, y: 2 }), { onActivate })).toBeUndefined();

    const pressResult = map.handle(mouse('press', { x: 2, y: 2 }), { onActivate });
    const clickResult = map.handle(mouse('click', { x: 2, y: 2 }), { onActivate });
    expect(pressResult).toEqual({ handled: true, render: false });
    expect(clickResult).toEqual({ handled: true, render: true });
    expect(clickResult?.focus).toBeUndefined();
    expect(onActivate).toHaveBeenCalledWith('yes', expect.anything());
  });

  it('focuses on unfocused click when focused is explicitly false', () => {
    useFakeDate();
    const map = new SpanHitMap<string>();
    map.add(0, 2, 6, 'tab');
    vi.advanceTimersByTime(300);
    const onActivate = vi.fn();

    expect(
      map.handle(mouse('press', { x: 3, y: 0 }), { focused: false, onActivate }),
    ).toEqual({ handled: true });
    expect(
      map.handle(mouse('click', { x: 3, y: 0 }), { focused: false, onActivate }),
    ).toEqual({ handled: true, focus: true });
    expect(onActivate).not.toHaveBeenCalled();
  });
});

describe('isPointInRect and forwardEmbeddedMouse', () => {
  const rect: EmbeddedRect = {
    x: 4,
    y: 7,
    width: 20,
    height: 2,
    contentOffsetX: 2,
    contentOffsetY: 1,
  };

  it('checks half-open rectangle boundaries', () => {
    expect(isPointInRect(rect, 4, 7)).toBe(true);
    expect(isPointInRect(rect, 23, 8)).toBe(true);
    expect(isPointInRect(rect, 3, 7)).toBe(false);
    expect(isPointInRect(rect, 24, 7)).toBe(false);
    expect(isPointInRect(rect, 4, 6)).toBe(false);
    expect(isPointInRect(rect, 4, 9)).toBe(false);
  });

  it('transforms local coordinates with offsets and strips target/focusTarget metadata', () => {
    const received: TuiMouseEvent[] = [];
    const child: Component = {
      render: () => [],
      invalidate: () => {},
      handleMouse: (event): TuiMouseEventResult => {
        received.push(event);
        const dispatch: TuiMouseDispatchResult = {
          handled: true,
          focus: true,
          capture: true,
          render: true,
          target: { component: child, originX: 0, originY: 0, width: 10, height: 1 },
          focusTarget: child,
        };
        return dispatch;
      },
    };

    expect(forwardEmbeddedMouse(child, undefined, mouse('press', { x: 6, y: 7 }))).toBeUndefined();
    expect(forwardEmbeddedMouse(child, rect, mouse('press', { x: 3, y: 7 }))).toBeUndefined();
    expect(received).toHaveLength(0);

    const result = forwardEmbeddedMouse(child, rect, mouse('press', { x: 6, y: 8 }));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'press',
      x: 4,
      y: 2,
      width: 22,
      height: 3,
    });
    expect(result).toEqual({ handled: true, focus: true, capture: true, render: true });
    expect('target' in (result ?? {})).toBe(false);
    expect('focusTarget' in (result ?? {})).toBe(false);
  });
});
