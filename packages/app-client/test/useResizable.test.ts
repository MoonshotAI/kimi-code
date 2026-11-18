import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { useResizable } from '../src/composables';

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

  it('clamps the width without storing it when a reactive cap shrinks, and restores it when the cap grows', async () => {
    const cap = ref(480);
    const r = useResizable({ ...OPTIONS, max: cap });
    r.setWidth(400);
    expect(r.width.value).toBe(400);
    cap.value = 300;
    await nextTick();
    expect(r.width.value).toBe(300);
    expect(store.get('k')).toBe('400');
    cap.value = 480;
    await nextTick();
    expect(r.width.value).toBe(400);
    expect(store.get('k')).toBe('400');
  });

  it('clamps the committed width when a reactive floor grows', async () => {
    const floor = ref(170);
    const r = useResizable({ ...OPTIONS, min: floor });
    r.setWidth(200);
    expect(r.width.value).toBe(200);
    floor.value = 250;
    await nextTick();
    expect(r.width.value).toBe(250);
    expect(store.get('k')).toBe('200');
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
    r.setWidth(400);
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));
    cap.value = 300;
    await nextTick();
    expect(r.width.value).toBe(400);
    handle.fire('pointerup', 100);
    expect(r.width.value).toBe(300);
    expect(store.get('k')).toBe('400');
  });

  it('coalesces a burst of pointermove events into one update per frame', () => {
    const r = useResizable(OPTIONS);
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));
    expect(r.dragging.value).toBe(true);

    handle.fire('pointermove', 120);
    handle.fire('pointermove', 160);
    expect(r.width.value).toBe(270);
    expect(rafQueue.size).toBe(1);

    flushFrame();
    expect(r.width.value).toBe(330);
  });

  it('resizes relative to the drag start and honors reverse', () => {
    const r = useResizable({ ...OPTIONS, reverse: true });
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));
    handle.fire('pointermove', 160);
    flushFrame();
    expect(r.width.value).toBe(210);
  });

  it('follows a reactive reverse that flips after setup', () => {
    const reverse = ref(true);
    const r = useResizable({ ...OPTIONS, reverse });
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));
    handle.fire('pointermove', 160);
    flushFrame();
    expect(r.width.value).toBe(210);
    handle.fire('pointerup', 160);

    reverse.value = false;
    r.onPointerDown(pointerDown(handle.el, 100));
    handle.fire('pointermove', 160);
    flushFrame();
    expect(r.width.value).toBe(270);
    handle.fire('pointerup', 160);
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
    expect(r.width.value).toBe(300);
    expect(store.has('k')).toBe(false);
    allowed.value = true;
    r.setWidth(320);
    expect(store.get('k')).toBe('320');
  });

  it('persist gate: a drag commit is held back while gated off', () => {
    const r = useResizable({ ...OPTIONS, persist: () => false });
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));
    handle.fire('pointermove', 160);
    flushFrame();
    handle.fire('pointerup', 160);
    expect(r.width.value).toBe(330);
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
    expect(live).toEqual([330]);
    expect(r.width.value).toBe(270);
    expect(store.has('k')).toBe(false);

    handle.fire('pointermove', 200);
    handle.fire('pointerup', 200);
    expect(live).toEqual([330, 370]);
    expect(r.width.value).toBe(370);
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
    expect(live).toEqual([170]);
    handle.fire('pointerup', -1000);
    expect(r.width.value).toBe(170);
    expect(store.get('k')).toBe('170');

    live.length = 0;
    r.onPointerDown(pointerDown(handle.el, 100));
    handle.fire('pointerup', 100);
    expect(live).toEqual([]);
    expect(r.width.value).toBe(170);
    expect(store.get('k')).toBe('170');
  });

  it('a click without effective displacement commits nothing (ref path)', () => {
    const r = useResizable(OPTIONS);
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));
    handle.fire('pointermove', 100);
    flushFrame();
    handle.fire('pointerup', 100);
    expect(r.width.value).toBe(270);
    expect(store.has('k')).toBe(false);
  });

  it('applyLive: a click without effective displacement commits nothing', () => {
    const live: number[] = [];
    const r = useResizable({ ...OPTIONS, applyLive: (w: number) => live.push(w) });
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));
    handle.fire('pointermove', 100);
    flushFrame();
    expect(live).toEqual([270]);
    handle.fire('pointerup', 100);
    expect(r.width.value).toBe(270);
    expect(store.has('k')).toBe(false);
  });

  it('cursor hints the one direction that still resizes at a limit', () => {
    const r = useResizable(OPTIONS);
    expect(r.cursor.value).toBe('col-resize');

    r.setWidth(480);
    expect(r.cursor.value).toBe('w-resize');
    r.setWidth(170);
    expect(r.cursor.value).toBe('e-resize');
  });

  it('cursor flips with reverse and stays neutral when no direction works', () => {
    const r = useResizable({ ...OPTIONS, reverse: true });
    r.setWidth(480);
    expect(r.cursor.value).toBe('e-resize');
    r.setWidth(170);
    expect(r.cursor.value).toBe('w-resize');

    const stuck = useResizable({ storageKey: 'stuck', defaultWidth: 200, min: 200, max: 200 });
    expect(stuck.cursor.value).toBe('col-resize');
  });

  it('cursor tracks the live drag width even when the ref is bypassed (applyLive)', () => {
    const shields: Array<{ className: string; style: { cursor: string }; remove: () => void; removed: boolean }> = [];
    vi.stubGlobal('document', {
      createElement: () => {
        const shield = { className: '', style: { cursor: '' }, removed: false, remove: () => { shield.removed = true; }, addEventListener: () => {} };
        shields.push(shield);
        return shield;
      },
      body: { append: () => {} },
    });

    const r = useResizable({ ...OPTIONS, applyLive: () => {} });
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));
    expect(shields).toHaveLength(1);
    expect(shields[0]!.className).toBe('resize-drag-shield');
    expect(shields[0]!.style.cursor).toBe('col-resize');

    handle.fire('pointermove', 1000);
    flushFrame();
    expect(r.width.value).toBe(270);
    expect(r.cursor.value).toBe('w-resize');
    expect(shields[0]!.style.cursor).toBe('w-resize');

    handle.fire('pointerup', 1000);
    expect(r.width.value).toBe(480);
    expect(r.cursor.value).toBe('w-resize');
    expect(shields[0]!.removed).toBe(true);
  });

  it('ends a drag whose release never reached the handle', () => {
    const shieldListeners = new Map<string, () => void>();
    const shield = { className: '', style: { cursor: '' }, removed: false, remove: () => { shield.removed = true; }, addEventListener: (type: string, cb: () => void) => { shieldListeners.set(type, cb); } };
    vi.stubGlobal('document', { createElement: () => shield, body: { append: () => {} } });

    const r = useResizable({ ...OPTIONS, applyLive: () => {} });
    const handle = fakeHandle();
    r.onPointerDown(pointerDown(handle.el, 100));
    expect(r.dragging.value).toBe(true);
    shieldListeners.get('pointerdown')!();
    expect(r.dragging.value).toBe(false);
    expect(shield.removed).toBe(true);

    r.onPointerDown(pointerDown(handle.el, 100));
    handle.fire('pointermove', 200);
    expect(r.dragging.value).toBe(true);
    handle.fire('lostpointercapture', 0);
    expect(r.dragging.value).toBe(false);
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

    const r = useResizable({ ...OPTIONS, axis: 'y', reverse: true });
    expect(r.cursor.value).toBe('row-resize');
    r.onPointerDown(down);
    fire('pointermove', 240);
    flushFrame();
    expect(r.width.value).toBe(330);
    fire('pointermove', 1000);
    flushFrame();
    expect(r.width.value).toBe(170);
    expect(r.cursor.value).toBe('n-resize');
    fire('pointerup', 1000);

    r.setWidth(480);
    expect(r.cursor.value).toBe('s-resize');
  });
});
