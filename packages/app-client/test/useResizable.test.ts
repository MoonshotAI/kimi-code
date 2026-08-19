import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { useResizable } from '../src/composables';

// Runs in the node environment: the composable guards every DOM touch, so a
// fake handle element plus stubbed rAF / localStorage is enough to drive a
// full drag lifecycle.

function fakeHandle(): { el: HTMLElement; fire: (type: string, clientX: number) => void } {
  const listeners = new Map<string, Array<(event: { clientX: number }) => void>>();
  const el = {
    addEventListener: (type: string, cb: (event: { clientX: number }) => void) => {
      const list = listeners.get(type) ?? [];
      list.push(cb);
      listeners.set(type, list);
    },
    removeEventListener: (type: string, cb: (event: { clientX: number }) => void) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((fn) => fn !== cb),
      );
    },
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  } as unknown as HTMLElement;
  return {
    el,
    fire: (type, clientX) => {
      for (const cb of listeners.get(type) ?? []) cb({ clientX });
    },
  };
}

function pointerDown(target: HTMLElement, clientX: number): PointerEvent {
  return {
    preventDefault: () => {},
    clientX,
    currentTarget: target,
    pointerId: 1,
  } as unknown as PointerEvent;
}

// Manual rAF queue: the test decides when frames run.
let rafQueue: Map<number, FrameRequestCallback>;
let nextRafId: number;

function flushFrame(): void {
  const callbacks = [...rafQueue.values()];
  rafQueue.clear();
  for (const cb of callbacks) cb(0);
}

let store: Map<string, string>;

const OPTIONS = { storageKey: 'k', defaultWidth: 270, min: 170, max: 480 };

beforeEach(() => {
  rafQueue = new Map();
  nextRafId = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextRafId++;
    rafQueue.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafQueue.delete(id);
  });
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  // No component instance exists in these unit tests; silence Vue's
  // "onBeforeUnmount is called when there is no active component" warning.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useResizable', () => {
  it('falls back to the default width and restores a stored one', () => {
    expect(useResizable(OPTIONS).width.value).toBe(270);
    store.set('k', '300');
    expect(useResizable(OPTIONS).width.value).toBe(300);
  });

  it('clamps a stored width into [min, max]', () => {
    store.set('k', '600');
    expect(useResizable(OPTIONS).width.value).toBe(480);
    store.set('k', '10');
    expect(useResizable(OPTIONS).width.value).toBe(170);
  });

  it('clamps the committed width when a reactive cap shrinks', async () => {
    const cap = ref(480);
    const r = useResizable({ ...OPTIONS, max: cap });
    r.setWidth(400);
    expect(r.width.value).toBe(400);
    cap.value = 300;
    await nextTick();
    expect(r.width.value).toBe(300);
    expect(store.get('k')).toBe('300');
  });

  it('clamps the committed width when a reactive floor grows', async () => {
    const floor = ref(170);
    const r = useResizable({ ...OPTIONS, min: floor });
    r.setWidth(200);
    expect(r.width.value).toBe(200);
    floor.value = 250;
    await nextTick();
    expect(r.width.value).toBe(250);
    expect(store.get('k')).toBe('250');
    // The live floor also binds drag frames.
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));
    handle.fire('pointermove', -1000);
    flushFrame();
    expect(r.width.value).toBe(250);
    handle.fire('pointerup', -1000);
  });

  it('re-clamps the session width on a no-move drag end after the bounds changed mid-drag', async () => {
    const cap = ref(480);
    const r = useResizable({ ...OPTIONS, max: cap });
    r.setWidth(400); // commits and persists 400
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));
    cap.value = 300; // the cap shrinks while the handle is held…
    await nextTick();
    expect(r.width.value).toBe(400); // …the watcher skips mid-drag updates
    handle.fire('pointerup', 100); // zero displacement
    expect(r.width.value).toBe(300); // session value re-clamped to the live cap
    expect(store.get('k')).toBe('400'); // persisted preference untouched
  });

  it('coalesces a burst of pointermove events into one update per frame', () => {
    const r = useResizable(OPTIONS);
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));
    expect(r.dragging.value).toBe(true);

    handle.fire('pointermove', 120);
    handle.fire('pointermove', 160);
    // Nothing is applied before the frame runs, and only one frame is pending.
    expect(r.width.value).toBe(270);
    expect(rafQueue.size).toBe(1);

    flushFrame();
    // Latest position wins: 270 + (160 - 100).
    expect(r.width.value).toBe(330);
  });

  it('resizes relative to the drag start and honors reverse', () => {
    const r = useResizable({ ...OPTIONS, reverse: true });
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));
    handle.fire('pointermove', 160); // dragging right shrinks in reverse mode
    flushFrame();
    expect(r.width.value).toBe(210);
  });

  it('clamps the dragged width to [min, max]', () => {
    const r = useResizable(OPTIONS);
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));
    handle.fire('pointermove', 1000);
    flushFrame();
    expect(r.width.value).toBe(480);
    handle.fire('pointermove', -1000);
    flushFrame();
    expect(r.width.value).toBe(170);
  });

  it('writes localStorage once on pointerup, not per move', () => {
    const r = useResizable(OPTIONS);
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));
    handle.fire('pointermove', 160);
    flushFrame();
    expect(store.has('k')).toBe(false);

    handle.fire('pointerup', 160);
    expect(store.get('k')).toBe('330');
  });

  it('commits the release position when pointerup beats the pending frame', () => {
    const r = useResizable(OPTIONS);
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));
    handle.fire('pointermove', 160);
    // Frame still pending — pointerup must apply it synchronously and cancel.
    handle.fire('pointerup', 160);
    expect(r.width.value).toBe(330);
    expect(rafQueue.size).toBe(0);
    expect(r.dragging.value).toBe(false);
  });

  it('ignores moves after the drag ends', () => {
    const r = useResizable(OPTIONS);
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));
    handle.fire('pointerup', 100);
    handle.fire('pointermove', 400);
    expect(rafQueue.size).toBe(0);
    expect(r.width.value).toBe(270);
  });

  it('setWidth clamps and persists immediately', () => {
    const r = useResizable(OPTIONS);
    r.setWidth(999);
    expect(r.width.value).toBe(480);
    expect(store.get('k')).toBe('480');
  });

  it('persist gate: the session value updates but nothing is stored while gated off', () => {
    const allowed = ref(false);
    const r = useResizable({ ...OPTIONS, persist: () => allowed.value });
    r.setWidth(300);
    expect(r.width.value).toBe(300); // session value applies…
    expect(store.has('k')).toBe(false); // …but nothing is persisted
    allowed.value = true;
    r.setWidth(320);
    expect(store.get('k')).toBe('320'); // gate open again → writes resume
  });

  it('persist gate: a drag commit is held back while gated off', () => {
    const r = useResizable({ ...OPTIONS, persist: () => false });
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));
    handle.fire('pointermove', 160);
    flushFrame();
    handle.fire('pointerup', 160);
    expect(r.width.value).toBe(330); // drag still lands in-session
    expect(store.has('k')).toBe(false);
  });

  it('applyLive: drag frames bypass the ref and commit once on pointerup', () => {
    const live: number[] = [];
    const r = useResizable({ ...OPTIONS, applyLive: (w: number) => live.push(w) });
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));

    handle.fire('pointermove', 130);
    handle.fire('pointermove', 160);
    flushFrame();
    expect(live).toEqual([330]); // coalesced to the latest position
    expect(r.width.value).toBe(270); // ref untouched mid-drag
    expect(store.has('k')).toBe(false);

    handle.fire('pointermove', 200);
    handle.fire('pointerup', 200); // beats the pending frame
    expect(live).toEqual([330, 370]); // release position applied synchronously
    expect(r.width.value).toBe(370); // single commit on drag end
    expect(store.get('k')).toBe('370');
    expect(r.dragging.value).toBe(false);
  });

  it('applyLive: clamps live widths and commits the start width on a no-move drag', () => {
    const live: number[] = [];
    const r = useResizable({ ...OPTIONS, applyLive: (w: number) => live.push(w) });
    const handle = fakeHandle();

    r.onPointerDown(pointerDown(handle.el, 100));
    handle.fire('pointermove', -1000);
    flushFrame();
    expect(live).toEqual([170]); // clamped to min
    handle.fire('pointerup', -1000);
    expect(r.width.value).toBe(170);
    expect(store.get('k')).toBe('170');

    live.length = 0;
    r.onPointerDown(pointerDown(handle.el, 100));
    handle.fire('pointerup', 100); // no move at all
    expect(live).toEqual([]);
    expect(r.width.value).toBe(170); // unchanged start width
    expect(store.get('k')).toBe('170');
  });

  it('a click without effective displacement commits nothing (ref path)', () => {
    const r = useResizable(OPTIONS);
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));
    handle.fire('pointermove', 100); // zero-delta move
    flushFrame();
    handle.fire('pointerup', 100);
    expect(r.width.value).toBe(270);
    expect(store.has('k')).toBe(false); // no persistence without a real drag
  });

  it('applyLive: a click without effective displacement commits nothing', () => {
    const live: number[] = [];
    const r = useResizable({ ...OPTIONS, applyLive: (w: number) => live.push(w) });
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));
    handle.fire('pointermove', 100); // zero-delta move
    flushFrame();
    expect(live).toEqual([270]); // frame ran, value unchanged
    handle.fire('pointerup', 100);
    expect(r.width.value).toBe(270);
    expect(store.has('k')).toBe(false); // no persistence without a real drag
  });

  it('cursor hints the one direction that still resizes at a limit', () => {
    const r = useResizable(OPTIONS);
    expect(r.cursor.value).toBe('col-resize'); // mid-range

    r.setWidth(480); // at max: eastward is exhausted, only west works
    expect(r.cursor.value).toBe('w-resize');
    r.setWidth(170); // at min: only east works
    expect(r.cursor.value).toBe('e-resize');
  });

  it('cursor flips with reverse and stays neutral when no direction works', () => {
    const r = useResizable({ ...OPTIONS, reverse: true });
    r.setWidth(480); // reverse: growing is westward — at max only east works
    expect(r.cursor.value).toBe('e-resize');
    r.setWidth(170); // at min only west works
    expect(r.cursor.value).toBe('w-resize');

    const stuck = useResizable({ storageKey: 'stuck', defaultWidth: 200, min: 200, max: 200 });
    expect(stuck.cursor.value).toBe('col-resize');
  });

  it('cursor tracks the live drag width even when the ref is bypassed (applyLive)', () => {
    // Regression: the handle's own cursor style always beats what it inherits
    // from <body>, so on the applyLive path (ref stale until drag end) the
    // cursor must follow the live drag width instead.
    const bodyStyle = { cursor: '', userSelect: '' };
    vi.stubGlobal('document', { body: { style: bodyStyle } });

    const r = useResizable({ ...OPTIONS, applyLive: () => {} });
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));
    expect(bodyStyle.cursor).toBe('col-resize');

    handle.fire('pointermove', 1000); // past max
    flushFrame();
    expect(r.width.value).toBe(270); // ref still untouched on the live path…
    expect(r.cursor.value).toBe('w-resize'); // …but the cursor already flipped
    expect(bodyStyle.cursor).toBe('w-resize');

    handle.fire('pointerup', 1000);
    expect(r.width.value).toBe(480); // committed on drag end…
    expect(r.cursor.value).toBe('w-resize'); // …and the cursor still agrees
    expect(bodyStyle.cursor).toBe(''); // body cursor cleared
  });

  it('axis y: drags with clientY, reverse grows upward, and uses row cursors', () => {
    const listeners = new Map<string, Array<(event: { clientY: number }) => void>>();
    const el = {
      addEventListener: (type: string, cb: (event: { clientY: number }) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), cb]);
      },
      removeEventListener: (type: string, cb: (event: { clientY: number }) => void) => {
        listeners.set(type, (listeners.get(type) ?? []).filter((fn) => fn !== cb));
      },
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
    } as unknown as HTMLElement;
    const fire = (type: string, clientY: number) => {
      for (const cb of listeners.get(type) ?? []) cb({ clientY });
    };
    const down = { preventDefault: () => {}, clientY: 300, currentTarget: el, pointerId: 1 } as unknown as PointerEvent;

    // Bottom-panel shape: axis y + reverse — dragging UP (smaller clientY) grows.
    const r = useResizable({ ...OPTIONS, axis: 'y', reverse: true });
    expect(r.cursor.value).toBe('row-resize');
    r.onPointerDown(down);
    fire('pointermove', 240); // 60px up → grows 60
    flushFrame();
    expect(r.width.value).toBe(330);
    fire('pointermove', 1000); // way down → clamped to min
    flushFrame();
    expect(r.width.value).toBe(170);
    expect(r.cursor.value).toBe('n-resize'); // at min: only upward (grow) works
    fire('pointerup', 1000);

    r.setWidth(480); // at max: only downward (shrink) works
    expect(r.cursor.value).toBe('s-resize');
  });
});
