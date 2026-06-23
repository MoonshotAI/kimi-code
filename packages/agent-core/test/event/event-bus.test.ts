import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '#/rpc';
import { DomainEventBus } from '#/event';

const warningEvent = (message: string): AgentEvent =>
  ({ type: 'warning', message }) satisfies AgentEvent;

describe('DomainEventBus', () => {
  it('delivers to a typed subscriber only when the type matches', () => {
    const bus = new DomainEventBus();
    const warningHandler = vi.fn();
    const errorHandler = vi.fn();
    bus.subscribe('warning', warningHandler);
    bus.subscribe('error', errorHandler);

    const event = warningEvent('boom');
    bus.publish(event);

    expect(warningHandler).toHaveBeenCalledOnce();
    expect(warningHandler).toHaveBeenCalledWith(event);
    expect(errorHandler).not.toHaveBeenCalled();
  });

  it('delivers every published event to subscribeAll', () => {
    const bus = new DomainEventBus();
    const handler = vi.fn();
    bus.subscribeAll(handler);

    const first = warningEvent('one');
    const second = warningEvent('two');
    bus.publish(first);
    bus.publish(second);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, first);
    expect(handler).toHaveBeenNthCalledWith(2, second);
  });

  it('invokes the forward callback once per publish with the same event', () => {
    const forward = vi.fn();
    const bus = new DomainEventBus(forward);

    const event = warningEvent('fwd');
    bus.publish(event);

    expect(forward).toHaveBeenCalledOnce();
    expect(forward).toHaveBeenCalledWith(event);
  });

  it('does not throw when constructed without a forward callback', () => {
    const bus = new DomainEventBus();
    expect(() => bus.publish(warningEvent('no-forward'))).not.toThrow();
  });

  it('stops typed delivery after the subscription is disposed', () => {
    const bus = new DomainEventBus();
    const handler = vi.fn();
    const subscription = bus.subscribe('warning', handler);

    bus.publish(warningEvent('before'));
    subscription.dispose();
    bus.publish(warningEvent('after'));

    expect(handler).toHaveBeenCalledOnce();
  });

  it('stops subscribeAll delivery after the subscription is disposed', () => {
    const bus = new DomainEventBus();
    const handler = vi.fn();
    const subscription = bus.subscribeAll(handler);

    bus.publish(warningEvent('before'));
    subscription.dispose();
    bus.publish(warningEvent('after'));

    expect(handler).toHaveBeenCalledOnce();
  });
});
