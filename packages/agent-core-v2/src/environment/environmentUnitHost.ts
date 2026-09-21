import { type IInstantiationService, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import type { Environment } from './environment';
import type { EnvironmentRegistrationHandle, EnvironmentRegistry } from './environmentRegistry';

export interface EnvironmentUnitImports {
  readonly root: readonly ServiceIdentifier<unknown>[];
}

export interface EnvironmentProviderEnvironmentHandle {
  readonly environmentId: string;
  update(prepare: () => Environment | Promise<Environment>): Promise<void>;
  remove(): Promise<void>;
}

export interface EnvironmentProviderHost {
  get<T>(id: ServiceIdentifier<T>): T;
  registerEnvironment(environment: Environment): EnvironmentProviderEnvironmentHandle;
}

export interface EnvironmentUnitHandle {
  remove(): Promise<void>;
  dispose(): Promise<void>;
}

export interface EnvironmentUnitHost {
  provide<T extends { dispose(): void | Promise<void> }>(
    imports: EnvironmentUnitImports,
    prepare: (host: EnvironmentProviderHost) => Promise<T>,
  ): Promise<EnvironmentUnitHandle>;
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

interface EnvironmentUnitTransaction {
  readonly host: EnvironmentProviderHost;
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
  readonly attachment: { dispose(): void | Promise<void> };
  readonly transaction: EnvironmentUnitTransaction;
  active: boolean;
  handle?: EnvironmentUnitHandle;
}

class SharedEnvironmentUnitHost implements EnvironmentUnitHost {
  private readonly records: EnvironmentUnitRecord[] = [];
  private readonly recordByHandle = new Map<EnvironmentUnitHandle, EnvironmentUnitRecord>();
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
        if (!failed) failure = error;
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

  private createTransaction(imports: EnvironmentUnitImports): EnvironmentUnitTransaction {
    const declared = new Set(imports.root);
    if (declared.size !== imports.root.length) {
      throw new Error('environment unit dependency manifest contains duplicate declarations');
    }
    const services = new ServiceCollection();
    const environments: StagedEnvironment[] = [];
    let active = true;
    let committed = false;
    for (const id of imports.root) {
      services.set(id, this.root.invokeFunction((accessor) => accessor.get(id)));
    }
    const child = this.root.createChild(services);
    const host: EnvironmentProviderHost = {
      get: <T>(id: ServiceIdentifier<T>): T => {
        if (!active || !declared.has(id)) throw new Error(`environment unit dependency is not declared ${id.toString()}`);
        return child.invokeFunction((accessor) => accessor.get(id));
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
      environments,
      commit: () => {
        if (!active) throw new Error('environment unit transaction is disposed');
        for (const staged of environments) {
          if (this.registry.current(staged.environment.identity.environmentId) !== undefined) {
            throw new Error(`environment ${staged.environment.identity.environmentId} already exists`);
          }
          this.registry.prepare(staged.environment);
        }
        const publication = this.registry.publishBatch(environments.map((staged) => ({ environment: staged.environment })));
        for (let index = 0; index < environments.length; index += 1) {
          environments[index]!.registration = publication.registrations[index]!;
        }
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
        try {
          child.dispose();
        } catch (error) {          if (!failed) failure = error;
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
