// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStabilityProbe, type StabilityEvent, type StabilityScheduler } from '../src/lib/transcriptStability';

class ManualScheduler implements StabilityScheduler {
  time = 0;
  private frames = new Map<number, (time: number) => void>();
  private paints: (() => void)[] = [];
  private next = 1;
  frame(callback: (time: number) => void): number {
    const id = this.next++;
    this.frames.set(id, callback);
    return id;
  }
  cancelFrame(id: number): void { this.frames.delete(id); }
  afterPaint(callback: () => void): void { this.paints.push(callback); }
  now(): number { return this.time; }
  step(ms = 16): void {
    this.time += ms;
    const frames = [...this.frames.values()];
    this.frames.clear();
    for (const callback of frames) callback(this.time);
    for (const callback of this.paints.splice(0)) callback();
  }
}

const scrollTopDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
let scheduler: ManualScheduler;
let scroller: HTMLElement;
let target: HTMLElement;
let placeholder: HTMLElement;
let scrollHeight: number;
let targetDocTop: number;
let placeholderDocTop: number;
const tops = new WeakMap<Element, number>();

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, left: 0, right: 600, width: 600, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get() { return tops.get(this) ?? 0; },
    set(value: number) { tops.set(this, Math.max(0, Math.min(value, scrollHeight - 400))); },
  });
  scheduler = new ManualScheduler();
  scroller = document.createElement('div');
  target = document.createElement('p');
  target.setAttribute('data-turn-id', 'turn-1');
  placeholder = document.createElement('div');
  placeholder.className = 'space';
  scroller.append(target, placeholder);
  document.body.append(scroller);
  scrollHeight = 2000;
  targetDocTop = 1000;
  placeholderDocTop = 5000;
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 400 });
  scroller.getBoundingClientRect = () => rect(0, 400);
  target.getBoundingClientRect = () => rect(targetDocTop - scroller.scrollTop, 40);
  placeholder.getBoundingClientRect = () => rect(placeholderDocTop - scroller.scrollTop, 300);
  document.elementFromPoint = () => target;
  scroller.scrollTop = 900;
});

afterEach(() => {
  Object.defineProperty(Element.prototype, 'scrollTop', scrollTopDescriptor);
  scroller.remove();
});

function probe(events: StabilityEvent[] = []) {
  return createStabilityProbe(scroller, { scheduler, placeholderSelector: '.space', onEvent: (event) => events.push(event) });
}

describe('createStabilityProbe', () => {
  it('reports the reading element moving without user input', () => {
    const events: StabilityEvent[] = [];
    const instance = probe(events);
    scheduler.step();
    targetDocTop += 24;
    scheduler.step();
    expect(instance.report()).toMatchObject({ shifts: 1, maxShiftPx: 24 });
    expect(events).toContainEqual({ kind: 'shift', atBottom: false, delta: 24, target: 'p turn=turn-1' });
    instance.stop();
  });

  it('falls back to the reading row when the reading element is replaced', () => {
    const row = document.createElement('div');
    row.setAttribute('data-turn-id', 'turn-2');
    const inner = document.createElement('span');
    row.append(inner);
    scroller.append(row);
    let rowDocTop = 1000;
    row.getBoundingClientRect = () => rect(rowDocTop - scroller.scrollTop, 200);
    inner.getBoundingClientRect = () => rect(1010 - scroller.scrollTop, 20);
    document.elementFromPoint = () => inner;
    const instance = probe();
    scheduler.step();
    inner.remove();
    rowDocTop += 30;
    scheduler.step();
    expect(instance.report()).toMatchObject({ shifts: 1, maxShiftPx: 30 });
    instance.stop();
  });

  it('ignores movement caused by user input until the input settles', () => {
    const instance = probe();
    scheduler.step();
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    scroller.scrollTop -= 100;
    scheduler.step();
    expect(instance.report().shifts).toBe(0);
    scheduler.step(200);
    targetDocTop += 10;
    scheduler.step();
    expect(instance.report().shifts).toBe(1);
    instance.stop();
  });

  it('releases a held pointer when the window loses focus', () => {
    const instance = probe();
    scheduler.step();
    window.dispatchEvent(new Event('pointerdown'));
    window.dispatchEvent(new Event('blur'));
    scheduler.step(200);
    targetDocTop += 10;
    scheduler.step();
    expect(instance.report().shifts).toBe(1);
    instance.stop();
  });

  it('treats a follow that lands a frame late as a lag followed by a shift', () => {
    const instance = probe();
    scroller.scrollTop = scrollHeight - 400;
    scheduler.step();
    scrollHeight += 50;
    scheduler.step();
    expect(instance.report()).toMatchObject({ followLags: 1, shifts: 0 });
    scroller.scrollTop = scrollHeight - 400;
    scheduler.step();
    expect(instance.report()).toMatchObject({ followLags: 1, shifts: 1, maxShiftPx: 50 });
    instance.stop();
  });

  it('does not report content growing while the bottom stays pinned', () => {
    const instance = probe();
    scroller.scrollTop = scrollHeight - 400;
    scheduler.step();
    scrollHeight += 50;
    scroller.scrollTop = scrollHeight - 400;
    scheduler.step();
    expect(instance.report()).toMatchObject({ followLags: 0, shifts: 0 });
    instance.stop();
  });

  it('counts effective scroll writes per frame', () => {
    const events: StabilityEvent[] = [];
    const instance = probe(events);
    scroller.scrollTop = 800;
    scroller.scrollTop = 800;
    scroller.scrollTop = 700;
    scheduler.step();
    expect(instance.report()).toMatchObject({ writes: 2, maxWritesPerFrame: 2, multiWriteFrames: 1 });
    expect(events).toContainEqual({ kind: 'multi-write', writes: 2 });
    instance.stop();
  });

  it('counts ResizeObserver loop errors and visible placeholders', () => {
    const instance = probe();
    window.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop completed with undelivered notifications.' }));
    window.dispatchEvent(new ErrorEvent('error', { message: 'unrelated' }));
    placeholderDocTop = 1100;
    scheduler.step();
    expect(instance.report()).toMatchObject({ roLoops: 1, blankFrames: 1 });
    instance.stop();
  });

  it('restores the scroller when stopped', () => {
    const instance = probe();
    expect(Object.prototype.hasOwnProperty.call(scroller, 'scrollTop')).toBe(true);
    instance.stop();
    expect(Object.prototype.hasOwnProperty.call(scroller, 'scrollTop')).toBe(false);
    scroller.scrollTop = 100;
    expect(scroller.scrollTop).toBe(100);
  });
});
