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
});
