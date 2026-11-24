import { effectScope, type EffectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePointerDragSession } from '../src/composables/usePointerDragSession';

class Handle extends EventTarget {
  capture: number | null = null;
  blurred = false;
  blur() { this.blurred = true; }
  hasPointerCapture(id: number) { return this.capture === id; }
  setPointerCapture(id: number) { this.capture = id; }
  releasePointerCapture() { this.capture = null; this.dispatchEvent(new Event('lostpointercapture')); }
}

let scopes: EffectScope[];

beforeEach(() => {
  scopes = [];
  vi.stubGlobal('HTMLElement', Handle);
  vi.stubGlobal('window', new EventTarget());
});

afterEach(() => {
  for (const scope of scopes) scope.stop();
  vi.unstubAllGlobals();
});

function pointer(type: string, x: number, y = 0, pointerId = 1) {
  const event = Object.assign(new Event(type, { cancelable: true }), { pointerId, clientX: x, clientY: y });
  window.dispatchEvent(event);
  return event;
}

function setup(begin = () => true) {
  const handle = new Handle();
  const calls = { begin: vi.fn(begin), move: vi.fn(), end: vi.fn() };
  const scope = effectScope();
  scopes.push(scope);
  const session = scope.run(() => usePointerDragSession<string>({ begin: calls.begin, move: calls.move, end: calls.end }))!;
  function down(x = 0, extra: Partial<PointerEvent> = {}) {
    return session.onPointerDown({ currentTarget: handle, pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: 0, ...extra } as unknown as PointerEvent, 'chip');
  }
  return { handle, calls, session, down };
}

describe('pointer drag session', () => {
  it('treats small movements as a click and starts a drag past the threshold', () => {
    const { calls, session, down, handle } = setup();
    down(10);
    pointer('pointermove', 13);
    expect(calls.begin).not.toHaveBeenCalled();
    pointer('pointerup', 13);
    expect(calls.end).not.toHaveBeenCalled();
    expect(session.consumeClick()).toBe(false);
    down(10);
    pointer('pointermove', 20, 2);
    expect(calls.begin).toHaveBeenCalledWith(expect.objectContaining({ data: 'chip', origin: { x: 10, y: 0 }, point: { x: 20, y: 2 } }));
    expect(session.active.value).toBe(true);
    expect(handle.capture).toBe(1);
    expect(handle.blurred).toBe(true);
    expect(calls.move).toHaveBeenLastCalledWith({ x: 20, y: 2 });
    pointer('pointerup', 30, 4);
    expect(calls.end).toHaveBeenCalledWith(true, { x: 30, y: 4 });
    expect(session.active.value).toBe(false);
    expect(handle.capture).toBeNull();
    expect(session.consumeClick()).toBe(true);
    expect(session.consumeClick()).toBe(false);
  });

  it('cancels on Escape without dropping', () => {
    const { calls, down } = setup();
    down();
    pointer('pointermove', 40);
    const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape', isComposing: false });
    window.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(calls.end).toHaveBeenCalledWith(false, { x: 40, y: 0 });
    pointer('pointerup', 50);
    expect(calls.end).toHaveBeenCalledTimes(1);
  });

  it('ignores touch, secondary buttons and other pointers', () => {
    const { calls, down } = setup();
    expect(down(0, { pointerType: 'touch' })).toBe(false);
    expect(down(0, { button: 2 })).toBe(false);
    expect(down(0)).toBe(true);
    pointer('pointermove', 50, 0, 2);
    expect(calls.begin).not.toHaveBeenCalled();
  });

  it('stays idle when the owner declines to begin', () => {
    const { calls, session, down } = setup(() => false);
    down();
    pointer('pointermove', 40);
    expect(session.active.value).toBe(false);
    expect(session.pending()).toBe(false);
    pointer('pointermove', 80);
    expect(calls.begin).toHaveBeenCalledTimes(1);
    expect(calls.move).not.toHaveBeenCalled();
  });
});
