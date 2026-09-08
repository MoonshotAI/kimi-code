import { Emitter, type Event } from '#/_base/event';

import type { Runtime, RuntimeBinding, RuntimeCapability, RuntimeLease } from './runtime';

export const RUNTIME_DRAIN_TIMEOUT_MS = 5_000;

export type RuntimeErrorCode = 'runtime.not_found' | 'runtime.unavailable' | 'runtime.capability_unavailable' | 'runtime.conflict';

export class RuntimeError extends Error {
  constructor(readonly code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = 'RuntimeError';
  }
}

export interface RuntimeResource {
  dispose(): void | Promise<void>;
}

interface Generation {
  readonly runtime: Runtime;
  readonly resources: Set<RuntimeResource>;
  readonly statusSubscription: { dispose(): void };
  leases: number;
  draining: boolean;
  disposed: boolean;
  drainPromise?: Promise<void>;
  releaseDrain?: () => void;
}

export interface RuntimeRegistryChange {
  readonly runtimeId: string;
  readonly current?: Runtime;
  readonly status?: Runtime['status'] | 'draining';
}

export interface RuntimeGenerationSnapshot {
  readonly runtimeId: string;
  readonly generation: string;
  readonly status: Runtime['status'];
  readonly capabilities: readonly RuntimeCapability[];
}

export interface RuntimeRegistrySnapshot {
  readonly workspaceId: string;
  readonly runtimes: readonly RuntimeGenerationSnapshot[];
}

export interface RuntimeRegistrationHandle {
  readonly runtimeId: string;
  replace(runtime: Runtime): Promise<void>;
  remove(): Promise<void>;
}

export interface RuntimeRegistryBatchEntry {
  readonly runtime: Runtime;
  readonly current?: Runtime;
  readonly registration?: RuntimeRegistrationHandle;
}

export interface RuntimeRegistryBatchResult {
  readonly registrations: readonly RuntimeRegistrationHandle[];
  readonly cleanup: Promise<void>;
}

export class RuntimeRegistry {
  private readonly currentGenerations = new Map<string, Generation>();
  private readonly changeEmitter = new Emitter<RuntimeRegistryChange>();
  readonly onDidChange: Event<RuntimeRegistryChange> = this.changeEmitter.event;
  private disposing = false;

  constructor(
    readonly workspaceId: string,
    private readonly drainTimeoutMs = RUNTIME_DRAIN_TIMEOUT_MS,
  ) {}

  list(): readonly Runtime[] {
    return [...this.currentGenerations.values()].map((value) => value.runtime);
  }

  snapshot(): RuntimeRegistrySnapshot {
    return {
      workspaceId: this.workspaceId,
      runtimes: this.list().map((runtime) => ({
        runtimeId: runtime.identity.runtimeId,
        generation: runtime.identity.generation,
        status: runtime.status,
        capabilities: [...runtime.capabilities],
      })),
    };
  }

  current(runtimeId: string): Runtime | undefined {
    return this.currentGenerations.get(runtimeId)?.runtime;
  }

  inspect(binding: RuntimeBinding): Runtime {
    if (binding.workspaceId !== this.workspaceId) {
      throw new RuntimeError('runtime.not_found', `workspace ${binding.workspaceId} is not ${this.workspaceId}`);
    }
    const runtime = this.currentGenerations.get(binding.runtimeId)?.runtime;
    if (runtime === undefined) {
      throw new RuntimeError('runtime.not_found', `runtime ${binding.runtimeId} does not exist in workspace ${this.workspaceId}`);
    }
    return runtime;
  }

  prepare(runtime: Runtime, expectedRuntimeId?: string): void {
    if (this.disposing) throw new RuntimeError('runtime.unavailable', `runtime registry ${this.workspaceId} is disposing`);
    this.assertPrepared(runtime, expectedRuntimeId);
  }

  register(runtime: Runtime): RuntimeRegistrationHandle {
    return this.publishBatch([{ runtime }]).registrations[0]!;
  }

  publishBatch(entries: readonly RuntimeRegistryBatchEntry[]): RuntimeRegistryBatchResult {
    if (this.disposing) throw new RuntimeError('runtime.unavailable', `runtime registry ${this.workspaceId} is disposing`);
    const runtimeIds = new Set<string>();
    const prepared = entries.map((entry) => {
      const runtimeId = entry.runtime.identity.runtimeId;
      if (runtimeIds.has(runtimeId)) {
        throw new RuntimeError('runtime.conflict', `runtime ${runtimeId} appears twice in one registry batch`);
      }
      runtimeIds.add(runtimeId);
      const replacement = entry.current !== undefined || entry.registration !== undefined;
      if (replacement && (entry.current === undefined || entry.registration === undefined)) {
        throw new Error(`runtime ${runtimeId} replacement requires its current runtime and registration`);
      }
      this.assertPrepared(entry.runtime, replacement ? runtimeId : undefined);
      const previous = this.currentGenerations.get(runtimeId);
      if (!replacement) {
        if (previous !== undefined) {
          throw new RuntimeError('runtime.conflict', `runtime ${runtimeId} already exists in workspace ${this.workspaceId}`);
        }
      } else {
        if (entry.registration!.runtimeId !== runtimeId) {
          throw new Error(`runtime registration ${entry.registration!.runtimeId} cannot replace ${runtimeId}`);
        }
        if (previous?.runtime !== entry.current) {
          throw new RuntimeError('runtime.conflict', `runtime ${runtimeId} changed before registry batch publication`);
        }
      }
      return { entry, previous };
    });
    const generations: Generation[] = [];
    try {
      for (const item of prepared) generations.push(this.createGeneration(item.entry.runtime));
    } catch (error) {
      for (const generation of generations) generation.statusSubscription.dispose();
      throw error;
    }
    const registrations = prepared.map((item) =>
      item.entry.registration ?? this.createRegistration(item.entry.runtime.identity.runtimeId),
    );
    for (let index = 0; index < prepared.length; index += 1) {
      const runtimeId = prepared[index]!.entry.runtime.identity.runtimeId;
      this.currentGenerations.set(runtimeId, generations[index]!);
    }
    for (const generation of generations) this.publish(generation);
    const cleanup = Promise.all(
      prepared.flatMap((item) => item.previous === undefined ? [] : [this.drain(item.previous)]),
    ).then(() => {});
    return { registrations, cleanup };
  }

  acquire(binding: RuntimeBinding, required: readonly RuntimeCapability[] = []): RuntimeLease {
    if (binding.workspaceId !== this.workspaceId) {
      throw new RuntimeError('runtime.not_found', `workspace ${binding.workspaceId} is not ${this.workspaceId}`);
    }
    const generation = this.currentGenerations.get(binding.runtimeId);
    if (generation === undefined) {
      throw new RuntimeError('runtime.not_found', `runtime ${binding.runtimeId} does not exist in workspace ${this.workspaceId}`);
    }
    if (generation.draining || !runtimeStatusAllows(generation.runtime, required)) {
      throw new RuntimeError('runtime.unavailable', `runtime ${binding.runtimeId} is ${generation.draining ? 'draining' : generation.runtime.status}`);
    }
    for (const capability of required) {
      if (!generation.runtime.capabilities.has(capability)) {
        throw new RuntimeError('runtime.capability_unavailable', `runtime ${binding.runtimeId} does not provide ${capability}`);
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
      runtime: generation.runtime,
      track: <T extends RuntimeResource>(resource: T): T => {
        if (!active || generation.draining) throw new RuntimeError('runtime.unavailable', `runtime ${binding.runtimeId} is draining`);
        const originalDispose = resource.dispose.bind(resource);
        let disposed = false;
        resource.dispose = function () {
          if (disposed) return;
          disposed = true;
          generation.resources.delete(resource);
          return originalDispose();
        } as T['dispose'];
        generation.resources.add(resource);
        return resource;
      },
      dispose: release,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposing) return;
    this.disposing = true;
    const generations = [...this.currentGenerations.values()];
    this.currentGenerations.clear();
    for (const generation of generations.reverse()) await this.drain(generation);
    this.changeEmitter.dispose();
  }

  private createRegistration(runtimeId: string): RuntimeRegistrationHandle {
    let active = true;
    let operation = Promise.resolve();
    const enqueue = (work: () => Promise<void>): Promise<void> => {
      const next = operation.then(work, work);
      operation = next.catch(() => {});
      return next;
    };
    let handle: RuntimeRegistrationHandle;
    handle = {
      runtimeId,
      replace: (replacement) => enqueue(async () => {
        if (!active || this.disposing) {
          await replacement.dispose();
          throw new Error(`runtime registration ${runtimeId} is disposed`);
        }
        const previous = this.currentGenerations.get(runtimeId);
        if (previous === undefined) {
          await replacement.dispose();
          throw new Error(`runtime ${runtimeId} is not registered`);
        }
        let publication: RuntimeRegistryBatchResult;
        try {
          publication = this.publishBatch([{
            runtime: replacement,
            current: previous.runtime,
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
        const previous = this.currentGenerations.get(runtimeId);
        if (previous === undefined) return;
        this.currentGenerations.delete(runtimeId);
        this.changeEmitter.fire({ runtimeId });
        await this.drain(previous);
      }),
    };
    return handle;
  }

  private createGeneration(runtime: Runtime): Generation {
    const generation = {
      runtime,
      resources: new Set<RuntimeResource>(),
      leases: 0,
      draining: false,
      disposed: false,
      statusSubscription: undefined as unknown as { dispose(): void },
    };
    generation.statusSubscription = runtime.onDidChangeStatus((status) => {
      if (!generation.draining && !generation.disposed && this.currentGenerations.get(runtime.identity.runtimeId) === generation) {
        this.changeEmitter.fire({ runtimeId: runtime.identity.runtimeId, current: runtime, status });
      }
    });
    return generation;
  }

  private publish(generation: Generation): void {
    this.changeEmitter.fire({
      runtimeId: generation.runtime.identity.runtimeId,
      current: generation.runtime,
      status: generation.runtime.status,
    });
  }

  private assertPrepared(runtime: Runtime, expectedRuntimeId?: string): void {
    if (runtime.identity.workspaceId !== this.workspaceId) throw new Error(`runtime belongs to workspace ${runtime.identity.workspaceId}`);
    if (expectedRuntimeId !== undefined && runtime.identity.runtimeId !== expectedRuntimeId) throw new Error(`replacement runtime id must remain ${expectedRuntimeId}`);
    if (runtime.status === 'draining' || runtime.status === 'disposed') throw new RuntimeError('runtime.unavailable', `runtime ${runtime.identity.runtimeId} is ${runtime.status}`);
    for (const capability of runtime.capabilities) {
      if (runtime[capability] === undefined) throw new RuntimeError('runtime.capability_unavailable', `runtime ${runtime.identity.runtimeId} declares ${capability} without an implementation`);
    }
  }

  private drain(generation: Generation): Promise<void> {
    generation.drainPromise ??= (async () => {
      generation.draining = true;
      generation.statusSubscription.dispose();
      this.changeEmitter.fire({
        runtimeId: generation.runtime.identity.runtimeId,
        current: generation.runtime,
        status: 'draining',
      });
      const resources = [...generation.resources].reverse();
      generation.resources.clear();
      for (const resource of resources) {
        try {
          await resource.dispose();
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
        await generation.runtime.dispose();
      }
    })();
    return generation.drainPromise;
  }
}

export function runtimeStatusAllows(runtime: Runtime, required: readonly RuntimeCapability[]): boolean {
  if (runtime.status === 'ready') return true;
  return runtime.status === 'degraded' && required.every((capability) => runtime.capabilities.has(capability));
}
