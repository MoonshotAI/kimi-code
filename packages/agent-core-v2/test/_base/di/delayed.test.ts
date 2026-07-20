import { describe, expect, it } from 'vitest';

import { Emitter, type Event } from '#/_base/event';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { createDecorator } from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import { dispose } from '#/_base/di/lifecycle';
import { ServiceCollection } from '#/_base/di/serviceCollection';


describe('Delayed instantiation', () => {
  it('subscribing to an event does not instantiate; first method call does', () => {
    interface IA {
      readonly onDidDoIt: Event<unknown>;
      doIt(): void;
    }
    const IA = createDecorator<IA>('delayed-A-events');

    let created = false;
    class AImpl implements IA {
      private _doIt = 0;
      private readonly _onDidDoIt = new Emitter<this>();
      readonly onDidDoIt: Event<this> = this._onDidDoIt.event;

      constructor() {
        created = true;
      }

      doIt(): void {
        this._doIt += 1;
        this._onDidDoIt.fire(this);
      }
    }

    const insta = new InstantiationService(
      new ServiceCollection([IA, new SyncDescriptor(AImpl, [], true)]),
      true,
      undefined,
      true,
    );

    class Consumer {
      constructor(@IA public readonly a: IA) {}
    }

    const c = insta.createInstance(Consumer);
    let eventCount = 0;

    const listener = (e: unknown) => {
      expect(e).toBeInstanceOf(AImpl);
      eventCount++;
    };

    const d1 = c.a.onDidDoIt(listener);
    const d2 = c.a.onDidDoIt(listener);
    expect(created).toBe(false);
    expect(eventCount).toBe(0);
    d2.dispose();

    c.a.doIt();
    expect(created).toBe(true);
    expect(eventCount).toBe(1);

    const d3 = c.a.onDidDoIt(listener);
    c.a.doIt();
    expect(eventCount).toBe(3);

    dispose([d1, d3]);
  });

  it('event reference captured before init still works after init', () => {
    interface IA {
      readonly onDidDoIt: Event<unknown>;
      doIt(): void;
      noop(): void;
    }
    const IA = createDecorator<IA>('delayed-A-capture');

    let created = false;
    class AImpl implements IA {
      private _doIt = 0;
      private readonly _onDidDoIt = new Emitter<this>();
      readonly onDidDoIt: Event<this> = this._onDidDoIt.event;

      constructor() {
        created = true;
      }

      doIt(): void {
        this._doIt += 1;
        this._onDidDoIt.fire(this);
      }

      noop(): void {}
    }

    const insta = new InstantiationService(
      new ServiceCollection([IA, new SyncDescriptor(AImpl, [], true)]),
      true,
      undefined,
      true,
    );

    class Consumer {
      constructor(@IA public readonly a: IA) {}
    }

    const c = insta.createInstance(Consumer);
    let eventCount = 0;

    const listener = (e: unknown) => {
      expect(e).toBeInstanceOf(AImpl);
      eventCount++;
    };

    const event = c.a.onDidDoIt;
    expect(created).toBe(false);

    c.a.noop();
    expect(created).toBe(true);

    const d1 = event(listener);
    c.a.doIt();
    expect(eventCount).toBe(1);

    dispose(d1);
  });

  it('disposing an early listener before/after init stops delivery', () => {
    interface IA {
      readonly onDidDoIt: Event<unknown>;
      doIt(): void;
    }
    const IA = createDecorator<IA>('delayed-A-dispose');

    let created = false;
    class AImpl implements IA {
      private _doIt = 0;
      private readonly _onDidDoIt = new Emitter<this>();
      readonly onDidDoIt: Event<this> = this._onDidDoIt.event;

      constructor() {
        created = true;
      }

      doIt(): void {
        this._doIt += 1;
        this._onDidDoIt.fire(this);
      }
    }

    const insta = new InstantiationService(
      new ServiceCollection([IA, new SyncDescriptor(AImpl, [], true)]),
      true,
      undefined,
      true,
    );

    class Consumer {
      constructor(@IA public readonly a: IA) {}
    }

    const c = insta.createInstance(Consumer);
    let eventCount = 0;

    const listener = (e: unknown) => {
      expect(e).toBeInstanceOf(AImpl);
      eventCount++;
    };

    const d1 = c.a.onDidDoIt(listener);
    expect(created).toBe(false);
    expect(eventCount).toBe(0);

    c.a.doIt();
    expect(created).toBe(true);
    expect(eventCount).toBe(1);

    dispose(d1);

    c.a.doIt();
    expect(eventCount).toBe(1);
  });
});
