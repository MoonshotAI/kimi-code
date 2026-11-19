import { effectScope, nextTick, ref, shallowRef, type EffectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePanelTabDrag } from '../src/composables/usePanelTabDrag';
import { panelTabDropIndex, panelTabInsertLeft, reorderedPanelTabs, panelTabPreviewOffset, panelTabScrollSpeed, panelTabSlotStart } from '../src/lib/panelTabDrag';

const slots = [
  { id: 'a', start: 0, size: 80 },
  { id: 'b', start: 84, size: 160 },
  { id: 'c', start: 248, size: 100 },
  { id: 'd', start: 352, size: 180 },
];

class Element extends EventTarget {
  dataset: Record<string, string> = {};
  scrollLeft = 0;
  scrollWidth = 532;
  clientWidth = 180;
  isConnected = true;
  capture: number | null = null;
  children: Element[] = [];
  tab: Element | null = null;
  style: Record<string, string> = {};
  classes = new Set<string>();
  attributes = new Map<string, string>();
  parent: Element[] | null = null;
  classList = { add: (...names: string[]) => names.forEach(name => this.classes.add(name)), remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)) };
  constructor(readonly bounds: () => { left: number; right: number; top: number; bottom: number; width: number; height: number }) { super(); }
  getBoundingClientRect() { return this.bounds(); }
  querySelectorAll() { return this.children; }
  closest() { return this.tab ?? this; }
  blur() {}
  cloneNode() { const clone = new Element(this.bounds); clone.dataset = { ...this.dataset }; return clone; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  remove() { this.parent?.splice(this.parent.indexOf(this), 1); this.parent = null; }
  hasPointerCapture(id: number) { return this.capture === id; }
  setPointerCapture(id: number) { this.capture = id; }
  releasePointerCapture() { this.capture = null; this.dispatchEvent(new Event('lostpointercapture')); }
}

let frames: Map<number, FrameRequestCallback>;
let sequence: number;
let time: number;
let scopes: EffectScope[];
let ghosts: Element[];

beforeEach(() => {
  frames = new Map();
  sequence = 0;
  time = 0;
  scopes = [];
  ghosts = [];
  vi.stubGlobal('document', { body: { append: (element: Element) => { element.parent = ghosts; ghosts.push(element); } } });
  vi.stubGlobal('HTMLElement', Element);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('getComputedStyle', () => ({ columnGap: '4px' }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
});

afterEach(() => {
  for (const scope of scopes) scope.stop();
  vi.unstubAllGlobals();
});

function step(milliseconds = 1000 / 60) {
  time += milliseconds;
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(time);
}

function event(type: string, x: number, y = 30, pointerId = 1) {
  window.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { pointerId, clientX: x, clientY: y }));
}

function setup(external?: Parameters<typeof usePanelTabDrag>[0]['external']) {
  const container = new Element(() => ({ left: 100, right: 280, top: 10, bottom: 50, width: 180, height: 40 }));
  container.children = slots.map(slot => {
    const element = new Element(() => ({ left: 100 + slot.start - container.scrollLeft, right: 100 + slot.start + slot.size - container.scrollLeft, top: 15, bottom: 45, width: slot.size, height: 30 }));
    element.dataset['panelTabId'] = slot.id;
    return element;
  });
  const tabs = ref(slots.map(({ id }) => ({ id })));
  const enabled = ref(true);
  const move = vi.fn();
  const scope = effectScope();
  scopes.push(scope);
  const drag = scope.run(() => usePanelTabDrag({ tabs: () => tabs.value, container: shallowRef(container as unknown as HTMLElement), enabled: () => enabled.value, move, external }))!;
  function down(index: number, x: number, pointerType = 'mouse') {
    const tab = container.children[index]!;
    drag.onPointerDown({ currentTarget: tab, pointerType, pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: 30 } as unknown as PointerEvent, slots[index]!.id);
  }
  return { container, tabs, enabled, move, drag, down };
}

describe('panel tab drag preview', () => {
  it('leaves touch gestures to native horizontal scrolling', () => {
    const { down, drag, move, container } = setup();
    down(0, 120, 'touch');
    event('pointermove', 260);
    step();
    event('pointerup', 260);
    expect(drag.draggingId.value).toBeNull();
    expect(container.children[0]?.capture).toBeNull();
    expect(move).not.toHaveBeenCalled();
  });

  it('keeps real order unchanged while the dragged tab follows the pointer and neighbors make space', () => {
    const { drag, down, move } = setup();
    down(0, 120);
    event('pointermove', 123);
    expect(drag.draggingId.value).toBeNull();
    event('pointermove', 279);
    expect(drag.styleFor('a')).toMatchObject({ width: '80px', transform: 'translate3d(159px, 0, 0)' });
    expect(drag.styleFor('b')?.transform).toBe('translate3d(-84px, 0, 0)');
    expect(drag.styleFor('c')?.transform).toBe('translate3d(0px, 0, 0)');
    expect(move).not.toHaveBeenCalled();
    event('pointerup', 279);
    expect(move).toHaveBeenCalledExactlyOnceWith('a', 1);
    expect(drag.consumeClick()).toBe(true);
    expect(drag.consumeClick()).toBe(false);
  });

  it('scrolls to hidden tabs with the pointer beyond the right edge and commits only on release', () => {
    const { container, drag, down, move } = setup();
    down(0, 120);
    event('pointermove', 340);
    for (let i = 0; i < 90; i += 1) step();
    expect(container.scrollLeft).toBe(352);
    expect(frames.size).toBe(0);
    expect(drag.styleFor('a')?.transform).toBe('translate3d(452px, 0, 0)');
    expect(move).not.toHaveBeenCalled();
    event('pointerup', 340);
    expect(move).toHaveBeenCalledExactlyOnceWith('a', 3);
  });

  it('scrolls back across hidden tabs at the left edge', () => {
    const { container, down, move } = setup();
    container.scrollLeft = 352;
    down(3, 140);
    event('pointermove', 80);
    for (let i = 0; i < 90; i += 1) step();
    expect(container.scrollLeft).toBe(0);
    event('pointerup', 80);
    expect(move).toHaveBeenCalledExactlyOnceWith('d', 0);
  });

  it('keeps edge scrolling speed independent of display refresh rate', () => {
    const first = setup();
    first.container.scrollWidth = 5000;
    first.down(0, 120);
    event('pointermove', 340);
    for (let i = 0; i < 60; i += 1) step(1000 / 60);
    const at60Hz = first.container.scrollLeft;
    window.dispatchEvent(new Event('blur'));
    const second = setup();
    second.container.scrollWidth = 5000;
    second.down(0, 120);
    event('pointermove', 340);
    for (let i = 0; i < 120; i += 1) step(1000 / 120);
    expect(at60Hz).toBeCloseTo(720);
    expect(Math.abs(second.container.scrollLeft - at60Hz)).toBeLessThan(12);
  });

  it('accounts for manual scrolling without pointer motion', () => {
    const { container, down, drag } = setup();
    down(0, 120);
    event('pointermove', 180);
    step();
    expect(drag.styleFor('a')?.transform).toBe('translate3d(60px, 0, 0)');
    container.scrollLeft = 100;
    container.dispatchEvent(new Event('scroll'));
    step();
    expect(drag.styleFor('a')?.transform).toBe('translate3d(160px, 0, 0)');
  });

  it('stops scrolling when the pointer leaves the bar vertically and cancels the drop', () => {
    const { container, down, move } = setup();
    down(0, 120);
    event('pointermove', 340);
    step();
    const scrolled = container.scrollLeft;
    event('pointermove', 340, 100);
    step();
    expect(container.scrollLeft).toBe(scrolled);
    expect(frames.size).toBe(0);
    event('pointerup', 340, 100);
    expect(move).not.toHaveBeenCalled();
  });

  it('reorders only while the pointer stays within the bar band and restores the order outside it', () => {
    const { drag, down, move } = setup();
    down(0, 120);
    event('pointermove', 279);
    expect(drag.styleFor('b')?.transform).toBe('translate3d(-84px, 0, 0)');
    event('pointermove', 279, 66);
    step();
    expect(drag.styleFor('b')?.transform).toBe('translate3d(-84px, 0, 0)');
    event('pointermove', 279, 120);
    step();
    expect(drag.styleFor('a')).toMatchObject({ transform: 'translate3d(0px, 0, 0)', opacity: 'var(--opacity-hint)' });
    expect(drag.styleFor('b')?.transform).toBe('translate3d(0px, 0, 0)');
    expect(drag.indicatorLeft.value).toBeNull();
    event('pointermove', 279, 30);
    step();
    expect(drag.styleFor('b')?.transform).toBe('translate3d(-84px, 0, 0)');
    expect(drag.styleFor('a')?.opacity).toBeUndefined();
    event('pointermove', 279, 120);
    step();
    event('pointerup', 279, 120);
    expect(move).not.toHaveBeenCalled();
  });

  it('shows a ghost of the tab that follows the pointer outside the bar', () => {
    const { drag, down } = setup();
    down(0, 120);
    event('pointermove', 200, 300);
    expect(drag.preview.value).toEqual({ x: 180, y: 285 });
    expect(ghosts).toHaveLength(1);
    const ghost = ghosts[0]!;
    expect(ghost.classes.has('is-drag-ghost')).toBe(true);
    expect(ghost.attributes.get('aria-hidden')).toBe('true');
    expect(ghost.style).toMatchObject({ position: 'fixed', width: '80px', height: '30px', pointerEvents: 'none', transform: 'translate3d(180px, 285px, 0)' });
    event('pointermove', 250, 400);
    step();
    expect(drag.preview.value).toEqual({ x: 230, y: 385 });
    expect(ghosts).toEqual([ghost]);
    expect(ghost.style['transform']).toBe('translate3d(230px, 385px, 0)');
    event('pointermove', 250, 30);
    step();
    expect(drag.preview.value).toBeNull();
    expect(ghosts).toHaveLength(0);
    event('pointermove', 250, 400);
    step();
    expect(ghosts).toHaveLength(1);
    event('pointerup', 250, 400);
    expect(drag.preview.value).toBeNull();
    expect(ghosts).toHaveLength(0);
  });

  it('resumes edge scrolling when the pointer returns from outside the bar to an edge and holds still', () => {
    const { container, down } = setup();
    down(0, 120);
    event('pointermove', 200, 120);
    step();
    event('pointermove', 275, 30);
    step();
    expect(frames.size).toBe(1);
    for (let i = 0; i < 90; i += 1) step();
    expect(container.scrollLeft).toBe(352);
  });

  it('cancels previews on Escape, collection changes, or hiding the bar', async () => {
    const { drag, down, tabs, enabled, move } = setup();
    down(0, 120);
    event('pointermove', 260);
    window.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape', isComposing: false }));
    expect(drag.draggingId.value).toBeNull();
    down(0, 120);
    event('pointermove', 260);
    tabs.value = tabs.value.slice(1);
    await nextTick();
    expect(drag.draggingId.value).toBeNull();
    tabs.value = slots.map(({ id }) => ({ id }));
    await nextTick();
    down(0, 120);
    event('pointermove', 260);
    enabled.value = false;
    await nextTick();
    expect(drag.draggingId.value).toBeNull();
    expect(move).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });
});

describe('dragging a tab onto another panel', () => {
  function externalSetup() {
    const external = {
      hover: vi.fn((_x: number, y: number) => (y > 100 ? 2 : null)),
      commit: vi.fn(),
      clear: vi.fn(),
    };
    return { external, ...setup(external) };
  }

  it('hands the tab to the external target on release instead of reordering', () => {
    const { external, move, drag, down } = externalSetup();
    down(0, 110);
    event('pointermove', 240);
    step();
    expect(drag.indicatorLeft.value).not.toBeNull();
    event('pointermove', 240, 90);
    step();
    expect(drag.preview.value).toEqual({ x: 230, y: 75 });
    event('pointermove', 240, 150);
    step();
    expect(drag.indicatorLeft.value).toBeNull();
    expect(drag.preview.value).toEqual({ x: 230, y: 135 });
    event('pointerup', 240, 150);
    expect(external.hover).toHaveBeenCalledWith(240, 150, 'a');
    expect(external.commit).toHaveBeenCalledWith('a', 2);
    expect(external.clear).toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });

  it('leaves everything unchanged on Escape or a release outside every target', () => {
    const { external, move, down } = externalSetup();
    down(0, 110);
    event('pointermove', 240, 150);
    step();
    window.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }));
    expect(external.clear).toHaveBeenCalled();
    down(0, 110);
    event('pointermove', 240, 80);
    step();
    event('pointerup', 240, 80);
    expect(external.commit).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });
});

describe('variable-width tab geometry', () => {
  it('places the insertion indicator between tabs and after the last one', () => {
    expect(panelTabInsertLeft(slots, 1, 4)).toBe(82);
    expect(panelTabInsertLeft(slots, 4, 4)).toBe(534);
    expect(panelTabInsertLeft([], 0, 4)).toBe(2);
  });

  it('reorders by clamped index and reports no-ops', () => {
    const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(reorderedPanelTabs(tabs, 'a', 9)?.map(tab => tab.id)).toEqual(['b', 'c', 'a']);
    expect(reorderedPanelTabs(tabs, 'c', 0)?.map(tab => tab.id)).toEqual(['c', 'a', 'b']);
    expect(reorderedPanelTabs(tabs, 'a', 0)).toBeNull();
    expect(reorderedPanelTabs(tabs, 'x', 0)).toBeNull();
  });

  it('computes destinations and offsets using the dragged width rather than the neighbor width', () => {
    expect(panelTabDropIndex(slots, 'a', 300)).toBe(2);
    expect(panelTabSlotStart(slots, 0, 2)).toBe(268);
    expect(panelTabSlotStart(slots, 3, 1)).toBe(84);
    expect(panelTabPreviewOffset(1, 3, 1, 180, 4)).toBe(184);
    expect(panelTabPreviewOffset(2, 0, 2, 80, 4)).toBe(-84);
  });

  it('ramps scrolling toward the edge and continues outside horizontal bounds', () => {
    const rect = { left: 100, right: 400, top: 10, bottom: 50 };
    expect(panelTabScrollSpeed(250, 30, rect)).toBe(0);
    expect(panelTabScrollSpeed(376, 30, rect)).toBe(360);
    expect(panelTabScrollSpeed(400, 30, rect)).toBe(720);
    expect(panelTabScrollSpeed(500, 30, rect)).toBe(720);
    expect(panelTabScrollSpeed(50, 30, rect)).toBe(-720);
    expect(panelTabScrollSpeed(500, 60, rect)).toBe(0);
  });
});
