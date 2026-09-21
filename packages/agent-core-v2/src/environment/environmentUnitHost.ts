import { SyncDescriptor } from '#/_base/di/descriptors';
import { _util, type IInstantiationService, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import type { Environment } from './environment';
import type { EnvironmentRegistrationHandle, EnvironmentRegistry } from './environmentRegistry';

type EnvironmentUnitConstructor<T> = new (...args: never[]) => T;

export interface EnvironmentUnitImports {
  readonly root: readonly ServiceIdentifier<unknown>[];
  readonly imports: readonly ServiceIdentifier<unknown>[];
  readonly local: readonly ServiceIdentifier<unknown>[];
}

export interface EnvironmentProviderEnvironmentHandle {
  readonly environmentId: string;
  update(prepare: () => Environment | Promise<Environment>): Promise<void>;
  remove(): Promise<void>;
}

export interface EnvironmentProviderHost {
  get<T>(id: ServiceIdentifier<T>): T;
  provide<T>(id: ServiceIdentifier<T>, ctor: EnvironmentUnitConstructor<T>, ...staticArguments: unknown[]): T;
  registerEnvironment(environment: Environment): EnvironmentProviderEnvironmentHandle;
}

export interface EnvironmentUnitHandle {
  update<T extends { dispose(): void | Promise<void> }>(
    imports: EnvironmentUnitImports,
    prepare: (host: EnvironmentProviderHost) => Promise<T>,
  ): Promise<void>;
  remove(): Promise<void>;
  dispose(): Promise<void>;
}

export interface EnvironmentUnitHost {
  provide<T extends { dispose(): void | Promise<void> }>(
    imports: EnvironmentUnitImports,
    prepare: (host: EnvironmentProviderHost) => Promise<T>,
  ): Promise<EnvironmentUnitHandle>;
  update<T extends { dispose(): void | Promise<void> }>(
    handle: EnvironmentUnitHandle,
    imports: EnvironmentUnitImports,
    prepare: (host: EnvironmentProviderHost) => Promise<T>,
  ): Promise<void>;
  remove(handle: EnvironmentUnitHandle): Promise<void>;
  dispose(): Promise<void>;
}

export interface EnvironmentUnitHostFactory {
  create(root: IInstantiationService, registry: EnvironmentRegistry): EnvironmentUnitHost;
}

export class SharedEnvironmentUnitHostFactory implements EnvironmentUnitHostFactory {
  create(root: IInstantiationService, registry: EnvironmentRegistry): EnvironmentUnitHost {
    return new SharedEnvironmentUnitHost(root, registry);
  }
}

interface LocalRegistration {
  readonly id: ServiceIdentifier<unknown>;
  readonly value: unknown;
}

interface EnvironmentUnitTransaction {
  readonly host: EnvironmentProviderHost;
  readonly units: Array<{ dispose(): void | Promise<void> }>;
  readonly local: LocalRegistration[];
  readonly environments: StagedEnvironment[];
  dispose(): Promise<void>;
  commit(): { readonly cleanup: Promise<void> };
}

interface StagedEnvironment {
  environment: Environment;
  registration?: EnvironmentRegistrationHandle;
  active: boolean;
}

interface EnvironmentUnitRecord {
  attachment: { dispose(): void | Promise<void> };
  transaction: EnvironmentUnitTransaction;
  active: boolean;
  handle?: EnvironmentUnitHandle;
}

class SharedEnvironmentUnitHost implements EnvironmentUnitHost {
  private readonly records: EnvironmentUnitRecord[] = [];
  private readonly recordByHandle = new Map<EnvironmentUnitHandle, EnvironmentUnitRecord>();
  private readonly locals = new Map<ServiceIdentifier<unknown>, LocalRegistration>();
  private tail = Promise.resolve();
  private closing = false;

  constructor(private readonly root: IInstantiationService, private readonly registry: EnvironmentRegistry) {}

  provide<T extends { dispose(): void | Promise<void> }>(
    imports: EnvironmentUnitImports,
    prepare: (host: EnvironmentProviderHost) => Promise<T>,
  ): Promise<EnvironmentUnitHandle> {
    if (this.closing) return Promise.reject(new Error('environment unit host is disposed'));
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
      const record: EnvironmentUnitRecord = { attachment, transaction, active: true };
      const handle = this.handle(record);
      record.handle = handle;
      this.records.push(record);
      this.recordByHandle.set(handle, record);
      await cleanup;
      return handle;
    });
  }

  update<T extends { dispose(): void | Promise<void> }>(
    handle: EnvironmentUnitHandle,
    imports: EnvironmentUnitImports,
    prepare: (host: EnvironmentProviderHost) => Promise<T>,
  ): Promise<void> {
    if (this.closing) return Promise.reject(new Error('environment unit host is disposed'));
    return this.enqueue(async () => {
      this.assertOpen();
      const record = this.find(handle);
      if (!record.active) throw new Error('environment unit handle is disposed');
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

  remove(handle: EnvironmentUnitHandle): Promise<void> {
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
      for (const record of [...this.records].toReversed()) {
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

  private handle(_record: EnvironmentUnitRecord): EnvironmentUnitHandle {
    const handle: EnvironmentUnitHandle = {
      update: (imports, prepare) => this.update(handle, imports, prepare),
      remove: () => this.remove(handle),
      dispose: () => this.remove(handle),
    };
    return handle;
  }

  private find(handle: EnvironmentUnitHandle): EnvironmentUnitRecord {
    const record = this.recordByHandle.get(handle);
    if (record === undefined) throw new Error('environment unit handle is not owned by this host');
    return record;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.then(() => {}, () => {});
    return next;
  }

  private assertOpen(): void {
    if (this.closing) throw new Error('environment unit host is disposed');
  }

  private createTransaction(imports: EnvironmentUnitImports, previous?: EnvironmentUnitTransaction): EnvironmentUnitTransaction {
    const declared = new Set([...imports.root, ...imports.imports, ...imports.local]);
    if (declared.size !== imports.root.length + imports.imports.length + imports.local.length) {
      throw new Error('environment unit dependency manifest contains duplicate declarations');
    }
    const services = new ServiceCollection();
    const units: Array<{ dispose(): void | Promise<void> }> = [];
    const local: LocalRegistration[] = [];
    const environments: StagedEnvironment[] = [];
    let active = true;
    let committed = false;
    for (const id of imports.root) {
      services.set(id, this.root.invokeFunction((accessor) => accessor.get(id)));
    }
    for (const id of imports.imports) {
      const registration = this.locals.get(id);
      if (registration === undefined) throw new Error(`environment unit import is not available ${id.toString()}`);
      services.set(id, registration.value);
    }
    const child = this.root.createChild(services);
    const host: EnvironmentProviderHost = {
      get: <T>(id: ServiceIdentifier<T>): T => {
        if (!active || !declared.has(id)) throw new Error(`environment unit dependency is not declared ${id.toString()}`);
        if (imports.local.includes(id) && !local.some((registration) => registration.id === id)) {
          throw new Error(`environment unit local dependency is not available ${id.toString()}`);
        }
        return child.invokeFunction((accessor) => accessor.get(id));
      },
      provide: <T>(id: ServiceIdentifier<T>, ctor: EnvironmentUnitConstructor<T>, ...staticArguments: unknown[]): T => {
        if (!active || !imports.local.includes(id)) throw new Error(`environment unit local registration is not declared ${id.toString()}`);
        if (local.some((registration) => registration.id === id)) throw new Error(`environment unit local registration already exists ${id.toString()}`);
        for (const dependency of _util.getInstanceDependencies(ctor as unknown as _util.DI_TARGET_OBJ)) {
          if (!declared.has(dependency.id)) throw new Error(`environment unit dependency is not declared ${dependency.id.toString()}`);
          if (imports.local.includes(dependency.id) && !local.some((registration) => registration.id === dependency.id)) {
            throw new Error(`environment unit local dependency is not available ${dependency.id.toString()}`);
          }
        }
        const unit = child.createInstance(new SyncDescriptor<T>(ctor as never, staticArguments)) as T;
        services.set(id, unit);
        local.push({ id, value: unit });
        const disposable = unit as { dispose?: () => void | Promise<void> };
        if (typeof disposable.dispose === 'function') units.push(disposable as { dispose(): void | Promise<void> });
        return unit;
      },
      registerEnvironment: (environment) => {
        if (!active) throw new Error('environment unit transaction is disposed');
        if (environments.some((entry) => entry.environment.identity.environmentId === environment.identity.environmentId)) {
          throw new Error(`environment ${environment.identity.environmentId} is registered twice in one transaction`);
        }
        const staged: StagedEnvironment = { environment, active: true };
        if (committed) staged.registration = this.registry.register(environment);
        environments.push(staged);
        const handle: EnvironmentProviderEnvironmentHandle = {
          environmentId: environment.identity.environmentId,
          update: (replacement) => this.updateEnvironment(staged, replacement),
          remove: async () => {
            try {
              await this.removeEnvironment(staged);
            } finally {
              const index = environments.indexOf(staged);
              if (index >= 0) environments.splice(index, 1);
            }
          },
        };
        return handle;
      },
    };
    const transaction: EnvironmentUnitTransaction = {
      host,
      units,
      local,
      environments,
      commit: () => {
        if (!active) throw new Error('environment unit transaction is disposed');
        const previousEnvironments = new Map(
          previous?.environments.map((staged) => [staged.environment.identity.environmentId, staged]) ?? [],
        );
        const previousLocals = new Set(previous?.local.map((registration) => registration.id) ?? []);
        for (const staged of environments) {
          const current = this.registry.current(staged.environment.identity.environmentId);
          const previousEnvironment = previousEnvironments.get(staged.environment.identity.environmentId);
          if (current !== undefined && previousEnvironment === undefined) {
            throw new Error(`environment ${staged.environment.identity.environmentId} already exists`);
          }
          this.registry.prepare(
            staged.environment,
            previousEnvironment === undefined ? undefined : staged.environment.identity.environmentId,
          );
        }
        for (const registration of local) {
          if (this.locals.has(registration.id) && !previousLocals.has(registration.id)) {
            throw new Error(`environment unit local registration already exists ${registration.id.toString()}`);
          }
        }
        const publication = this.registry.publishBatch(environments.map((staged) => {
          const previousEnvironment = previousEnvironments.get(staged.environment.identity.environmentId);
          if (previousEnvironment?.registration === undefined) return { environment: staged.environment };
          return {
            environment: staged.environment,
            current: previousEnvironment.environment,
            registration: previousEnvironment.registration,
          };
        }));
        for (let index = 0; index < environments.length; index += 1) {
          const staged = environments[index]!;
          const previousEnvironment = previousEnvironments.get(staged.environment.identity.environmentId);
          if (previousEnvironment !== undefined) previousEnvironment.active = false;
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
        for (const staged of environments.toReversed()) {
          if (!staged.active) continue;
          staged.active = false;
          try {
            if (staged.registration === undefined) await staged.environment.dispose();
            else await staged.registration.remove();
          } catch (error) {
            if (!failed) failure = error;
            failed = true;
          }
        }
        for (const registration of local.toReversed()) {
          if (this.locals.get(registration.id) === registration) this.locals.delete(registration.id);
        }
        for (const unit of units.toReversed()) {
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

  private updateEnvironment(staged: StagedEnvironment, prepare: () => Environment | Promise<Environment>): Promise<void> {
    if (this.closing) return Promise.reject(new Error('environment unit host is disposed'));
    return this.enqueue(async () => {
      if (!staged.active || staged.registration === undefined) throw new Error('environment registration is not active');
      const replacement = await prepare();
      let cleanup: Promise<void>;
      try {
        this.registry.prepare(replacement, staged.environment.identity.environmentId);
        cleanup = this.registry.publishBatch([{
          environment: replacement,
          current: staged.environment,
          registration: staged.registration,
        }]).cleanup;
      } catch (error) {
        await replacement.dispose();
        throw error;
      }
      staged.environment = replacement;
      await cleanup;
    });
  }

  private async removeEnvironment(staged: StagedEnvironment): Promise<void> {
    if (!staged.active) return;
    staged.active = false;
    if (staged.registration === undefined) await staged.environment.dispose();
    else await staged.registration.remove();
  }
}
