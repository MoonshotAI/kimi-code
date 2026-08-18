import { SyncDescriptor } from '#/_base/di/descriptors';
import { _util, type IInstantiationService, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import type { Runtime } from './runtime';
import type { RuntimeRegistrationHandle, RuntimeRegistry } from './runtimeRegistry';

type RuntimeUnitConstructor<T> = new (...args: never[]) => T;

export interface RuntimeUnitImports {
  readonly root: readonly ServiceIdentifier<unknown>[];
  readonly imports: readonly ServiceIdentifier<unknown>[];
  readonly local: readonly ServiceIdentifier<unknown>[];
}

export interface RuntimeProviderRuntimeHandle {
  readonly runtimeId: string;
  update(prepare: () => Runtime | Promise<Runtime>): Promise<void>;
  remove(): Promise<void>;
}

export interface RuntimeProviderHost {
  get<T>(id: ServiceIdentifier<T>): T;
  provide<T>(id: ServiceIdentifier<T>, ctor: RuntimeUnitConstructor<T>, ...staticArguments: unknown[]): T;
  registerRuntime(runtime: Runtime): RuntimeProviderRuntimeHandle;
}

export interface RuntimeUnitHandle {
  update<T extends { dispose(): void | Promise<void> }>(
    imports: RuntimeUnitImports,
    prepare: (host: RuntimeProviderHost) => Promise<T>,
  ): Promise<void>;
  remove(): Promise<void>;
  dispose(): Promise<void>;
}

export interface RuntimeUnitHost {
  provide<T extends { dispose(): void | Promise<void> }>(
    imports: RuntimeUnitImports,
    prepare: (host: RuntimeProviderHost) => Promise<T>,
  ): Promise<RuntimeUnitHandle>;
  update<T extends { dispose(): void | Promise<void> }>(
    handle: RuntimeUnitHandle,
    imports: RuntimeUnitImports,
    prepare: (host: RuntimeProviderHost) => Promise<T>,
  ): Promise<void>;
  remove(handle: RuntimeUnitHandle): Promise<void>;
  dispose(): Promise<void>;
}

export interface RuntimeUnitHostFactory {
  create(root: IInstantiationService, registry: RuntimeRegistry): RuntimeUnitHost;
}

export class SharedRuntimeUnitHostFactory implements RuntimeUnitHostFactory {
  create(root: IInstantiationService, registry: RuntimeRegistry): RuntimeUnitHost {
    return new SharedRuntimeUnitHost(root, registry);
  }
}

interface LocalRegistration {
  readonly id: ServiceIdentifier<unknown>;
  readonly value: unknown;
}

interface RuntimeUnitTransaction {
  readonly host: RuntimeProviderHost;
  readonly units: Array<{ dispose(): void | Promise<void> }>;
  readonly local: LocalRegistration[];
  readonly runtimes: StagedRuntime[];
  dispose(): Promise<void>;
  commit(): { readonly cleanup: Promise<void> };
}

interface StagedRuntime {
  runtime: Runtime;
  registration?: RuntimeRegistrationHandle;
  active: boolean;
}

interface RuntimeUnitRecord {
  attachment: { dispose(): void | Promise<void> };
  transaction: RuntimeUnitTransaction;
  active: boolean;
  handle?: RuntimeUnitHandle;
}

class SharedRuntimeUnitHost implements RuntimeUnitHost {
  private readonly records: RuntimeUnitRecord[] = [];
  private readonly recordByHandle = new Map<RuntimeUnitHandle, RuntimeUnitRecord>();
  private readonly locals = new Map<ServiceIdentifier<unknown>, LocalRegistration>();
  private tail = Promise.resolve();
  private closing = false;

  constructor(private readonly root: IInstantiationService, private readonly registry: RuntimeRegistry) {}

  provide<T extends { dispose(): void | Promise<void> }>(
    imports: RuntimeUnitImports,
    prepare: (host: RuntimeProviderHost) => Promise<T>,
  ): Promise<RuntimeUnitHandle> {
    if (this.closing) return Promise.reject(new Error('runtime unit host is disposed'));
    return this.enqueue(async () => {
      this.assertOpen();
      const transaction = this.createTransaction(imports);
      let attachment: T;
      let cleanup: Promise<void>;
      try {
        attachment = await prepare(transaction.host);
        cleanup = transaction.commit().cleanup;
      } catch (error) {
        await transaction.dispose();
        throw error;
      }
      const record: RuntimeUnitRecord = { attachment, transaction, active: true };
      const handle = this.handle(record);
      record.handle = handle;
      this.records.push(record);
      this.recordByHandle.set(handle, record);
      await cleanup;
      return handle;
    });
  }

  update<T extends { dispose(): void | Promise<void> }>(
    handle: RuntimeUnitHandle,
    imports: RuntimeUnitImports,
    prepare: (host: RuntimeProviderHost) => Promise<T>,
  ): Promise<void> {
    if (this.closing) return Promise.reject(new Error('runtime unit host is disposed'));
    return this.enqueue(async () => {
      this.assertOpen();
      const record = this.find(handle);
      if (!record.active) throw new Error('runtime unit handle is disposed');
      const transaction = this.createTransaction(imports, record.transaction);
      let attachment: T;
      let cleanup: Promise<void>;
      try {
        attachment = await prepare(transaction.host);
        cleanup = transaction.commit().cleanup;
      } catch (error) {
        await transaction.dispose();
        throw error;
      }
      const previousAttachment = record.attachment;
      const previousTransaction = record.transaction;
      record.attachment = attachment;
      record.transaction = transaction;
      let failure: unknown;
      let failed = false;
      try {
        await cleanup;
      } catch (error) {
        failure = error;
        failed = true;
      }
      try {
        await previousAttachment.dispose();
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
      try {
        await previousTransaction.dispose();
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
      if (failed) throw failure;
    });
  }

  remove(handle: RuntimeUnitHandle): Promise<void> {
    return this.enqueue(async () => {
      const record = this.find(handle);
      if (!record.active) return;
      record.active = false;
      let failure: unknown;
      let failed = false;
      try {
        await record.attachment.dispose();
      } catch (error) {
        failure = error;
        failed = true;
      }
      try {
        await record.transaction.dispose();
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
      const index = this.records.indexOf(record);
      if (index >= 0) this.records.splice(index, 1);
      this.recordByHandle.delete(handle);
      if (failed) throw failure;
    });
  }

  async dispose(): Promise<void> {
    if (this.closing) return this.tail;
    this.closing = true;
    await this.tail;
    await this.enqueue(async () => {
      let failure: unknown;
      let failed = false;
      for (const record of [...this.records].reverse()) {
        if (!record.active) continue;
        record.active = false;
        try {
          await record.attachment.dispose();
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
        try {
          await record.transaction.dispose();
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
        if (record.handle !== undefined) this.recordByHandle.delete(record.handle);
      }
      this.records.length = 0;
      if (failed) throw failure;
    });
    await this.tail;
  }

  private handle(_record: RuntimeUnitRecord): RuntimeUnitHandle {
    const handle: RuntimeUnitHandle = {
      update: (imports, prepare) => this.update(handle, imports, prepare),
      remove: () => this.remove(handle),
      dispose: () => this.remove(handle),
    };
    return handle;
  }

  private find(handle: RuntimeUnitHandle): RuntimeUnitRecord {
    const record = this.recordByHandle.get(handle);
    if (record === undefined) throw new Error('runtime unit handle is not owned by this host');
    return record;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.then(() => {}, () => {});
    return next;
  }

  private assertOpen(): void {
    if (this.closing) throw new Error('runtime unit host is disposed');
  }

  private createTransaction(imports: RuntimeUnitImports, previous?: RuntimeUnitTransaction): RuntimeUnitTransaction {
    const declared = new Set([...imports.root, ...imports.imports, ...imports.local]);
    if (declared.size !== imports.root.length + imports.imports.length + imports.local.length) {
      throw new Error('runtime unit dependency manifest contains duplicate declarations');
    }
    const services = new ServiceCollection();
    const units: Array<{ dispose(): void | Promise<void> }> = [];
    const local: LocalRegistration[] = [];
    const runtimes: StagedRuntime[] = [];
    let active = true;
    let committed = false;
    for (const id of imports.root) {
      services.set(id, this.root.invokeFunction((accessor) => accessor.get(id)));
    }
    for (const id of imports.imports) {
      const registration = this.locals.get(id);
      if (registration === undefined) throw new Error(`runtime unit import is not available ${id.toString()}`);
      services.set(id, registration.value);
    }
    const child = this.root.createChild(services);
    const host: RuntimeProviderHost = {
      get: <T>(id: ServiceIdentifier<T>): T => {
        if (!active || !declared.has(id)) throw new Error(`runtime unit dependency is not declared ${id.toString()}`);
        if (imports.local.includes(id) && !local.some((registration) => registration.id === id)) {
          throw new Error(`runtime unit local dependency is not available ${id.toString()}`);
        }
        return child.invokeFunction((accessor) => accessor.get(id));
      },
      provide: <T>(id: ServiceIdentifier<T>, ctor: RuntimeUnitConstructor<T>, ...staticArguments: unknown[]): T => {
        if (!active || !imports.local.includes(id)) throw new Error(`runtime unit local registration is not declared ${id.toString()}`);
        if (local.some((registration) => registration.id === id)) throw new Error(`runtime unit local registration already exists ${id.toString()}`);
        for (const dependency of _util.getInstanceDependencies(ctor as unknown as _util.DI_TARGET_OBJ)) {
          if (!declared.has(dependency.id)) throw new Error(`runtime unit dependency is not declared ${dependency.id.toString()}`);
          if (imports.local.includes(dependency.id) && !local.some((registration) => registration.id === dependency.id)) {
            throw new Error(`runtime unit local dependency is not available ${dependency.id.toString()}`);
          }
        }
        const unit = child.createInstance(new SyncDescriptor<T>(ctor as never, staticArguments)) as T;
        services.set(id, unit);
        local.push({ id, value: unit });
        const disposable = unit as { dispose?: () => void | Promise<void> };
        if (typeof disposable.dispose === 'function') units.push(disposable as { dispose(): void | Promise<void> });
        return unit;
      },
      registerRuntime: (runtime) => {
        if (!active) throw new Error('runtime unit transaction is disposed');
        if (runtimes.some((entry) => entry.runtime.identity.runtimeId === runtime.identity.runtimeId)) {
          throw new Error(`runtime ${runtime.identity.runtimeId} is registered twice in one transaction`);
        }
        const staged: StagedRuntime = { runtime, active: true };
        if (committed) staged.registration = this.registry.register(runtime);
        runtimes.push(staged);
        const handle: RuntimeProviderRuntimeHandle = {
          runtimeId: runtime.identity.runtimeId,
          update: (replacement) => this.updateRuntime(staged, replacement),
          remove: () => this.removeRuntime(staged),
        };
        return handle;
      },
    };
    const transaction: RuntimeUnitTransaction = {
      host,
      units,
      local,
      runtimes,
      commit: () => {
        if (!active) throw new Error('runtime unit transaction is disposed');
        const previousRuntimes = new Map(
          previous?.runtimes.map((staged) => [staged.runtime.identity.runtimeId, staged]) ?? [],
        );
        const previousLocals = new Set(previous?.local.map((registration) => registration.id) ?? []);
        for (const staged of runtimes) {
          const current = this.registry.current(staged.runtime.identity.runtimeId);
          const previousRuntime = previousRuntimes.get(staged.runtime.identity.runtimeId);
          if (current !== undefined && previousRuntime === undefined) {
            throw new Error(`runtime ${staged.runtime.identity.runtimeId} already exists`);
          }
          this.registry.prepare(
            staged.runtime,
            previousRuntime === undefined ? undefined : staged.runtime.identity.runtimeId,
          );
        }
        for (const registration of local) {
          if (this.locals.has(registration.id) && !previousLocals.has(registration.id)) {
            throw new Error(`runtime unit local registration already exists ${registration.id.toString()}`);
          }
        }
        const publication = this.registry.publishBatch(runtimes.map((staged) => {
          const previousRuntime = previousRuntimes.get(staged.runtime.identity.runtimeId);
          if (previousRuntime?.registration === undefined) return { runtime: staged.runtime };
          return {
            runtime: staged.runtime,
            current: previousRuntime.runtime,
            registration: previousRuntime.registration,
          };
        }));
        for (let index = 0; index < runtimes.length; index += 1) {
          const staged = runtimes[index]!;
          const previousRuntime = previousRuntimes.get(staged.runtime.identity.runtimeId);
          if (previousRuntime !== undefined) previousRuntime.active = false;
          staged.registration = publication.registrations[index];
        }
        for (const registration of local) this.locals.set(registration.id, registration);
        committed = true;
        return { cleanup: publication.cleanup };
      },
      dispose: async () => {
        if (!active) return;
        active = false;
        let failure: unknown;
        let failed = false;
        for (const staged of runtimes.reverse()) {
          if (!staged.active) continue;
          staged.active = false;
          try {
            if (staged.registration === undefined) await staged.runtime.dispose();
            else await staged.registration.remove();
          } catch (error) {
            if (!failed) failure = error;
            failed = true;
          }
        }
        for (const registration of local.reverse()) {
          if (this.locals.get(registration.id) === registration) this.locals.delete(registration.id);
        }
        for (const unit of units.reverse()) {
          try {
            await unit.dispose();
          } catch (error) {
            if (!failed) failure = error;
            failed = true;
          }
        }
        try {
          child.dispose();
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
        if (failed) throw failure;
      },
    };
    return transaction;
  }

  private updateRuntime(staged: StagedRuntime, prepare: () => Runtime | Promise<Runtime>): Promise<void> {
    if (this.closing) return Promise.reject(new Error('runtime unit host is disposed'));
    return this.enqueue(async () => {
      if (!staged.active || staged.registration === undefined) throw new Error('runtime registration is not active');
      const replacement = await prepare();
      let cleanup: Promise<void>;
      try {
        this.registry.prepare(replacement, staged.runtime.identity.runtimeId);
        cleanup = this.registry.publishBatch([{
          runtime: replacement,
          current: staged.runtime,
          registration: staged.registration,
        }]).cleanup;
      } catch (error) {
        await replacement.dispose();
        throw error;
      }
      staged.runtime = replacement;
      await cleanup;
    });
  }

  private async removeRuntime(staged: StagedRuntime): Promise<void> {
    if (!staged.active) return;
    staged.active = false;
    if (staged.registration === undefined) await staged.runtime.dispose();
    else await staged.registration.remove();
  }
}
