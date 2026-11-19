import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import {
  anyMenuOpen,
  isInOpenMenuSurface,
  openMenuCount,
  registerExternalMenuSurface,
  registerMenuSurface,
  trackMenuSurface,
  type MenuSurfaceElement,
} from '../src/composables/menuStack';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function fakeEl(children: Set<unknown> = new Set()): MenuSurfaceElement {
  const el: MenuSurfaceElement = {
    contains: (other) => other === el || children.has(other),
  };
  return el;
}

describe('registerMenuSurface', () => {
  it('counts open surfaces and flips anyMenuOpen', () => {
    expect(anyMenuOpen.value).toBe(false);
    const releaseA = registerMenuSurface(fakeEl());
    const releaseB = registerMenuSurface(fakeEl());
    expect(openMenuCount.value).toBe(2);
    expect(anyMenuOpen.value).toBe(true);
    releaseA();
    expect(anyMenuOpen.value).toBe(true);
    releaseB();
    expect(openMenuCount.value).toBe(0);
    expect(anyMenuOpen.value).toBe(false);
  });

  it('release is idempotent', () => {
    const release = registerMenuSurface(fakeEl());
    release();
    release();
    expect(openMenuCount.value).toBe(0);
  });

  it('tracks an external native menu without a local containing surface', () => {
    const release = registerExternalMenuSurface();
    expect(openMenuCount.value).toBe(1);
    expect(anyMenuOpen.value).toBe(true);
    expect(isInOpenMenuSurface(fakeEl())).toBe(false);
    release();
    release();
    expect(openMenuCount.value).toBe(0);
  });
});

describe('isInOpenMenuSurface', () => {
  it('matches the surface itself and its descendants only', () => {
    const child = fakeEl();
    const surface = fakeEl(new Set([child]));
    const outsider = fakeEl();
    const release = registerMenuSurface(surface);
    expect(isInOpenMenuSurface(surface)).toBe(true);
    expect(isInOpenMenuSurface(child)).toBe(true);
    expect(isInOpenMenuSurface(outsider)).toBe(false);
    expect(isInOpenMenuSurface(null)).toBe(false);
    release();
    expect(isInOpenMenuSurface(child)).toBe(false);
  });
});

describe('trackMenuSurface', () => {
  it('registers while open and releases on close', async () => {
    const panel = fakeEl();
    const open = ref(false);
    const el = ref<unknown>(null);
    trackMenuSurface(open, el);

    open.value = true;
    el.value = panel;
    await nextTick();
    expect(openMenuCount.value).toBe(1);

    open.value = false;
    el.value = null;
    await nextTick();
    expect(openMenuCount.value).toBe(0);
  });

  it('follows the panel element when it is replaced mid-open', async () => {
    const first = fakeEl();
    const second = fakeEl();
    const open = ref(true);
    const el = ref<unknown>(first);
    trackMenuSurface(open, el);
    await nextTick();
    expect(isInOpenMenuSurface(first)).toBe(true);

    el.value = second;
    await nextTick();
    expect(openMenuCount.value).toBe(1);
    expect(isInOpenMenuSurface(first)).toBe(false);
    expect(isInOpenMenuSurface(second)).toBe(true);

    open.value = false;
    el.value = null;
    await nextTick();
    expect(openMenuCount.value).toBe(0);
  });

  it('stays closed-tracked when open flips back before the flush', async () => {
    const open = ref(false);
    const el = ref<unknown>(fakeEl());
    trackMenuSurface(open, el);
    open.value = true;
    open.value = false;
    await nextTick();
    expect(openMenuCount.value).toBe(0);
  });

  it('ignores panel values that are not elements', async () => {
    const open = ref(true);
    const el = ref<unknown>({ not: 'an-element' });
    trackMenuSurface(open, el);
    await nextTick();
    expect(openMenuCount.value).toBe(0);
  });
});
