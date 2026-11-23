// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createDomAnchors, HOLD_MS, type AnchorPath, type ScrollMode } from '../../src/lib/transcriptScroll';
import { blockRows, DOCK_GAP, LayoutSim, mulberry32, textRows, type SimRow } from './layoutSim';

const ROW = 278;
let current: LayoutSim | null = null;

afterEach(() => {
  current?.controller.dispose();
  current = null;
});

function setup(rows: SimRow[] = blockRows(12), viewport = 400): LayoutSim {
  current = new LayoutSim({ rows, viewport });
  return current;
}

function anchored(s: LayoutSim): Extract<ScrollMode, { kind: 'anchored' }> {
  const mode = s.controller.state.mode;
  if (mode.kind !== 'anchored') throw new Error(`expected anchored, got ${mode.kind}`);
  return mode;
}

function resolve(s: LayoutSim, path: AnchorPath): HTMLElement {
  return createDomAnchors(s.scroller).resolve(path)!;
}

type AnchoredMode = Extract<ScrollMode, { kind: 'anchored' }>;

function stepCheck(s: LayoutSim, anchored: { mode: ScrollMode; anchor: AnchorPath } | null): { kind: 'follow' | 'anchored' | 'clamped'; actual: unknown[]; expected: unknown[] } {
  if (anchored === null) {
    return { kind: 'follow', actual: [s.controller.state.following, s.distanceFromBottom()], expected: [true, 0] };
  }
  const { offset } = anchored.mode as AnchoredMode;
  const el = resolve(s, anchored.anchor);
  const desired = s.docTop(el) - offset;
  const sameMode = s.controller.state.mode === anchored.mode;
  if (desired >= 0 && desired <= s.maxTop) {
    return { kind: 'anchored', actual: [sameMode, s.visualTop(el)], expected: [true, offset] };
  }
  return { kind: 'clamped', actual: [sameMode, s.scrollTop], expected: [true, Math.min(Math.max(0, desired), s.maxTop)] };
}

function scrollUserTo(s: LayoutSim, top: number): void {
  s.userScroll(top);
  s.frame();
}

function wheel(deltaY: number): WheelEvent {
  return new WheelEvent('wheel', { deltaY });
}

function pointer(type: string, clientX = 0): MouseEvent {
  const event = new MouseEvent(type, { clientX, bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  return event;
}

function dragStart(s: LayoutSim): void {
  s.scroller.addEventListener('pointerdown', e => s.controller.onInput(e), { once: true });
  s.scroller.dispatchEvent(pointer('pointerdown', s.width + 5));
}

describe('follow mode', () => {
  it('starts at the bottom', () => {
    const s = setup();
    expect(s.controller.state.following).toBe(true);
    expect(s.distanceFromBottom()).toBe(0);
    expect(s.scrollTop).toBe(12 * ROW + DOCK_GAP - 400);
  });

  it('stays at the bottom when the last row grows', () => {
    const s = setup();
    for (let i = 1; i <= 5; i++) {
      s.setChildHeight('r11', 'md', 3, 40 + i * 37);
      s.frame();
      expect(s.distanceFromBottom()).toBe(0);
    }
    expect(s.controller.state.mode.kind).toBe('follow');
  });

  it('stays at the bottom when rows are appended', () => {
    const s = setup();
    s.insertRows(12, textRows(2, 350, 'n'));
    s.frame();
    expect(s.distanceFromBottom()).toBe(0);
    expect(s.controller.state.following).toBe(true);
  });

  it('stays at the bottom when the dock grows and writes the bottom padding', () => {
    const s = setup();
    s.setDock(160);
    s.frame();
    expect(s.scrollHeight).toBe(12 * ROW + 160 + DOCK_GAP);
    expect(s.distanceFromBottom()).toBe(0);
  });

  it('drops the bottom padding when the dock is removed', () => {
    const s = setup();
    s.setDock(160);
    s.frame();
    s.controller.observeAux('dock', null);
    expect(s.scrollHeight).toBe(12 * ROW + DOCK_GAP);
    expect(s.distanceFromBottom()).toBe(0);
  });

  it('keeps the last height when a row reports zero', () => {
    const s = setup(textRows(12, 200));
    s.setRowHeight('r3', 0);
    s.frame();
    expect(s.model.height(3)).toBe(200);
  });

  it('stays at the bottom when the viewport shrinks or the tail grows', () => {
    const s = setup();
    s.setViewport(250);
    s.frame();
    expect(s.distanceFromBottom()).toBe(0);
    s.setTail(90);
    s.frame();
    expect(s.distanceFromBottom()).toBe(0);
    s.setViewport(600);
    s.frame();
    s.frame();
    expect(s.distanceFromBottom()).toBe(0);
    expect(s.controller.state.following).toBe(true);
  });

  it('keeps following when content shrinks and the browser clamps the position', () => {
    const s = setup();
    s.setChildHeight('r11', 'md', 2, 5);
    s.frame();
    s.frame();
    expect(s.distanceFromBottom()).toBe(0);
    expect(s.controller.state.following).toBe(true);
  });

  it('keeps following when layout moves the position up slightly and grows again before the scroll event', () => {
    const s = setup();
    s.userScroll(s.scrollTop - 11);
    s.setChildHeight('r11', 'md', 3, 120);
    s.flushResize();
    s.frame();
    expect(s.controller.state.following).toBe(true);
    expect(s.distanceFromBottom()).toBe(0);
  });
});

describe('anchored mode', () => {
  function readingAt(top = 1000) {
    const s = setup();
    scrollUserTo(s, top);
    const mode = anchored(s);
    const el = resolve(s, mode.anchor);
    return { s, mode, el, before: s.visualTop(el) };
  }

  it('anchors to the deepest element at the viewport top after a user scroll', () => {
    const { mode, before } = readingAt();
    expect(mode.anchor).toEqual({ row: 'r3', block: 'md', child: 2 });
    expect(mode.offset).toBe(-28);
    expect(before).toBe(-28);
  });

  it.each([
    ['grows', (s: LayoutSim) => s.setBlockHeight('r1', 'head', 230)],
    ['shrinks', (s: LayoutSim) => s.setChildHeight('r0', 'md', 2, 4)],
    ['gets an inserted row', (s: LayoutSim) => s.insertRows(2, textRows(1, 420, 'x'))],
    ['loses a row', (s: LayoutSim) => s.removeRow('r1')],
    ['gets rows prepended', (s: LayoutSim) => s.insertRows(0, textRows(6, 333, 'h'))],
  ])('keeps the anchor in place when content above %s', (_, change) => {
    const { s, el, before } = readingAt();
    change(s);
    s.frame();
    s.frame();
    expect(s.visualTop(el)).toBe(before);
    expect(s.controller.state.mode.kind).toBe('anchored');
  });

  it('keeps the anchor in place when blocks above it inside the same row grow', () => {
    const { s, el, before } = readingAt();
    s.setBlockHeight('r3', 'head', 130);
    s.frame();
    expect(s.visualTop(el)).toBe(before);
    s.setChildHeight('r3', 'md', 0, 300);
    s.frame();
    expect(s.visualTop(el)).toBe(before);
    s.setChildHeight('r3', 'md', 1, 1);
    s.frame();
    expect(s.visualTop(el)).toBe(before);
  });

  it('does not write when content below the anchor changes', () => {
    const { s, el, before } = readingAt();
    const writes = s.writes.length;
    s.setChildHeight('r3', 'md', 2, 500);
    s.setChildHeight('r3', 'md', 3, 10);
    s.setBlockHeight('r6', 'foot', 400);
    s.insertRows(10, textRows(2, 200, 'y'));
    s.setDock(120);
    s.setViewport(300);
    s.frame();
    s.frame();
    expect(s.writes.length).toBe(writes);
    expect(s.visualTop(el)).toBe(before);
  });

  it.each([
    ['grows', 230],
    ['shrinks', 4],
  ])('moves the anchor only by the user scroll when content above %s in the same frame', (_, height) => {
    const { s, el, before } = readingAt();
    s.setBlockHeight('r1', 'head', height);
    s.userScroll(s.scrollTop + 50);
    s.frame();
    s.frame();
    expect(s.visualTop(el)).toBe(before - 50);
  });

  it('does not treat its own corrections as user scrolls', () => {
    const { s, mode } = readingAt();
    s.setBlockHeight('r0', 'head', 330);
    s.frame();
    s.frame();
    expect(s.writes.at(-1)?.reason).toBe('resize');
    expect(s.controller.state.mode).toBe(mode);
  });

  it('falls back to model positions when the anchor row is not mounted', () => {
    const { s, mode } = readingAt();
    s.unmount('r2');
    s.frame();
    s.controller.restore({ mode: 'anchored', anchor: { row: 'r2' }, offset: -40 });
    expect(s.scrollTop).toBe(2 * ROW + 40);
    expect(mode.anchor.row).toBe('r3');
  });

  it('writes at most once per resize callback', () => {
    const { s, el, before } = readingAt();
    s.setBlockHeight('r0', 'head', 99);
    s.setChildHeight('r2', 'md', 1, 220);
    s.insertRows(1, textRows(3, 120, 'z'));
    s.setDock(200);
    s.setViewport(320);
    s.setWidth(640);
    s.frame();
    expect(s.writesPerCallback.at(-1)).toBe(1);
    expect(Math.max(...s.writesPerCallback)).toBeLessThanOrEqual(1);
    expect(s.visualTop(el)).toBe(before);
  });
});

describe('mode transitions from input', () => {
  it('leaves follow on an unexpected scroll position', () => {
    const s = setup();
    scrollUserTo(s, s.maxTop - 100);
    expect(s.controller.state.mode.kind).toBe('anchored');
  });

  it('leaves follow immediately on an upward wheel, before the scroll event', () => {
    const s = setup();
    const top = s.scrollTop;
    s.controller.onInput(wheel(-40));
    expect(s.controller.state.mode.kind).toBe('anchored');
    s.setChildHeight('r11', 'md', 3, 400);
    s.frame();
    expect(s.scrollTop).toBe(top);
  });

  it('keeps following when a nested scroller consumes an upward wheel', () => {
    const s = setup();
    const nested = document.createElement('pre');
    Object.defineProperties(nested, { scrollHeight: { value: 900 }, clientHeight: { value: 100 }, scrollTop: { value: 50 } });
    s.blockEl('r11', 'foot').append(nested);
    s.scroller.addEventListener('wheel', e => s.controller.onInput(e), { once: true });
    nested.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));
    expect(s.controller.state.following).toBe(true);
  });

  it('leaves follow on upward scroll keys', () => {
    const s = setup();
    s.controller.onInput(new KeyboardEvent('keydown', { key: 'PageUp' }));
    expect(s.controller.state.mode.kind).toBe('anchored');
  });

  it('re-enters follow when the user scrolls down to the bottom threshold', () => {
    const s = setup();
    scrollUserTo(s, s.maxTop - 300);
    expect(s.controller.state.following).toBe(false);
    scrollUserTo(s, s.maxTop - 30);
    expect(s.controller.state.following).toBe(false);
    scrollUserTo(s, s.maxTop - 20);
    expect(s.controller.state.following).toBe(true);
    s.setChildHeight('r11', 'md', 3, 120);
    s.frame();
    expect(s.distanceFromBottom()).toBe(0);
  });

  it('stays anchored when scrolling up near the bottom', () => {
    const s = setup();
    scrollUserTo(s, s.maxTop - 5);
    expect(s.controller.state.following).toBe(false);
  });

  it('shows the jump pill once far from the bottom', () => {
    const s = setup();
    scrollUserTo(s, s.maxTop - 100);
    expect(s.controller.state.showJump).toBe(false);
    scrollUserTo(s, s.maxTop - 300);
    expect(s.controller.state.showJump).toBe(true);
    s.controller.follow();
    expect(s.controller.state.showJump).toBe(false);
  });

  it('reports the row at the reading line', () => {
    const s = setup();
    scrollUserTo(s, ROW * 5);
    expect(s.controller.state.activeRowKey).toBe('r5');
    scrollUserTo(s, ROW * 5 + 100);
    expect(s.controller.state.activeRowKey).toBe('r6');
  });
});

describe('scrollbar drags and touch', () => {
  it('does not write while dragging and corrects once on pointerup', () => {
    const s = setup();
    dragStart(s);
    expect(s.controller.state.mode.kind).toBe('anchored');
    scrollUserTo(s, 1000);
    const mode = anchored(s);
    const el = resolve(s, mode.anchor);
    const writes = s.writes.length;
    s.setBlockHeight('r0', 'head', 200);
    s.frame();
    expect(s.writes.length).toBe(writes);
    expect(s.visualTop(el)).toBe(mode.offset + 170);
    s.controller.onInput(pointer('pointerup'));
    expect(s.writes.length).toBe(writes + 1);
    expect(s.writes.at(-1)?.reason).toBe('drag-end');
    expect(s.visualTop(el)).toBe(mode.offset);
  });

  it('defers corrections during touch scrolling until scrollend', () => {
    const s = setup();
    s.controller.onInput(new Event('touchstart'));
    s.controller.onInput(new Event('touchmove'));
    scrollUserTo(s, 1000);
    const mode = anchored(s);
    const el = resolve(s, mode.anchor);
    const writes = s.writes.length;
    s.setBlockHeight('r1', 'head', 130);
    s.frame();
    s.controller.onInput(new Event('touchend'));
    s.frame();
    expect(s.writes.length).toBe(writes);
    s.controller.onInput(new Event('scrollend'));
    expect(s.writes.length).toBe(writes + 1);
    expect(s.writes.at(-1)?.reason).toBe('scroll-end');
    expect(s.visualTop(el)).toBe(mode.offset);
  });

  it('corrects on touchend when the touch did not scroll', () => {
    const s = setup();
    s.controller.onInput(new Event('touchstart'));
    s.setChildHeight('r11', 'md', 3, 300);
    s.frame();
    expect(s.distanceFromBottom()).toBeGreaterThan(0);
    s.controller.onInput(new Event('touchend'));
    expect(s.distanceFromBottom()).toBe(0);
  });
});

describe('hold', () => {
  it('keeps a clicked element still while content above it expands', () => {
    const s = setup();
    scrollUserTo(s, 1000);
    const el = s.childEl('r3', 'md', 3);
    const before = s.visualTop(el);
    s.controller.hold(el);
    for (let i = 1; i <= 8; i++) {
      s.setChildHeight('r3', 'md', 1, 60 + i * 25);
      s.setBlockHeight('r1', 'foot', 20 + i * 10);
      s.frame();
      expect(s.visualTop(el)).toBe(before);
    }
  });

  it('turns follow into anchored like the old pin', () => {
    const s = setup();
    const el = s.blockEl('r11', 'head');
    const before = s.visualTop(el);
    s.controller.hold(el);
    expect(s.controller.state.mode).toMatchObject({ kind: 'anchored', anchor: { row: 'r11', block: 'head' } });
    s.setChildHeight('r11', 'md', 0, 400);
    s.frame();
    expect(s.visualTop(el)).toBe(before);
  });

  it('returns to follow once the hold ends at the bottom', () => {
    const s = setup();
    s.controller.hold(s.blockEl('r11', 'head'));
    s.setChildHeight('r11', 'md', 2, 20);
    s.frame();
    expect(s.distanceFromBottom()).toBe(0);
    s.frame(HOLD_MS);
    s.frame();
    expect(s.controller.state.mode.kind).toBe('follow');
    s.insertRows(12, textRows(1, 300, 'n'));
    s.frame();
    expect(s.distanceFromBottom()).toBe(0);
  });

  it('honors a longer hold and stays anchored away from the bottom', () => {
    const s = setup();
    s.controller.hold(s.blockEl('r11', 'head'), HOLD_MS * 2);
    s.frame(HOLD_MS + 16);
    expect(s.controller.state.mode.kind).toBe('anchored');
    s.frame(HOLD_MS);
    s.frame();
    expect(s.controller.state.mode.kind).toBe('follow');

    scrollUserTo(s, 1000);
    s.controller.hold(s.childEl('r3', 'md', 3));
    s.frame(HOLD_MS);
    s.frame();
    expect(s.controller.state.mode.kind).toBe('anchored');
  });

  it('releases on the next user scroll', () => {
    const s = setup();
    scrollUserTo(s, 1000);
    s.controller.hold(s.childEl('r3', 'md', 3));
    scrollUserTo(s, 1400);
    expect(anchored(s).anchor).toEqual(createDomAnchors(s.scroller).pick(s.clientTop)!.path);
  });
});

describe('navigate', () => {
  it('aligns the target to the start', async () => {
    const s = setup();
    await s.controller.navigate({ row: 'r4' });
    expect(s.visualTop(s.rowEl('r4'))).toBe(0);
    expect(s.controller.state.mode).toMatchObject({ kind: 'anchored', anchor: { row: 'r4' }, offset: 0 });
  });

  it('centers the target', async () => {
    const s = setup();
    await s.controller.navigate({ row: 'r4', block: 'head' }, { align: 'center' });
    expect(s.visualTop(s.blockEl('r4', 'head'))).toBe(185);
    s.setBlockHeight('r2', 'head', 300);
    s.frame();
    expect(s.visualTop(s.blockEl('r4', 'head'))).toBe(185);
  });

  it('keeps a target clamped at the top where it is visible when older rows are prepended', async () => {
    const s = setup();
    const target = { row: 'r0', block: 'md', child: 1 };
    await s.controller.navigate(target, { align: 'center' });
    const el = resolve(s, target);
    const visible = s.visualTop(el);
    expect(s.scrollTop).toBe(0);
    s.insertRows(0, textRows(4, 300, 'old'));
    s.frame();
    s.frame();
    expect(s.visualTop(el)).toBe(visible);
  });

  it('uses the model position for an unmounted target and settles once it mounts', async () => {
    const s = setup();
    s.unmount('r1');
    s.frame();
    let settled = false;
    const done = s.controller.navigate({ row: 'r1' }).then(() => (settled = true));
    expect(s.scrollTop).toBe(ROW);
    expect(s.controller.state.mode.kind).toBe('navigating');
    s.mount('r1');
    s.frame();
    await done;
    expect(settled).toBe(true);
    expect(s.visualTop(s.rowEl('r1'))).toBe(0);
  });

  it('ignores unknown targets', async () => {
    const s = setup();
    const top = s.scrollTop;
    await s.controller.navigate({ row: 'missing' });
    expect(s.scrollTop).toBe(top);
    expect(s.controller.state.following).toBe(true);
  });

  it('animates to a target that moves during the animation', async () => {
    const s = setup();
    let settled = false;
    const done = s.controller.navigate({ row: 'r2' }, { smooth: true }).then(() => (settled = true));
    expect(s.controller.state.mode).toMatchObject({ kind: 'navigating', animation: true });
    const frames: number[] = [];
    for (let i = 0; i < 40 && s.hasPendingFrame(); i++) {
      if (i === 4) s.setBlockHeight('r1', 'head', 400);
      if (i === 8) s.insertRows(0, textRows(2, 150, 'h'));
      const before = s.writes.length;
      s.frame();
      frames.push(s.writes.length - before);
    }
    await done;
    expect(settled).toBe(true);
    expect(Math.max(...frames)).toBe(1);
    expect(s.writes.filter(w => w.reason === 'resize')).toHaveLength(1);
    expect(s.visualTop(s.rowEl('r2'))).toBe(0);
    expect(s.controller.state.mode).toMatchObject({ kind: 'anchored', anchor: { row: 'r2' }, offset: 0 });
  });

  it('keeps navigating when the browser clamps the position without user input', async () => {
    const s = setup();
    const done = s.controller.navigate({ row: 'r2' }, { smooth: true });
    s.removeRow('r11');
    void s.scrollTop;
    s.insertRows(11, textRows(1, ROW, 'back'));
    for (let i = 0; i < 40; i++) s.frame();
    await done;
    expect(s.visualTop(s.rowEl('r2'))).toBe(0);
  });

  it('stops animating when the user scrolls', async () => {
    const s = setup();
    const done = s.controller.navigate({ row: 'r2' }, { smooth: true });
    s.frame();
    s.frame();
    s.controller.onInput(wheel(30));
    await done;
    expect(s.controller.state.mode.kind).toBe('anchored');
    const writes = s.writes.length;
    for (let i = 0; i < 20; i++) s.frame();
    expect(s.writes.length).toBe(writes);
  });

  it('jumps without animation when reduced motion is preferred', async () => {
    const s = setup();
    s.reducedMotion = true;
    await s.controller.navigate({ row: 'r2' }, { smooth: true });
    expect(s.hasPendingFrame()).toBe(false);
    expect(s.visualTop(s.rowEl('r2'))).toBe(0);
  });
});

describe('follow()', () => {
  it('animates back to the bottom and keeps following', () => {
    const s = setup();
    scrollUserTo(s, 500);
    s.controller.follow({ smooth: true });
    expect(s.controller.state.following).toBe(true);
    for (let i = 0; i < 40 && s.hasPendingFrame(); i++) {
      if (i === 3) s.setChildHeight('r11', 'md', 3, 300);
      s.frame();
    }
    expect(s.distanceFromBottom()).toBe(0);
    s.setChildHeight('r11', 'md', 3, 500);
    s.frame();
    expect(s.distanceFromBottom()).toBe(0);
  });

  it('jumps immediately without smooth', () => {
    const s = setup();
    scrollUserTo(s, 500);
    s.controller.follow();
    expect(s.distanceFromBottom()).toBe(0);
  });
});

describe('snapshot and restore', () => {
  it('restores follow', () => {
    const s = setup();
    const snap = s.controller.snapshot();
    expect(snap).toEqual({ mode: 'follow' });
    scrollUserTo(s, 300);
    s.controller.restore(snap);
    expect(s.distanceFromBottom()).toBe(0);
    s.controller.restore(null);
    expect(s.controller.state.following).toBe(true);
  });

  it('restores an anchored reading position', () => {
    const s = setup();
    scrollUserTo(s, 1000);
    const snap = s.controller.snapshot();
    const el = s.childEl('r3', 'md', 2);
    const before = s.visualTop(el);
    s.controller.follow();
    s.setBlockHeight('r0', 'head', 120);
    s.frame();
    s.controller.restore(snap);
    expect(s.visualTop(el)).toBe(before);
    expect(s.controller.state.mode.kind).toBe('anchored');
  });

  it('restores from the model when the anchor row is not mounted, then refines once it mounts', () => {
    const s = setup();
    scrollUserTo(s, 1000);
    const snap = s.controller.snapshot();
    if (snap.mode !== 'anchored') throw new Error('expected anchored snapshot');
    s.controller.follow();
    s.unmount('r3');
    s.frame();
    s.controller.restore(snap);
    expect(s.scrollTop).toBe(3 * ROW - snap.rowOffset!);
    expect(s.scrollTop).toBe(1000);
    s.mount('r3');
    s.frame();
    expect(s.visualTop(s.childEl('r3', 'md', 2))).toBe(snap.offset);
  });
});

describe('layout entry points', () => {
  it('keys row measurements to the content column width instead of the scroller width', () => {
    const s = setup();
    s.contentWidth = 760;
    s.controller.observeAux('content', s.contentEl);
    s.frame();
    expect(s.model.environment.width).toBe(760);
    s.setWidth(1400);
    s.frame();
    expect(s.model.environment.width).toBe(760);
    expect(s.model.isMeasured('r11')).toBe(true);
    s.contentWidth = 600;
    s.setWidth(900);
    s.frame();
    expect(s.model.environment.width).toBe(600);
  });

  it('defers a restore until the next resize callback and writes once there', () => {
    const s = setup();
    scrollUserTo(s, 1000);
    const snap = s.controller.snapshot();
    const el = s.childEl('r3', 'md', 2);
    const before = s.visualTop(el);
    s.controller.follow();
    const writes = s.writes.length;
    s.controller.restore(snap, { defer: true });
    expect(s.writes.length).toBe(writes);
    expect(s.controller.state.mode.kind).toBe('anchored');
    s.setBlockHeight('r0', 'head', 120);
    s.frame();
    expect(s.writes.slice(writes).map(w => w.reason)).toEqual(['resize']);
    expect(s.visualTop(el)).toBe(before);
  });

  it('treats a position change before the first correction after a deferred restore as a clamp', () => {
    const s = setup();
    scrollUserTo(s, 1000);
    s.controller.restore(null, { defer: true });
    s.userScroll(0);
    s.setTail(20);
    s.frame();
    expect(s.controller.state.following).toBe(true);
    expect(s.distanceFromBottom()).toBe(0);
    s.userScroll(500);
    s.frame();
    expect(s.controller.state.mode.kind).toBe('anchored');
  });

  it('navigates with a shift relative to the target and keeps that offset', async () => {
    const s = setup();
    await s.controller.navigate({ row: 'r4' }, { shift: 60 });
    expect(s.visualTop(s.rowEl('r4'))).toBe(-60);
    expect(s.controller.state.mode).toMatchObject({ kind: 'anchored', anchor: { row: 'r4' }, offset: -60 });
  });

  it('holds the row position while a deep anchor is not rendered yet', () => {
    const s = setup();
    scrollUserTo(s, 1000);
    const snap = s.controller.snapshot();
    if (snap.mode !== 'anchored' || snap.anchor.child === undefined) throw new Error('expected a child anchor');
    const rowTop = s.visualTop(s.rowEl('r3'));
    s.controller.follow();
    s.replaceMarkdown('r3', 'md');
    const renderer = s.blockEl('r3', 'md').querySelector('.markdown-renderer')!;
    const children = [...renderer.children];
    renderer.replaceChildren(...children.slice(0, snap.anchor.child));
    s.setViewport(s.viewport);
    s.controller.restore(snap);
    expect(s.visualTop(s.rowEl('r3'))).toBe(rowTop);
    renderer.replaceChildren(...children);
    s.setViewport(s.viewport);
    s.frame();
    expect(s.visualTop(s.childEl('r3', 'md', snap.anchor.child))).toBe(snap.offset);
  });

  it('corrects on sync when only placeholder heights above the anchor changed', () => {
    const s = setup();
    scrollUserTo(s, 1000);
    const el = s.childEl('r3', 'md', 2);
    const before = s.visualTop(el);
    s.insertRows(0, textRows(2, 150, 'p').map(row => ({ ...row, mounted: false })));
    expect(s.visualTop(el)).not.toBe(before);
    const writes = s.writes.length;
    s.controller.sync();
    expect(s.writes.slice(writes).map(w => w.reason)).toEqual(['sync']);
    expect(s.visualTop(el)).toBe(before);
  });
});

describe('randomized invariants', () => {
  function randomRow(rng: () => number, key: string): SimRow {
    const r = (min: number, max: number) => Math.floor(min + rng() * (max - min));
    if (rng() < 0.3) return { key, height: r(20, 400) };
    return {
      key,
      gap: r(0, 24),
      blocks: [
        { key: 'head', height: r(10, 60) },
        { key: 'md', children: Array.from({ length: r(1, 5) }, () => r(10, 200)) },
        { key: 'foot', height: r(0, 40) },
      ],
    };
  }

  function mutate(s: LayoutSim, rng: () => number, protect: string | null, serial: { n: number }): void {
    const r = (min: number, max: number) => Math.floor(min + rng() * (max - min));
    const pick = () => s.rows[r(0, s.rows.length)]!;
    const op = rng();
    if (op < 0.4) {
      const row = pick();
      if (!row.blocks) s.setRowHeight(row.key, r(10, 500));
      else {
        const block = row.blocks[r(0, row.blocks.length)]!;
        if (block.children) s.setChildHeight(row.key, block.key, r(0, block.children.length), r(5, 300));
        else s.setBlockHeight(row.key, block.key, r(0, 120));
      }
    } else if (op < 0.55) {
      s.insertRows(r(0, s.rows.length + 1), Array.from({ length: r(1, 4) }, () => randomRow(rng, `n${serial.n++}`)));
    } else if (op < 0.7) {
      const victims = s.rows.filter(row => row.key !== protect);
      if (s.rows.length > 4) s.removeRow(victims[r(0, victims.length)]!.key);
    } else if (op < 0.8) {
      const scale = 0.6 + rng() * 0.9;
      s.setWidth(r(320, 1200));
      for (const row of s.rows) {
        if (!row.blocks) s.setRowHeight(row.key, Math.max(1, Math.round(row.height! * scale)));
        else for (const block of row.blocks) {
          if (block.children) block.children.forEach((h, i) => s.setChildHeight(row.key, block.key, i, Math.max(1, Math.round(h * scale))));
        }
      }
    } else if (op < 0.88) {
      s.setDock(r(0, 240));
    } else if (op < 0.95) {
      s.setViewport(r(200, 700));
    } else {
      s.setTail(r(0, 150));
    }
  }

  const master = mulberry32(20261118);
  const seeds = Array.from({ length: 1000 }, () => Math.floor(master() * 2 ** 32));
  const chunks = Array.from({ length: 10 }, (_, i) => i * 100);

  it.each(chunks)('keeps anchored offsets and follow bottoms across seeded change sequences starting at %i', (first) => {
    let anchoredChecks = 0;
    let followChecks = 0;
    for (let sequence = first; sequence < first + 100; sequence++) {
      const rng = mulberry32(seeds[sequence]!);
      const rows = Array.from({ length: 6 + Math.floor(rng() * 10) }, (_, i) => randomRow(rng, `r${i}`));
      const s = new LayoutSim({ rows, viewport: 250 + Math.floor(rng() * 400), dock: Math.floor(rng() * 120) });
      const follow = sequence % 2 === 0;
      if (!follow) {
        if (s.maxTop < 50) {
          s.controller.dispose();
          continue;
        }
        scrollUserTo(s, Math.floor(s.maxTop * (0.1 + rng() * 0.7)));
      }
      const mode = s.controller.state.mode;
      const anchor = mode.kind === 'anchored' ? mode.anchor : null;
      if (!follow && !anchor) throw new Error(`sequence ${sequence}: no anchor`);
      const serial = { n: 0 };
      const steps = 4 + Math.floor(rng() * 10);
      for (let step = 0; step < steps; step++) {
        const batch = 1 + Math.floor(rng() * 3);
        for (let i = 0; i < batch; i++) mutate(s, rng, anchor?.row ?? null, serial);
        s.frame();
        s.frame();
        const where = `sequence ${sequence} step ${step}`;
        const check = stepCheck(s, follow ? null : { mode, anchor: anchor! });
        expect(check.actual, where).toStrictEqual(check.expected);
        if (check.kind === 'follow') followChecks++;
        if (check.kind === 'anchored') anchoredChecks++;
      }
      expect(Math.max(0, ...s.writesPerCallback)).toBeLessThanOrEqual(1);
      expect(s.assignments).toBe(s.writes.length);
      s.controller.dispose();
    }
    expect(followChecks).toBeGreaterThan(150);
    expect(anchoredChecks).toBeGreaterThan(150);
  });
});
