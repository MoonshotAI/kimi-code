import { Emitter, type Event } from '#/_base/event';

import { LOCAL_ENVIRONMENT_ID, type Environment, type EnvironmentBinding, type EnvironmentCapability, type EnvironmentLease } from './environment';
import type { RemoteEnvironmentEntry } from './remoteEnvironmentDeclaration';

export const ENVIRONMENT_DRAIN_TIMEOUT_MS = 5_000;

export type EnvironmentErrorCode = 'environment.not_found' | 'environment.unavailable' | 'environment.capability_unavailable' | 'environment.conflict' | 'environment.invalid_cwd';

export class EnvironmentError extends Error {
  constructor(readonly code: EnvironmentErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'EnvironmentError';
  }
}

export interface EnvironmentResource {
  dispose(): void | Promise<void>;
}

interface TrackedResource {
  readonly sessionId: string | undefined;
  readonly dispose: () => void | Promise<void>;
}

interface Generation {
  readonly environment: Environment;
  readonly resources: Set<TrackedResource>;
  readonly statusSubscription: { dispose(): void };
  leases: number;
  draining: boolean;
  disposed: boolean;
  drainPromise?: Promise<void>;
  releaseDrain?: () => void;
}

export interface EnvironmentRegistryChange {
  readonly environmentId: string;
  readonly current?: Environment;
  readonly status?: Environment['status'] | 'draining';
}

export interface EnvironmentGenerationSnapshot {
  readonly environmentId: string;
  readonly generation: string;
  readonly status: Environment['status'];
  readonly capabilities: readonly EnvironmentCapability[];
  readonly connectError?: string;
}

export interface EnvironmentRegistrySnapshot {
  readonly workspaceId: string;
  readonly environments: readonly EnvironmentGenerationSnapshot[];
}

export type EnvironmentEntryType = 'local' | 'ssh' | 'docker' | 'command';

export interface EnvironmentEntryInfo {
  readonly environmentId: string;
  readonly type: EnvironmentEntryType;
  readonly status: Environment['status'];
  readonly generation: string;
  readonly capabilities: readonly EnvironmentCapability[];
  readonly defaultCwd?: string;
  readonly connectError?: string;
}

export function environmentEntryType(
  environmentId: string,
  entry: RemoteEnvironmentEntry | undefined,
): EnvironmentEntryType {
  if (environmentId === LOCAL_ENVIRONMENT_ID) return 'local';
  if (entry === undefined || 'command' in entry) return 'command';
  return entry.type;
}

export function environmentEntryInfo(
  environment: EnvironmentGenerationSnapshot,
  entry: RemoteEnvironmentEntry | undefined,
): EnvironmentEntryInfo {
  return {
    environmentId: environment.environmentId,
    type: environmentEntryType(environment.environmentId, entry),
    status: environment.status,
    generation: environment.generation,
    capabilities: [...environment.capabilities],
    defaultCwd: entry?.defaultCwd,
    connectError: environment.connectError,
  };
}

export interface EnvironmentRegistrationHandle {
  readonly environmentId: string;
  replace(environment: Environment): Promise<void>;
  remove(): Promise<void>;
}

export interface EnvironmentRegistryBatchEntry {
  readonly environment: Environment;
  readonly current?: Environment;
  readonly registration?: EnvironmentRegistrationHandle;
}

export interface EnvironmentRegistryBatchResult {
  readonly registrations: readonly EnvironmentRegistrationHandle[];
  readonly cleanup: Promise<void>;
}

export class EnvironmentRegistry {
  private readonly currentGenerations = new Map<string, Generation>();
  private readonly changeEmitter = new Emitter<EnvironmentRegistryChange>();
  readonly onDidChange: Event<EnvironmentRegistryChange> = this.changeEmitter.event;
  private disposing = false;

  constructor(
    readonly workspaceId: string,
    private readonly drainTimeoutMs = ENVIRONMENT_DRAIN_TIMEOUT_MS,
  ) {}

  list(): readonly Environment[] {
    return [...this.currentGenerations.values()].map((value) => value.environment);
  }

  snapshot(): EnvironmentRegistrySnapshot {
    return {
      workspaceId: this.workspaceId,
      environments: this.list().map((environment) => ({
        environmentId: environment.identity.environmentId,
        generation: environment.identity.generation,
        status: environment.status,
        capabilities: [...environment.capabilities],
        connectError: environment.connectError,
      })),
    };
  }

  current(environmentId: string): Environment | undefined {
    return this.currentGenerations.get(environmentId)?.environment;
  }

  inspect(binding: EnvironmentBinding): Environment {
    if (binding.workspaceId !== this.workspaceId) {
      throw new EnvironmentError('environment.not_found', `workspace ${binding.workspaceId} is not ${this.workspaceId}`);
    }
    const environment = this.currentGenerations.get(binding.environmentId)?.environment;
    if (environment === undefined) {
      throw new EnvironmentError('environment.not_found', `environment ${binding.environmentId} does not exist in workspace ${this.workspaceId}`);
    }
    return environment;
  }

  prepare(environment: Environment, expectedEnvironmentId?: string): void {
    if (this.disposing) throw new EnvironmentError('environment.unavailable', `environment registry ${this.workspaceId} is disposing`);
    this.assertPrepared(environment, expectedEnvironmentId);
  }

  register(environment: Environment): EnvironmentRegistrationHandle {
    return this.publishBatch([{ environment }]).registrations[0]!;
  }

  publishBatch(entries: readonly EnvironmentRegistryBatchEntry[]): EnvironmentRegistryBatchResult {
    if (this.disposing) throw new EnvironmentError('environment.unavailable', `environment registry ${this.workspaceId} is disposing`);
    const environmentIds = new Set<string>();
    const prepared = entries.map((entry) => {
      const environmentId = entry.environment.identity.environmentId;
      if (environmentIds.has(environmentId)) {
        throw new EnvironmentError('environment.conflict', `environment ${environmentId} appears twice in one registry batch`);
      }
      environmentIds.add(environmentId);
      const replacement = entry.current !== undefined || entry.registration !== undefined;
      if (replacement && (entry.current === undefined || entry.registration === undefined)) {
        throw new Error(`environment ${environmentId} replacement requires its current environment and registration`);
      }
      this.assertPrepared(entry.environment, replacement ? environmentId : undefined);
      const previous = this.currentGenerations.get(environmentId);
      if (!replacement) {
        if (previous !== undefined) {
          throw new EnvironmentError('environment.conflict', `environment ${environmentId} already exists in workspace ${this.workspaceId}`);
        }
      } else {
        if (entry.registration!.environmentId !== environmentId) {
          throw new Error(`environment registration ${entry.registration!.environmentId} cannot replace ${environmentId}`);
        }
        if (previous?.environment !== entry.current) {
          throw new EnvironmentError('environment.conflict', `environment ${environmentId} changed before registry batch publication`);
        }
      }
      return { entry, previous };
    });
    const generations: Generation[] = [];
    try {
      for (const item of prepared) generations.push(this.createGeneration(item.entry.environment));
    } catch (error) {
      for (const generation of generations) generation.statusSubscription.dispose();
      throw error;
    }
    const registrations = prepared.map((item) =>
      item.entry.registration ?? this.createRegistration(item.entry.environment.identity.environmentId),
    );
    for (let index = 0; index < prepared.length; index += 1) {
      const environmentId = prepared[index]!.entry.environment.identity.environmentId;
      this.currentGenerations.set(environmentId, generations[index]!);
    }
    for (const generation of generations) {
      this.publish(generation);
    }
    const cleanup = Promise.all(
      prepared.flatMap((item) => item.previous === undefined ? [] : [this.drain(item.previous)]),
    ).then(() => {});
    return { registrations, cleanup };
  }

  async acquireWhenReady(binding: EnvironmentBinding, required: readonly EnvironmentCapability[] = []): Promise<EnvironmentLease> {
    if (binding.workspaceId !== this.workspaceId) {
      throw new EnvironmentError('environment.not_found', `workspace ${binding.workspaceId} is not ${this.workspaceId}`);
    }
    const generation = this.currentGenerations.get(binding.environmentId);
    const pending = generation !== undefined && !generation.draining && !environmentStatusAllows(generation.environment, required)
      ? generation.environment.whenReady
      : undefined;
    if (pending !== undefined) await pending;
    return this.acquire(binding, required);
  }

  acquire(binding: EnvironmentBinding, required: readonly EnvironmentCapability[] = []): EnvironmentLease {
    if (binding.workspaceId !== this.workspaceId) {
      throw new EnvironmentError('environment.not_found', `workspace ${binding.workspaceId} is not ${this.workspaceId}`);
    }
    const generation = this.currentGenerations.get(binding.environmentId);
    if (generation === undefined) {
      throw new EnvironmentError('environment.not_found', `environment ${binding.environmentId} does not exist in workspace ${this.workspaceId}`);
    }
    if (generation.draining || !environmentStatusAllows(generation.environment, required)) {
      const reason = generation.environment.connectError?.split('\n', 1)[0];
      throw new EnvironmentError(
        'environment.unavailable',
        `environment ${binding.environmentId} is ${generation.draining ? 'draining' : generation.environment.status}${reason === undefined || reason.length === 0 ? '' : `: ${reason}`}`,
      );
    }
    for (const capability of required) {
      if (!generation.environment.capabilities.has(capability)) {
        throw new EnvironmentError('environment.capability_unavailable', `environment ${binding.environmentId} does not provide ${capability}`);
      }
    }
    generation.leases += 1;
    let active = true;
    const release = (): void => {
      if (!active) return;
      active = false;
      generation.leases -= 1;
      if (generation.leases === 0) generation.releaseDrain?.();
    };
    return {
      environment: generation.environment,
      track: <T extends EnvironmentResource>(resource: T, sessionId?: string): T => {
        if (!active || generation.draining) throw new EnvironmentError('environment.unavailable', `environment ${binding.environmentId} is draining`);
        const originalDispose = resource.dispose.bind(resource);
        let disposed = false;
        const record: TrackedResource = {
          sessionId,
          dispose: () => {
            if (disposed) return;
            disposed = true;
            generation.resources.delete(record);
            return originalDispose();
          },
        };
        generation.resources.add(record);
        return new Proxy(resource, {
          get: (target, property) => {
            if (property === 'dispose') {
              const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
              if (descriptor === undefined || descriptor.configurable === true || descriptor.writable === true) {
                return record.dispose;
              }
            }
            return Reflect.get(target, property, target);
          },
          set: (target, property, value) => Reflect.set(target, property, value),
        });
      },
      dispose: release,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposing) return;
    this.disposing = true;
    const generations = [...this.currentGenerations.values()];
    this.currentGenerations.clear();
    for (const generation of generations.toReversed()) await this.drain(generation);
    this.changeEmitter.dispose();
  }

  async drainSession(sessionId: string): Promise<void> {
    const records: TrackedResource[] = [];
    for (const generation of this.currentGenerations.values()) {
      for (const record of generation.resources) {
        if (record.sessionId === sessionId) records.push(record);
      }
    }
    for (const record of records.toReversed()) {
      try {
        await record.dispose();
      } catch {}
    }
  }

  private createRegistration(environmentId: string): EnvironmentRegistrationHandle {
    let active = true;
    let operation = Promise.resolve();
    const enqueue = (work: () => Promise<void>): Promise<void> => {
      const next = operation.then(work, work);
      operation = next.catch(() => {});
      return next;
    };
    let handle: EnvironmentRegistrationHandle;
    handle = {
      environmentId,
      replace: (replacement) => enqueue(async () => {
        if (!active || this.disposing) {
          await replacement.dispose();
          throw new Error(`environment registration ${environmentId} is disposed`);
        }
        const previous = this.currentGenerations.get(environmentId);
        if (previous === undefined) {
          await replacement.dispose();
          throw new Error(`environment ${environmentId} is not registered`);
        }
        let publication: EnvironmentRegistryBatchResult;
        try {
          publication = this.publishBatch([{
            environment: replacement,
            current: previous.environment,
            registration: handle,
          }]);
        } catch (error) {
          await replacement.dispose();
          throw error;
        }
        await publication.cleanup;
      }),
      remove: () => enqueue(async () => {
        if (!active) return;
        active = false;
        const previous = this.currentGenerations.get(environmentId);
        if (previous === undefined) return;
        this.currentGenerations.delete(environmentId);
        this.changeEmitter.fire({ environmentId });
        await this.drain(previous);
      }),
    };
    return handle;
  }

  private createGeneration(environment: Environment): Generation {
    const generation = {
      environment,
      resources: new Set<TrackedResource>(),
      leases: 0,
      draining: false,
      disposed: false,
      statusSubscription: undefined as unknown as { dispose(): void },
    };
    generation.statusSubscription = environment.onDidChangeStatus((status) => {
      if (!generation.draining && !generation.disposed && this.currentGenerations.get(environment.identity.environmentId) === generation) {
        this.changeEmitter.fire({ environmentId: environment.identity.environmentId, current: environment, status });
      }
    });
    return generation;
  }

  private publish(generation: Generation): void {
    this.changeEmitter.fire({
      environmentId: generation.environment.identity.environmentId,
      current: generation.environment,
      status: generation.environment.status,
    });
  }

  private assertPrepared(environment: Environment, expectedEnvironmentId?: string): void {
    if (environment.identity.workspaceId !== this.workspaceId) throw new Error(`environment belongs to workspace ${environment.identity.workspaceId}`);
    if (expectedEnvironmentId !== undefined && environment.identity.environmentId !== expectedEnvironmentId) throw new Error(`replacement environment id must remain ${expectedEnvironmentId}`);
    if (environment.status === 'draining' || environment.status === 'disposed') throw new EnvironmentError('environment.unavailable', `environment ${environment.identity.environmentId} is ${environment.status}`);
    for (const capability of environment.capabilities) {
      if (environment[capability] === undefined) throw new EnvironmentError('environment.capability_unavailable', `environment ${environment.identity.environmentId} declares ${capability} without an implementation`);
    }
  }

  private drain(generation: Generation): Promise<void> {
    generation.drainPromise ??= (async () => {
      generation.draining = true;
      generation.statusSubscription.dispose();
      this.changeEmitter.fire({
        environmentId: generation.environment.identity.environmentId,
        current: generation.environment,
        status: 'draining',
      });
      const records = [...generation.resources].toReversed();
      generation.resources.clear();
      for (const record of records) {
        try {
          await record.dispose();
        } catch {}
      }
      if (generation.leases > 0) {
        await Promise.race([
          new Promise<void>((resolve) => { generation.releaseDrain = resolve; }),
          new Promise<void>((resolve) => setTimeout(resolve, this.drainTimeoutMs)),
        ]);
      }
      if (!generation.disposed) {
        generation.disposed = true;
        await generation.environment.dispose();
      }
    })();
    return generation.drainPromise;
  }
}

export function environmentStatusAllows(environment: Environment, required: readonly EnvironmentCapability[]): boolean {
  if (environment.status === 'ready') return true;
  return environment.status === 'degraded' && required.every((capability) => environment.capabilities.has(capability));
}
