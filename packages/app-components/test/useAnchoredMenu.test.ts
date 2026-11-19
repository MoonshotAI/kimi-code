import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { useAnchoredMenu } from '../src/composables/useAnchoredMenu';

type Listener = (event: never) => void;

const docListeners = new Map<string, Set<Listener>>();
const winListeners = new Map<string, Set<Listener>>();

function addTo(map: Map<string, Set<Listener>>, type: string, fn: Listener): void {
  const set = map.get(type) ?? new Set<Listener>();
  set.add(fn);
  map.set(type, set);
}

function fire(map: Map<string, Set<Listener>>, type: string, event: unknown): void {
  for (const fn of map.get(type) ?? []) fn(event as never);
}

function stubElement(over: {
  rect?: { left: number; bottom: number; right: number; top: number; height: number };
  size?: { width: number; height: number };
  contains?: (node: unknown) => boolean;
}) {
  const rect = over.rect ?? { left: 100, bottom: 200, right: 180, top: 170, height: 30 };
  return {
    getBoundingClientRect: () => rect,
    offsetWidth: over.size?.width ?? 200,
    offsetHeight: over.size?.height ?? 100,
    contains: (node: unknown) => over.contains?.(node) === true,
  } as unknown as HTMLElement;
}

function mouseEvent(target: unknown, over: Record<string, unknown> = {}): MouseEvent {
  return { target, ...over } as unknown as MouseEvent;
}

beforeEach(() => {
  docListeners.clear();
  winListeners.clear();
  vi.stubGlobal('Node', class FakeNode {});
  vi.stubGlobal('document', {
    addEventListener: (type: string, fn: Listener) => addTo(docListeners, type, fn),
    removeEventListener: (type: string, fn: Listener) => docListeners.get(type)?.delete(fn),
  });
  vi.stubGlobal('window', {
    innerWidth: 1000,
    innerHeight: 800,
    addEventListener: (type: string, fn: Listener) => addTo(winListeners, type, fn),
    removeEventListener: (type: string, fn: Listener) => winListeners.get(type)?.delete(fn),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(menuEl: HTMLElement) {
  const menuRef = ref<{ el?: HTMLElement | null } | null>({ el: menuEl });
  return useAnchoredMenu(menuRef);
}

describe('useAnchoredMenu placement', () => {
  it('places below the trigger when there is room', async () => {
    const menu = stubElement({});
    const { open, menuStyle, show } = setup(menu);
    const trigger = stubElement({});
    await show(mouseEvent(null, { currentTarget: trigger }));
    expect(open.value).toBe(true);
    expect(menuStyle.value).toEqual({
      top: '204px',
      left: '100px',
      transformOrigin: 'top left',
      '--menu-pop-shift': '-2px',
    });
  });

  it('flips above the trigger near the viewport bottom', async () => {
    const menu = stubElement({ size: { width: 200, height: 100 } });
    const { menuStyle, show } = setup(menu);
    const trigger = stubElement({
      rect: { left: 100, bottom: 790, right: 180, top: 760, height: 30 },
    });
    await show(mouseEvent(null, { currentTarget: trigger }));
    expect(menuStyle.value['top']).toBe('656px');
    expect(menuStyle.value['transformOrigin']).toBe('bottom left');
    expect(menuStyle.value['--menu-pop-shift']).toBe('2px');
  });

  it('aligns the right edge to the trigger and picks a right origin', async () => {
    const menu = stubElement({ size: { width: 200, height: 100 } });
    const { menuStyle, showAnchored } = setup(menu);
    const trigger = stubElement({});
    await showAnchored(mouseEvent(null, { currentTarget: trigger }), 'right');
    expect(menuStyle.value['left']).toBe('8px');
    expect(menuStyle.value['transformOrigin']).toBe('top right');
  });

  it('clamps left to the viewport margin when the menu is wider than the anchor point', async () => {
    const menu = stubElement({ size: { width: 500, height: 100 } });
    const { menuStyle, showAnchored } = setup(menu);
    const trigger = stubElement({});
    await showAnchored(mouseEvent(null, { currentTarget: trigger }), 'right');
    expect(menuStyle.value['left']).toBe('8px');
  });

  it('clamps at the right edge when the menu overflows', async () => {
    const menu = stubElement({ size: { width: 200, height: 100 } });
    const { menuStyle, show } = setup(menu);
    const trigger = stubElement({
      rect: { left: 950, bottom: 200, right: 990, top: 170, height: 30 },
    });
    await show(mouseEvent(null, { currentTarget: trigger }));
    expect(menuStyle.value['left']).toBe('792px');
  });

  it('openAt places at the cursor point', async () => {
    const menu = stubElement({});
    const { menuStyle, openAt } = setup(menu);
    await openAt(150, 250);
    expect(menuStyle.value['top']).toBe('250px');
    expect(menuStyle.value['left']).toBe('150px');
  });
});

describe('useAnchoredMenu open/close lifecycle', () => {
  it('toggle closes an open menu instead of reopening', async () => {
    const menu = stubElement({});
    const { open, toggle } = setup(menu);
    const trigger = stubElement({});
    const e = mouseEvent(null, { currentTarget: trigger });
    await toggle(e);
    expect(open.value).toBe(true);
    await toggle(e);
    expect(open.value).toBe(false);
  });

  it('show re-places an already open menu (retarget)', async () => {
    const menu = stubElement({});
    const { open, menuStyle, show } = setup(menu);
    await show(mouseEvent(null, { currentTarget: stubElement({}) }));
    const other = stubElement({
      rect: { left: 300, bottom: 500, right: 380, top: 470, height: 30 },
    });
    await show(mouseEvent(null, { currentTarget: other }));
    expect(open.value).toBe(true);
    expect(menuStyle.value['top']).toBe('504px');
    expect(menuStyle.value['left']).toBe('300px');
  });

  it('mousedown outside the menu and trigger closes', async () => {
    const menuNode = {};
    const menu = stubElement({ contains: (n) => n === menuNode });
    const { open, show } = setup(menu);
    const triggerNode = {};
    const trigger = stubElement({ contains: (n) => n === triggerNode });
    await show(mouseEvent(null, { currentTarget: trigger }));
    fire(docListeners, 'mousedown', mouseEvent(menuNode));
    expect(open.value).toBe(true);
    fire(docListeners, 'mousedown', mouseEvent(triggerNode));
    expect(open.value).toBe(true);
    fire(docListeners, 'mousedown', mouseEvent({}));
    expect(open.value).toBe(false);
  });

  it('keeps the parent open when the additional submenu is clicked', async () => {
    const parentNode = {};
    const submenuNode = {};
    const parentRef = ref<{ el?: HTMLElement | null } | null>({ el: stubElement({ contains: n => n === parentNode }) });
    const submenuRef = ref<{ el?: HTMLElement | null } | null>({ el: stubElement({ contains: n => n === submenuNode }) });
    const { open, show } = useAnchoredMenu(parentRef, submenuRef);
    await show(mouseEvent(null, { currentTarget: stubElement({}) }));
    fire(docListeners, 'mousedown', mouseEvent(submenuNode));
    expect(open.value).toBe(true);
    fire(docListeners, 'mousedown', mouseEvent({}));
    expect(open.value).toBe(false);
  });

  it('Escape and resize close the menu', async () => {
    const menu = stubElement({});
    const { open, show } = setup(menu);
    await show(mouseEvent(null, { currentTarget: stubElement({}) }));
    fire(docListeners, 'keydown', { key: 'Escape' });
    expect(open.value).toBe(false);

    await show(mouseEvent(null, { currentTarget: stubElement({}) }));
    fire(winListeners, 'resize', {});
    expect(open.value).toBe(false);
  });

  it('window blur closes the menu (iframe clicks blur the top window)', async () => {
    const menu = stubElement({});
    const { open, show } = setup(menu);
    await show(mouseEvent(null, { currentTarget: stubElement({}) }));
    expect(open.value).toBe(true);
    fire(winListeners, 'blur', {});
    expect(open.value).toBe(false);
  });

  it('outside and internal scroll keep the menu open', async () => {
    const menuNode = new Node();
    const menu = stubElement({ contains: (n) => n === menuNode });
    const { open, show } = setup(menu);
    await show(mouseEvent(null, { currentTarget: stubElement({}) }));
    fire(winListeners, 'scroll', { target: {} });
    expect(open.value).toBe(true);
    fire(winListeners, 'scroll', { target: menuNode });
    expect(open.value).toBe(true);
  });

  it('removes listeners on close', async () => {
    const menu = stubElement({});
    const { open, show, close } = setup(menu);
    await show(mouseEvent(null, { currentTarget: stubElement({}) }));
    close();
    expect(open.value).toBe(false);
    expect(docListeners.get('mousedown')?.size ?? 0).toBe(0);
    expect(winListeners.get('resize')?.size ?? 0).toBe(0);
    expect(winListeners.get('blur')?.size ?? 0).toBe(0);
  });
});
