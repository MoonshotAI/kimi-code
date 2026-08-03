import { describe, expect, it } from 'vitest';

import { EventService } from '#/app/event/eventService';

describe('EventService', () => {
  it('publish delivers to subscribers; unsubscribe stops delivery', () => {
    const svc = new EventService();
    const received: string[] = [];
    const sub = svc.subscribe((e) => received.push(e.type));
    svc.publish({ type: 'a', payload: null });
    svc.publish({ type: 'b', payload: null });
    sub.dispose();
    svc.publish({ type: 'c', payload: null });
    expect(received).toEqual(['a', 'b']);
  });

  it('onDidPublish mirrors subscribe (same underlying stream)', () => {
    const svc = new EventService();
    const received: string[] = [];
    const sub = svc.onDidPublish((e) => received.push(e.type));
    svc.publish({ type: 'a', payload: null });
    sub.dispose();
    svc.publish({ type: 'b', payload: null });
    expect(received).toEqual(['a']);
  });

  it('supports multiple independent subscribers', () => {
    const svc = new EventService();
    const receivedA: string[] = [];
    const receivedB: string[] = [];
    svc.subscribe((e) => receivedA.push(e.type));
    svc.subscribe((e) => receivedB.push(e.type));
    svc.publish({ type: 'x', payload: null });
    expect(receivedA).toEqual(['x']);
    expect(receivedB).toEqual(['x']);
  });

  it('tolerates a subscriber that throws without affecting other subscribers', () => {
    const svc = new EventService();
    const received: string[] = [];
    svc.subscribe(() => {
      throw new Error('subscriber error');
    });
    svc.subscribe((e) => received.push(e.type));
    expect(() => svc.publish({ type: 'z', payload: null })).not.toThrow();
    expect(received).toEqual(['z']);
  });

  it('publishes events with complex payloads', () => {
    const svc = new EventService();
    const payloads: unknown[] = [];
    svc.subscribe((e) => payloads.push(e.payload));
    svc.publish({ type: 'complex', payload: { nested: { value: 42 }, list: [1, 2, 3] } });
    svc.publish({ type: 'null', payload: null });
    expect(payloads).toEqual([{ nested: { value: 42 }, list: [1, 2, 3] }, null]);
  });

  it('handles dispose of a subscription that was already disposed', () => {
    const svc = new EventService();
    const sub = svc.subscribe(() => {});
    sub.dispose();
    expect(() => sub.dispose()).not.toThrow();
  });
});
