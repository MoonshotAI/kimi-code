import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import {
  createDecorator,
  type ServicesAccessor,
} from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import { ServiceCollection } from '#/_base/di/serviceCollection';

interface IService1 {
  readonly _serviceBrand: undefined;
  c: number;
}
interface IService2 {
  readonly _serviceBrand: undefined;
  d: boolean;
}

const IService1 = createDecorator<IService1>('invocation-s1');
const IService2 = createDecorator<IService2>('invocation-s2');

class Service1 implements IService1 {
  readonly _serviceBrand: undefined;
  c = 1;
}
class Service2 implements IService2 {
  readonly _serviceBrand: undefined;
  d = true;
}

class Service1Consumer {
  constructor(@IService1 readonly service1: IService1) {}
}

class Target2Dep {
  constructor(
    @IService1 readonly service1: IService1,
    @IService2 readonly service2: IService2,
  ) {}
}

describe('ServiceCollection', () => {
  it('set returns the previous value (undefined first, then the old entry)', () => {
    const collection = new ServiceCollection();
    expect(collection.set(IService1, null as unknown as IService1)).toBeUndefined();

    const first = new Service1();
    collection.set(IService1, first);

    const second = new Service1();
    expect(collection.set(IService1, second)).toBe(first);
  });

  it('has reflects which ids are registered', () => {
    const collection = new ServiceCollection();
    collection.set(IService1, null as unknown as IService1);
    expect(collection.has(IService1)).toBe(true);
    expect(collection.has(IService2)).toBe(false);

    collection.set(IService2, null as unknown as IService2);
    expect(collection.has(IService1)).toBe(true);
    expect(collection.has(IService2)).toBe(true);
  });

  it('is live: registrations after the container is constructed are still visible', () => {
    const collection = new ServiceCollection();
    collection.set(IService1, new Service1());

    const service = new InstantiationService(collection);
    const consumer = service.createInstance(Service1Consumer);
    expect(consumer.service1).toBeInstanceOf(Service1);
    expect(consumer.service1.c).toBe(1);

    collection.set(IService2, new Service2());

    const target2 = service.createInstance(Target2Dep);
    expect(target2.service1).toBeInstanceOf(Service1);
    expect(target2.service2).toBeInstanceOf(Service2);
    service.invokeFunction((a) => {
      expect(a.get(IService1)).toBeInstanceOf(Service1);
      expect(a.get(IService2)).toBeInstanceOf(Service2);
    });
  });
});

describe('InstantiationService.invokeFunction', () => {
  it('injects services and returns the callback value', () => {
    const service = new InstantiationService(
      new ServiceCollection([IService1, new Service1()], [IService2, new Service2()]),
    );
    const result = service.invokeFunction((a) => {
      expect(a.get(IService1)).toBeInstanceOf(Service1);
      expect(a.get(IService1).c).toBe(1);
      return 42;
    });
    expect(result).toBe(42);
  });

  it('resolves a SyncDescriptor as a singleton within the same container', () => {
    interface IFoo {
      readonly _serviceBrand: undefined;
      tag: string;
    }
    const IFoo = createDecorator<IFoo>('invocation-foo-singleton');
    class Foo implements IFoo {
      readonly _serviceBrand: undefined;
      tag = 'foo';
    }
    const service = new InstantiationService(
      new ServiceCollection([IFoo, new SyncDescriptor(Foo)]),
    );
    service.invokeFunction((a) => {
      const first = a.get(IFoo);
      const second = a.get(IFoo);
      expect(first).toBeInstanceOf(Foo);
      expect(first).toBe(second);
    });
  });

  it('strict mode throws when resolving an unknown service', () => {
    const service = new InstantiationService(
      new ServiceCollection([IService1, new Service1()]),
      true,
    );
    service.invokeFunction((a) => {
      expect(a.get(IService1)).toBeInstanceOf(Service1);
      expect(() => a.get(IService2)).toThrow();
    });
  });

  it('non-strict mode yields undefined for an unknown service', () => {
    const service = new InstantiationService(
      new ServiceCollection([IService1, new Service1()]),
    );
    const value = service.invokeFunction((a) => a.get(IService2));
    expect(value).toBeUndefined();
  });

  it('accessor is only valid during the invocation (escaping use throws)', () => {
    const service = new InstantiationService(
      new ServiceCollection([IService1, new Service1()]),
    );
    let cached: ServicesAccessor | undefined;
    service.invokeFunction((a) => {
      expect(a.get(IService1)).toBeInstanceOf(Service1);
      cached = a;
    });
    expect(cached).toBeDefined();
    expect(() => cached!.get(IService1)).toThrow(
      /service accessor is only valid during the invocation/i,
    );
  });

  it('propagates errors thrown by the callback', () => {
    const service = new InstantiationService(
      new ServiceCollection([IService1, new Service1()]),
    );
    expect(() =>
      service.invokeFunction(() => {
        throw new Error('invoke-boom');
      }),
    ).toThrow('invoke-boom');
  });
});
