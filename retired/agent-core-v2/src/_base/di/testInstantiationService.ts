/**
 * `di` domain (L0) — `TestInstantiationService` and scoped test-container helpers.
 */

import * as sinon from 'sinon';

import { SyncDescriptor, type SyncDescriptor0 } from './descriptors';
import {
  type GetLeadingNonServiceArgs,
  type ServiceIdentifier,
  type ServicesAccessor,
} from './instantiation';
import { InstantiationService, Trace } from './instantiationService';
import { DisposableStore, dispose, isDisposable, toDisposable, type IDisposable } from './lifecycle';
import { ServiceCollection } from './serviceCollection';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyConstructor<T = unknown> = new (...args: any[]) => T;

interface IServiceMock<T> {
  id: ServiceIdentifier<T>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  service?: any;
}

const isSinonSpyLike = (fn: Function): fn is sinon.SinonSpy =>
  fn && 'callCount' in fn;

export class TestInstantiationService extends InstantiationService implements IDisposable, ServicesAccessor {
  private readonly _classStubs = new Map<Function, unknown>();
  private readonly _parentTestService?: TestInstantiationService;

  constructor(
    private readonly _serviceCollection: ServiceCollection = new ServiceCollection(),
    strict: boolean = false,
    parent?: InstantiationService,
    private readonly _properDispose: boolean = true,
  ) {
    super(_serviceCollection, strict, parent);
    if (parent instanceof TestInstantiationService) {
      this._parentTestService = parent;
    }
  }

  public get<T>(id: ServiceIdentifier<T>): T {
    return super._getOrCreateServiceInstance(
      id,
      Trace.traceCreation(false, TestInstantiationService),
    );
  }

  public set<T>(
    id: ServiceIdentifier<T>,
    instanceOrDescriptor: T | SyncDescriptor<T>,
  ): T | SyncDescriptor<T> | undefined {
    return this._serviceCollection.set(id, instanceOrDescriptor);
  }

  public mock<T>(id: ServiceIdentifier<T>): T | sinon.SinonMock {
    return this._create({ id }, { mock: true });
  }

  public stubInstance<T>(ctor: AnyConstructor<T>, instance: Partial<T>): void {
    this._classStubs.set(ctor, instance);
  }

  protected _getClassStub(ctor: Function): unknown {
    return this._classStubs.get(ctor) ?? this._parentTestService?._getClassStub(ctor);
  }

  public override createInstance<T>(descriptor: SyncDescriptor0<T>): T;
  public override createInstance<
    Ctor extends AnyConstructor,
    R extends InstanceType<Ctor>,
  >(
    ctor: Ctor,
    ...args: GetLeadingNonServiceArgs<ConstructorParameters<Ctor>>
  ): R;
  public override createInstance(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctorOrDescriptor: any,
    ...rest: unknown[]
  ): unknown {
    const stub =
      ctorOrDescriptor instanceof SyncDescriptor
        ? this._getClassStub(ctorOrDescriptor.ctor)
        : this._getClassStub(ctorOrDescriptor);

    if (stub !== undefined) {
      return stub;
    }

    if (ctorOrDescriptor instanceof SyncDescriptor) {
      return super.createInstance(ctorOrDescriptor, ...rest);
    }
    return super.createInstance(ctorOrDescriptor, ...rest);
  }

  public stub<T>(
    id: ServiceIdentifier<T>,
    instanceOrDescriptor: Partial<NoInfer<T>> | SyncDescriptor<T>,
  ): T | SyncDescriptor<T>;
  public stub<T>(id: ServiceIdentifier<T>, ctor: AnyConstructor<T>): T;
  public stub<T, V>(
    id: ServiceIdentifier<T>,
    obj: Partial<NoInfer<T>> | Function,
    property: string,
    value: V,
  ): V extends Function ? sinon.SinonSpy : sinon.SinonStub;
  public stub<T, V>(
    id: ServiceIdentifier<T>,
    property: string,
    value: V,
  ): V extends Function ? sinon.SinonSpy : sinon.SinonStub;
  public stub<T>(
    id: ServiceIdentifier<T>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    arg2: any,
    arg3?: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    arg4?: any,
  ): T | SyncDescriptor<T> | sinon.SinonStub | sinon.SinonSpy {
    if (arg2 instanceof SyncDescriptor && typeof arg3 !== 'string') {
      this._serviceCollection.set(id, arg2);
      return arg2;
    }

    if (typeof arg2 !== 'string' && typeof arg3 !== 'string') {
      const service = this._create(arg2, { stub: true }) as T;
      this._serviceCollection.set(id, service);
      return service;
    }

    const service = typeof arg2 !== 'string' ? arg2 : undefined;
    const property = typeof arg2 === 'string' ? arg2 : arg3;
    const value = typeof arg2 === 'string' ? arg3 : arg4;

    if (typeof property !== 'string') {
      throw new TypeError('stub requires a method/property name');
    }

    const serviceMock: IServiceMock<T> = { id, service };
    const stubObject = this._create(serviceMock, { stub: true }, Boolean(service && !property)) as Record<string, unknown>;
    const replacement = this._createReplacement(value);

    const current = stubObject[property] as { restore?: () => void } | undefined;
    if (current && typeof current.restore === 'function') {
      current.restore();
    }
    stubObject[property] = replacement;
    return replacement;
  }

  public stubPromise<T>(
    id?: ServiceIdentifier<T>,
    fnProperty?: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value?: any,
  ): T | sinon.SinonStub;
  public stubPromise<T, V>(
    id?: ServiceIdentifier<T>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctor?: any,
    fnProperty?: string,
    value?: V,
  ): V extends Function ? sinon.SinonSpy : sinon.SinonStub;
  public stubPromise<T, V>(
    id?: ServiceIdentifier<T>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    obj?: any,
    fnProperty?: string,
    value?: V,
  ): V extends Function ? sinon.SinonSpy : sinon.SinonStub;
  public stubPromise(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    arg1?: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    arg2?: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    arg3?: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    arg4?: any,
  ): unknown {
    arg3 = typeof arg2 === 'string' ? Promise.resolve(arg3) : arg3;
    arg4 = typeof arg2 !== 'string' && typeof arg3 === 'string' ? Promise.resolve(arg4) : arg4;
    return this.stub(arg1, arg2, arg3, arg4);
  }

  public spy<T>(id: ServiceIdentifier<T>, property: string): sinon.SinonSpy {
    const spy = sinon.spy();
    this.stub(id, property, spy);
    return spy;
  }

  private _create<T>(serviceMock: IServiceMock<T>, options: SinonOptions, reset?: boolean): T;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _create<T>(ctor: any, options: SinonOptions): T | sinon.SinonMock;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _create(arg1: any, options: SinonOptions, reset: boolean = false): any {
    if (this._isServiceMock(arg1)) {
      const service = this._getOrCreateService(arg1, options, reset);
      if (options.mock) {
        return sinon.mock(service);
      }
      this._serviceCollection.set(arg1.id, service);
      return service;
    }
    return options.mock ? sinon.mock(arg1) : this._createStub(arg1);
  }

  private _getOrCreateService<T>(
    serviceMock: IServiceMock<T>,
    opts: SinonOptions,
    reset?: boolean,
  ): T {
    const service = this._serviceCollection.get(serviceMock.id);
    if (!reset && service && !(service instanceof SyncDescriptor)) {
      if (opts.stub && this._hasSinonOption(service, 'stub')) {
        return service as T;
      }
      if (opts.mock && this._hasSinonOption(service, 'mock')) {
        return service as T;
      }
      return service as T;
    }
    return this._createService(serviceMock, opts);
  }

  private _createService<T>(serviceMock: IServiceMock<T>, opts: SinonOptions): T {
    const existing = this._serviceCollection.get(serviceMock.id);
    const source =
      serviceMock.service
      ?? (existing instanceof SyncDescriptor ? existing.ctor : undefined);
    const service = this._createStub(source);
    service.sinonOptions = opts;
    return service as T;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _createStub(arg: any): any {
    if (arg instanceof SyncDescriptor) {
      return sinon.createStubInstance(arg.ctor);
    }
    if (typeof arg === 'function') {
      return sinon.createStubInstance(arg);
    }
    if (arg && typeof arg === 'object') {
      return arg;
    }
    return Object.create(null);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _createReplacement(value: any): sinon.SinonStub | sinon.SinonSpy {
    if (typeof value === 'function') {
      return isSinonSpyLike(value) ? value : sinon.spy(value);
    }
    return value ? sinon.stub().returns(value) : sinon.stub();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _hasSinonOption(service: any, key: keyof SinonOptions): boolean {
    return Boolean(service?.sinonOptions?.[key]);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _isServiceMock(arg: any): arg is IServiceMock<unknown> {
    return typeof arg === 'object' && arg !== null && 'id' in arg;
  }

  public override createChild(services: ServiceCollection): TestInstantiationService {
    if (!(services instanceof ServiceCollection)) {
      throw new TypeError(
        'createChild requires a ServiceCollection instance (got something else)',
      );
    }
    const child = new TestInstantiationService(services, false, this);
    (this as unknown as { _children: Set<InstantiationService> })._children.add(child);
    return child;
  }

  public override dispose(): void {
    sinon.restore();
    if (this._properDispose) {
      super.dispose();
    }
  }
}

interface SinonOptions {
  mock?: boolean;
  stub?: boolean;
}

export interface ServiceRegistration {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  define<T>(id: ServiceIdentifier<T>, ctor: new (...args: any[]) => T): void;
  defineInstance<T>(id: ServiceIdentifier<T>, instance: T): void;
  definePartialInstance<T>(id: ServiceIdentifier<T>, instance: Partial<T>): void;
}

export type ServiceGroup = (reg: ServiceRegistration) => void;

export interface CreateServicesOptions {
  readonly base?: readonly ServiceGroup[];
  readonly additionalServices?: (reg: ServiceRegistration) => void;
  readonly strict?: boolean;
}

export function createServices(
  disposables: DisposableStore,
  options: CreateServicesOptions = {},
): TestInstantiationService {
  const serviceCollection = new ServiceCollection();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instanceIds = new Set<ServiceIdentifier<any>>();

  const register = <T>(
    id: ServiceIdentifier<T>,
    value: T | Partial<T> | SyncDescriptor<T>,
    isInstance: boolean,
    overwrite: boolean,
  ): void => {
    if (overwrite || !serviceCollection.has(id)) {
      serviceCollection.set(id, value as T | SyncDescriptor<T>);
    }
    if (isInstance) {
      instanceIds.add(id);
    }
  };

  const baseReg: ServiceRegistration = {
    define: (id, ctor) => register(id, new SyncDescriptor(ctor), false, false),
    defineInstance: (id, instance) => register(id, instance, true, false),
    definePartialInstance: (id, instance) => register(id, instance, true, false),
  };

  for (const group of options.base ?? []) {
    group(baseReg);
  }

  if (options.additionalServices) {
    const overrideReg: ServiceRegistration = {
      define: (id, ctor) => register(id, new SyncDescriptor(ctor), false, true),
      defineInstance: (id, instance) => register(id, instance, true, true),
      definePartialInstance: (id, instance) => register(id, instance, true, true),
    };
    options.additionalServices(overrideReg);
  }

  const instantiationService = disposables.add(
    new TestInstantiationService(serviceCollection, options.strict ?? false),
  );
  disposables.add(toDisposable(() => {
    const serviceDisposables: IDisposable[] = [];
    for (const id of instanceIds) {
      const instance = serviceCollection.get(id);
      if (isDisposable(instance)) {
        serviceDisposables.push(instance);
      }
    }
    dispose(serviceDisposables);
  }));
  return instantiationService;
}
