/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { describe, expect, it } from 'vitest';

import { Event2 } from '#/app/event/event2';
import { EventService } from '#/app/event/eventService';

class TestAppEvent extends Event2<{ readonly payload: { readonly v: number } }> {
  static override readonly type = 'test.app';
}
interface TestAppEvent {
  readonly payload: { readonly v: number };
}

class OtherAppEvent extends Event2<{ readonly payload: null }> {
  static override readonly type = 'test.other';
}
interface OtherAppEvent {
  readonly payload: null;
}

describe('EventService', () => {
  it('publish delivers Event2 instances to subscribers; unsubscribe stops delivery', () => {
    const svc = new EventService();
    const received: Event2[] = [];
    const sub = svc.subscribe((e) => received.push(e));
    svc.publish(new TestAppEvent({ payload: { v: 1 } }));
    svc.publish(new OtherAppEvent({ payload: null }));
    sub.dispose();
    svc.publish(new TestAppEvent({ payload: { v: 2 } }));
    expect(received).toHaveLength(2);
    expect(received[0]).toBeInstanceOf(TestAppEvent);
    expect(received[0]).toMatchObject({ type: 'test.app', payload: { v: 1 } });
    expect(received[1]).toBeInstanceOf(OtherAppEvent);
  });

  it('onDidPublish mirrors subscribe (same underlying stream)', () => {
    const svc = new EventService();
    const received: string[] = [];
    const sub = svc.onDidPublish((e) => received.push(e.type));
    svc.publish(new TestAppEvent({ payload: { v: 1 } }));
    sub.dispose();
    svc.publish(new OtherAppEvent({ payload: null }));
    expect(received).toEqual(['test.app']);
  });
});
