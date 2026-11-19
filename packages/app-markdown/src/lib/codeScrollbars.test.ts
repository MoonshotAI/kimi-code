// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodeScrollbars } from './codeScrollbars';

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element): void { this.observed.add(el); }
  unobserve(el: Element): void { this.observed.delete(el); }
  disconnect(): void { this.observed.clear(); }
  fire(entries: { target: Element; width: number }[]): void {
    this.callback(entries.map(({ target, width }) => ({ target, contentRect: { width } }) as ResizeObserverEntry), this as unknown as ResizeObserver);
  }
}

let frames: FrameRequestCallback[] = [];
let root: HTMLElement;
let host: HTMLElement;
let wrapper: HTMLElement;
let scrollbars: ReturnType<typeof createCodeScrollbars>;
const size = { scrollWidth: 400, clientWidth: 500 };

function runFrames(): void {
  while (frames.length) {
    const pending = frames;
    frames = [];
    for (const callback of pending) callback(performance.now());
  }
}

function observer(): FakeResizeObserver {
  return FakeResizeObserver.instances.find(instance => instance.observed.has(host))!;
}

beforeEach(() => {
  FakeResizeObserver.instances = [];
  frames = [];
  size.scrollWidth = 400;
  size.clientWidth = 500;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  root = document.createElement('div');
  host = document.createElement('div');
  wrapper = document.createElement('div');
  wrapper.className = 'table-node-wrapper';
  wrapper.append(document.createElement('table'));
  Object.defineProperty(wrapper, 'scrollWidth', { get: () => size.scrollWidth });
  Object.defineProperty(wrapper, 'clientWidth', { get: () => size.clientWidth });
  host.append(wrapper);
  root.append(host);
  document.body.append(root);
  scrollbars = createCodeScrollbars(root);
  scrollbars.sync();
  runFrames();
  observer().fire([{ target: host, width: 500 }, { target: wrapper, width: 500 }]);
  runFrames();
});

afterEach(() => {
  scrollbars.destroy();
  root.remove();
  vi.unstubAllGlobals();
});

describe('table scroll edge fades', () => {
  function fades() {
    return {
      start: wrapper.style.getPropertyValue('--md-table-visible-start'),
      end: wrapper.style.getPropertyValue('--md-table-visible-end'),
      fadeStart: wrapper.style.getPropertyValue('--md-table-fade-start'),
      fadeEnd: wrapper.style.getPropertyValue('--md-table-fade-end'),
    };
  }
  const FADE = 'var(--markdown-table-fade-size)';

  beforeEach(() => {
    size.scrollWidth = 900;
    size.clientWidth = 500;
    observer().fire([{ target: host, width: 500 }, { target: wrapper, width: 500 }]);
    runFrames();
  });

  it('fades only the right edge at the start of the scroll range', () => {
    expect(fades()).toEqual({ start: '0px', end: '500px', fadeStart: '0px', fadeEnd: FADE });
  });

  it('fades both edges in the middle of the scroll range', () => {
    wrapper.scrollLeft = 200;
    wrapper.dispatchEvent(new Event('scroll'));
    runFrames();
    expect(fades()).toEqual({ start: '200px', end: '700px', fadeStart: FADE, fadeEnd: FADE });
  });

  it('fades only the left edge at the end of the scroll range', () => {
    wrapper.scrollLeft = 400;
    wrapper.dispatchEvent(new Event('scroll'));
    runFrames();
    expect(fades()).toEqual({ start: '400px', end: '900px', fadeStart: FADE, fadeEnd: '0px' });
  });

  it('fades neither edge when the table fits', () => {
    size.scrollWidth = 400;
    wrapper.scrollLeft = 0;
    observer().fire([{ target: host, width: 500 }, { target: wrapper, width: 500 }]);
    runFrames();
    expect(fades()).toEqual({ start: '0px', end: '500px', fadeStart: '0px', fadeEnd: '0px' });
  });
});

describe('extra scroll viewports', () => {
  function mountViewport(options?: Parameters<typeof createCodeScrollbars>[1]) {
    const extraRoot = document.createElement('div');
    const box = document.createElement('div');
    const viewport = document.createElement('div');
    viewport.className = 'tool-scroll';
    box.append(viewport);
    extraRoot.append(box);
    document.body.append(extraRoot);
    const extra = createCodeScrollbars(extraRoot, options);
    extra.sync();
    runFrames();
    return { extraRoot, box, viewport, extra };
  }

  it('attaches the code block overlay scrollbars to viewports matching the option', () => {
    const { extraRoot, box, viewport, extra } = mountViewport({ viewports: '.tool-scroll' });
    expect(box.classList.contains('md-code-scroll-host')).toBe(true);
    expect(viewport.classList.contains('md-code-scroll-viewport')).toBe(true);
    expect(box.querySelector(':scope > .md-code-scrollbar--horizontal')).not.toBeNull();
    expect(box.querySelector(':scope > .md-code-scrollbar--vertical')).not.toBeNull();
    extra.destroy();
    expect(box.classList.contains('md-code-scroll-host')).toBe(false);
    expect(viewport.classList.contains('md-code-scroll-viewport')).toBe(false);
    expect(box.querySelector('.md-code-scrollbar')).toBeNull();
    extraRoot.remove();
  });

  it('ignores such viewports without the option', () => {
    const { extraRoot, box, viewport, extra } = mountViewport();
    expect(box.classList.contains('md-code-scroll-host')).toBe(false);
    expect(viewport.classList.contains('md-code-scroll-viewport')).toBe(false);
    expect(box.querySelector('.md-code-scrollbar')).toBeNull();
    extra.destroy();
    extraRoot.remove();
  });
});

describe('horizontal track wheel', () => {
  function mountScroller() {
    const extraRoot = document.createElement('div');
    const box = document.createElement('div');
    const viewport = document.createElement('div');
    viewport.className = 'tool-scroll';
    box.append(viewport);
    extraRoot.append(box);
    document.body.append(extraRoot);
    const extra = createCodeScrollbars(extraRoot, { viewports: '.tool-scroll' });
    extra.sync();
    runFrames();
    const track = box.querySelector<HTMLElement>(':scope > .md-code-scrollbar--horizontal')!;
    return { extraRoot, viewport, extra, track };
  }

  it('leaves a plain vertical wheel to the page instead of scrolling sideways', () => {
    const { extraRoot, viewport, extra, track } = mountScroller();
    const writes: number[] = [];
    Object.defineProperty(viewport, 'scrollLeft', { get: () => writes.at(-1) ?? 0, set: (value: number) => writes.push(value) });
    const event = new WheelEvent('wheel', { deltaY: 40, cancelable: true });
    track.dispatchEvent(event);
    expect(writes.every((value) => value === 0)).toBe(true);
    expect(viewport.scrollLeft).toBe(0);
    expect(event.defaultPrevented).toBe(false);
    extra.destroy();
    extraRoot.remove();
  });

  it('still scrolls sideways for a horizontal or shift wheel', () => {
    const { extraRoot, viewport, extra, track } = mountScroller();
    const writes: number[] = [];
    Object.defineProperty(viewport, 'scrollLeft', { get: () => writes.at(-1) ?? 0, set: (value: number) => writes.push(value) });
    track.dispatchEvent(new WheelEvent('wheel', { deltaX: 30, cancelable: true }));
    track.dispatchEvent(new WheelEvent('wheel', { deltaY: 20, shiftKey: true, cancelable: true }));
    expect(writes).toEqual([30, 50]);
    extra.destroy();
    extraRoot.remove();
  });
});
