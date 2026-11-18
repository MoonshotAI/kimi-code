import { effectScope, nextTick, ref, shallowRef, type EffectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWrapReorderDrag } from '../src/composables/useWrapReorderDrag';
import { movedOrder, wrapDropIndex, wrapLayout, wrapPreviewOffsets } from '../src/lib/wrapReorder';

const frame = { left: 0, top: 0, right: 200, columnGap: 4, rowGap: 4 };
const slots = [
  { id: 'a', left: 0, top: 0, width: 60, height: 30 },
  { id: 'b', left: 64, top: 0, width: 80, height: 30 },
  { id: 'c', left: 148, top: 0, width: 50, height: 30 },
  { id: 'd', left: 0, top: 34, width: 70, height: 30 },
];

describe('wrap reorder layout', () => {
  it('wraps items that overflow the row', () => {
    expect(wrapLayout(slots, frame)).toEqual([
      { left: 0, top: 0 },
      { left: 64, top: 0 },
      { left: 148, top: 0 },
      { left: 0, top: 34 },
    ]);
  });

  it('drops a wide item where it sits against the field edge', () => {
    const wide = { left: 0, top: 0, right: 400, columnGap: 4, rowGap: 4 };
    const pair = [
      { id: 'n', left: 0, top: 0, width: 156, height: 30 },
      { id: 'w', left: 160, top: 0, width: 235, height: 30 },
    ];
    expect(wrapDropIndex(pair, 1, { x: -160, y: 0 }, wide)).toBe(0);
    expect(wrapDropIndex(pair, 1, { x: -70, y: 0 }, wide)).toBe(1);
    expect(wrapDropIndex(pair, 0, { x: 0, y: 0 }, wide)).toBe(0);
    expect(wrapDropIndex(pair, 0, { x: 100, y: 0 }, wide)).toBe(0);
    expect(wrapDropIndex(pair, 0, { x: 200, y: 0 }, wide)).toBe(1);
  });

  it('drops into the first slot of a wrapped row', () => {
    const rows = [...slots.slice(0, 3), { id: 'd', left: 0, top: 34, width: 40, height: 30 }, { id: 'e', left: 44, top: 34, width: 100, height: 30 }];
    expect(wrapDropIndex(rows, 4, { x: 0, y: 0 }, frame)).toBe(4);
    expect(wrapDropIndex(rows, 4, { x: -44, y: 0 }, frame)).toBe(3);
    expect(wrapDropIndex(rows, 3, { x: 0, y: -34 }, frame)).toBe(0);
    expect(wrapDropIndex(rows, 0, { x: 0, y: 34 }, frame)).toBe(3);
  });

  it('moves items within bounds', () => {
    expect(movedOrder(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(movedOrder(['a', 'b', 'c'], 2, -5)).toEqual(['c', 'a', 'b']);
    expect(movedOrder(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
  });

  it('previews neighbours sliding across rows', () => {
    expect(wrapPreviewOffsets(slots, 0, 3, frame)).toEqual([
      { x: 74, y: 34 },
      { x: -64, y: 0 },
      { x: -64, y: 0 },
      { x: 0, y: 0 },
    ]);
    expect(wrapPreviewOffsets(slots, 3, 1, frame)).toEqual([
      { x: 0, y: 0 },
      { x: -64, y: 34 },
      { x: -64, y: 34 },
      { x: 64, y: -34 },
    ]);
  });
});

class Element extends EventTarget {
  dataset: Record<string, string> = {};
  capture: number | null = null;
  children: Element[] = [];
  item: Element | null = null;
  constructor(readonly bounds: () => { left: number; top: number; width: number; height: number }) { super(); }
  getBoundingClientRect() { return this.bounds(); }
  querySelectorAll() { return this.children; }
  closest() { return this.item ?? this; }
  blur() {}
  hasPointerCapture(id: number) { return this.capture === id; }
  setPointerCapture(id: number) { this.capture = id; }
  releasePointerCapture() { this.capture = null; this.dispatchEvent(new Event('lostpointercapture')); }
}

let frames: Map<number, FrameRequestCallback>;
let sequence: number;
let scopes: EffectScope[];

beforeEach(() => {
  frames = new Map();
  sequence = 0;
  scopes = [];
  vi.stubGlobal('HTMLElement', Element);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('getComputedStyle', () => ({ columnGap: '4px', rowGap: '4px', paddingRight: '0px', borderRightWidth: '0px' }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
});

afterEach(() => {
  for (const scope of scopes) scope.stop();
  vi.unstubAllGlobals();
});

function step() {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(0);
}

function pointer(type: string, x: number, y: number) {
  window.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { pointerId: 1, clientX: x, clientY: y }));
}

function setup() {
  const container = new Element(() => ({ left: 100, top: 100, width: 200, height: 64 }));
  container.children = slots.map((slot) => {
    const element = new Element(() => ({ left: 100 + slot.left, top: 100 + slot.top, width: slot.width, height: slot.height }));
    element.dataset['reorderId'] = slot.id;
    return element;
  });
  const ids = ref(slots.map(({ id }) => id));
  const move = vi.fn();
  const scope = effectScope();
  scopes.push(scope);
  const drag = scope.run(() => useWrapReorderDrag({ ids: () => ids.value, container: shallowRef(container as unknown as HTMLElement), move }))!;
  function down(index: number, x: number, y: number) {
    drag.onPointerDown({ currentTarget: container.children[index]!, pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y } as unknown as PointerEvent, slots[index]!.id);
  }
  return { drag, ids, move, down };
}

describe('wrap reorder drag', () => {
  it('follows the pointer, slides neighbours and commits on drop', () => {
    const { drag, move, down } = setup();
    down(0, 130, 115);
    pointer('pointermove', 132, 116);
    expect(drag.draggingId.value).toBeNull();
    pointer('pointermove', 140, 115);
    expect(drag.draggingId.value).toBe('a');
    expect(drag.styleFor('a')).toEqual({ transform: 'translate3d(10px, 0px, 0)' });
    expect(drag.styleFor('b')).toEqual({ transform: 'translate3d(0px, 0px, 0)' });
    pointer('pointermove', 200, 150);
    step();
    expect(drag.dropIndex.value).toBe(3);
    expect(drag.styleFor('a')).toEqual({ transform: 'translate3d(70px, 34px, 0)' });
    expect(drag.styleFor('b')).toEqual({ transform: 'translate3d(-64px, 0px, 0)' });
    pointer('pointerup', 200, 150);
    expect(move).toHaveBeenCalledWith('a', 3);
    expect(drag.draggingId.value).toBeNull();
    expect(drag.styleFor('b')).toBeUndefined();
    expect(drag.consumeClick()).toBe(true);
  });

  it('keeps the dragged item inside the field', () => {
    const { drag, down } = setup();
    down(1, 170, 115);
    pointer('pointermove', 600, -300);
    step();
    expect(drag.styleFor('b')).toEqual({ transform: 'translate3d(56px, 0px, 0)' });
  });

  it('cancels on Escape without moving', () => {
    const { drag, move, down } = setup();
    down(3, 130, 150);
    pointer('pointermove', 170, 115);
    step();
    expect(drag.dropIndex.value).toBe(1);
    window.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape', isComposing: false }));
    expect(drag.draggingId.value).toBeNull();
    pointer('pointerup', 170, 115);
    expect(move).not.toHaveBeenCalled();
  });

  it('cancels when the items change mid drag', async () => {
    const { drag, ids, move, down } = setup();
    down(0, 130, 115);
    pointer('pointermove', 200, 150);
    ids.value = ['b', 'c', 'd'];
    await nextTick();
    expect(drag.draggingId.value).toBeNull();
    pointer('pointerup', 200, 150);
    expect(move).not.toHaveBeenCalled();
  });
});
