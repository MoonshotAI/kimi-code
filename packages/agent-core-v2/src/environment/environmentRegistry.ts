import { Emitter, type Event } from '#/_base/event';

import { LOCAL_ENVIRONMENT_ID, type Environment, type EnvironmentBinding, type EnvironmentCapability, type EnvironmentLease } from './environment';
import type { RemoteEnvironmentEntry } from './remoteEnvironmentDeclaration';

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

interface Entry {
  environment: Environment;
  readonly resources: Set<TrackedResource>;
  readonly statusSubscription: { dispose(): void };
  closed: boolean;
}

export interface EnvironmentRegistryChange {
  readonly environmentId: string;
  readonly current?: Environment;
  readonly status?: Environment['status'];
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

export class EnvironmentRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly changeEmitter = new Emitter<EnvironmentRegistryChange>();
  readonly onDidChange: Event<EnvironmentRegistryChange> = this.changeEmitter.event;
  private disposing = false;

  constructor(readonly workspaceId: string) {}

  list(): readonly Environment[] {
    return [...this.entries.values()].map((entry) => entry.environment);
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
    return this.entries.get(environmentId)?.environment;
  }

  inspect(binding: EnvironmentBinding): Environment {
    if (binding.workspaceId !== this.workspaceId) {
      throw new EnvironmentError('environment.not_found', `workspace ${binding.workspaceId} is not ${this.workspaceId}`);
    }
    const environment = this.entries.get(binding.environmentId)?.environment;
    if (environment === undefined) {
      throw new EnvironmentError('environment.not_found', `environment ${binding.environmentId} does not exist in workspace ${this.workspaceId}`);
    }
    return environment;
  }

  register(environment: Environment): EnvironmentRegistrationHandle {
    if (this.disposing) throw new EnvironmentError('environment.unavailable', `environment registry ${this.workspaceId} is disposing`);
    this.assertReady(environment);
    const environmentId = environment.identity.environmentId;
    if (this.entries.has(environmentId)) {
      throw new EnvironmentError('environment.conflict', `environment ${environmentId} already exists in workspace ${this.workspaceId}`);
    }
    this.entries.set(environmentId, this.createEntry(environment));
    this.publish(environment);
    return this.createHandle(environmentId);
  }

  async replace(environmentId: string, environment: Environment): Promise<void> {
    if (this.disposing) {
      await environment.dispose();
      throw new EnvironmentError('environment.unavailable', `environment registry ${this.workspaceId} is disposing`);
    }
    const previous = this.entries.get(environmentId);
    if (previous === undefined) {
      await environment.dispose();
      throw new Error(`environment ${environmentId} is not registered`);
    }
    try {
      this.assertReady(environment, environmentId);
    } catch (error) {
      await environment.dispose();
      throw error;
    }
    this.entries.set(environmentId, this.createEntry(environment));
    this.publish(environment);
    await this.retire(previous);
  }

  async remove(environmentId: string): Promise<void> {
    const previous = this.entries.get(environmentId);
    if (previous === undefined) return;
    this.entries.delete(environmentId);
    this.changeEmitter.fire({ environmentId });
    await this.retire(previous);
  }

  async acquireWhenReady(binding: EnvironmentBinding, required: readonly EnvironmentCapability[] = []): Promise<EnvironmentLease> {
    if (binding.workspaceId !== this.workspaceId) {
      throw new EnvironmentError('environment.not_found', `workspace ${binding.workspaceId} is not ${this.workspaceId}`);
    }
    const entry = this.entries.get(binding.environmentId);
    const pending = entry !== undefined && !entry.closed && !environmentStatusAllows(entry.environment, required)
      ? entry.environment.whenReady
      : undefined;
    if (pending !== undefined) await pending;
    return this.acquire(binding, required);
  }

  acquire(binding: EnvironmentBinding, required: readonly EnvironmentCapability[] = []): EnvironmentLease {
    if (binding.workspaceId !== this.workspaceId) {
      throw new EnvironmentError('environment.not_found', `workspace ${binding.workspaceId} is not ${this.workspaceId}`);
    }
    const entry = this.entries.get(binding.environmentId);
    if (entry === undefined) {
      throw new EnvironmentError('environment.not_found', `environment ${binding.environmentId} does not exist in workspace ${this.workspaceId}`);
    }
    if (entry.closed || !environmentStatusAllows(entry.environment, required)) {
      const reason = entry.environment.connectError?.split('\n', 1)[0];
      throw new EnvironmentError(
        'environment.unavailable',
        `environment ${binding.environmentId} is ${entry.closed ? 'unavailable' : entry.environment.status}${reason === undefined || reason.length === 0 ? '' : `: ${reason}`}`,
      );
    }
    for (const capability of required) {
      if (!entry.environment.capabilities.has(capability)) {
        throw new EnvironmentError('environment.capability_unavailable', `environment ${binding.environmentId} does not provide ${capability}`);
      }
    }
    let active = true;
    return {
      environment: entry.environment,
      track: <T extends EnvironmentResource>(resource: T, sessionId?: string): T => {
        if (!active || entry.closed) throw new EnvironmentError('environment.unavailable', `environment ${binding.environmentId} is unavailable`);
        const originalDispose = resource.dispose.bind(resource);
        let disposed = false;
        const record: TrackedResource = {
          sessionId,
          dispose: () => {
            if (disposed) return;
            disposed = true;
            entry.resources.delete(record);
            return originalDispose();
          },
        };
        entry.resources.add(record);
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
      dispose: () => {
        active = false;
      },
    };
  }

  async dispose(): Promise<void> {
    if (this.disposing) return;
    this.disposing = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries.toReversed()) await this.retire(entry);
    this.changeEmitter.dispose();
  }

  async drainSession(sessionId: string): Promise<void> {
    const records: TrackedResource[] = [];
    for (const entry of this.entries.values()) {
      for (const record of entry.resources) {
        if (record.sessionId === sessionId) records.push(record);
      }
    }
    for (const record of records.toReversed()) {
      try {
        await record.dispose();
      } catch {}
    }
  }

  private createHandle(environmentId: string): EnvironmentRegistrationHandle {
    return {
      environmentId,
      replace: (environment) => this.replace(environmentId, environment),
      remove: () => this.remove(environmentId),
    };
  }

  private createEntry(environment: Environment): Entry {
    const entry: Entry = {
      environment,
      resources: new Set(),
      closed: false,
      statusSubscription: environment.onDidChangeStatus((status) => {
        if (!entry.closed && this.entries.get(environment.identity.environmentId) === entry) {
          this.changeEmitter.fire({ environmentId: environment.identity.environmentId, current: environment, status });
        }
      }),
    };
    return entry;
  }

  private publish(environment: Environment): void {
    this.changeEmitter.fire({
      environmentId: environment.identity.environmentId,
      current: environment,
      status: environment.status,
    });
  }

  private assertReady(environment: Environment, expectedEnvironmentId?: string): void {
    if (environment.identity.workspaceId !== this.workspaceId) throw new Error(`environment belongs to workspace ${environment.identity.workspaceId}`);
    if (expectedEnvironmentId !== undefined && environment.identity.environmentId !== expectedEnvironmentId) throw new Error(`replacement environment id must remain ${expectedEnvironmentId}`);
    if (environment.status === 'disposed') throw new EnvironmentError('environment.unavailable', `environment ${environment.identity.environmentId} is ${environment.status}`);
    for (const capability of environment.capabilities) {
      if (environment[capability] === undefined) throw new EnvironmentError('environment.capability_unavailable', `environment ${environment.identity.environmentId} declares ${capability} without an implementation`);
    }
  }

  private async retire(entry: Entry): Promise<void> {
    if (entry.closed) return;
    entry.closed = true;
    entry.statusSubscription.dispose();
    const records = [...entry.resources].toReversed();
    entry.resources.clear();
    for (const record of records) {
      try {
        await record.dispose();
      } catch {}
    }
    await entry.environment.dispose();
  }
}

export function environmentStatusAllows(environment: Environment, _required: readonly EnvironmentCapability[] = []): boolean {
  return environment.status === 'ready';
}
