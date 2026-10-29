import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';

import { z } from 'zod';

import { readPrivateFile, writePrivateFile } from '../services/auth/privateFiles';
import type { AuthPrincipal } from '../services/auth/principal';
import {
  DEVICE_BRIDGE_MAX_BUFFERED_BYTES,
  DEVICE_BRIDGE_MAX_PENDING_PER_DEVICE,
  DEVICE_BRIDGE_PROTOCOL_VERSION,
  deviceCapabilitiesSchema,
  deviceEnvironmentSchema,
  deviceIdSchema,
  remoteRuntimeMethods,
  type DeviceCapabilities,
  type DeviceCommand,
  type DeviceEnvironment,
  type DeviceHello,
  type DeviceServerFrame,
  type RemoteRuntimeMethod,
  type RuntimeResult,
} from './protocol';

export interface DeviceBridgeTransport {
  readonly bufferedAmount: number;
  send(frame: DeviceServerFrame): void;
}

export interface DeviceRootSnapshot {
  readonly root: string;
  readonly displayName?: string;
  readonly registeredBy: AuthPrincipal;
  readonly registeredAt: string;
  readonly connectionId: string;
  readonly generation: string;
}

export interface DeviceSnapshot {
  readonly deviceId: string;
  readonly displayName: string;
  readonly runtimeId: string;
  readonly online: boolean;
  readonly connectionId?: string;
  readonly generation?: string;
  readonly protocolVersion: number;
  readonly environment: DeviceEnvironment;
  readonly capabilities: DeviceCapabilities;
  readonly roots: readonly DeviceRootSnapshot[];
  readonly connectedBy?: AuthPrincipal;
  readonly lastSeenAt: string;
}

export interface DeviceRegistryChange {
  readonly reason: 'connection' | 'roots';
  readonly device: DeviceSnapshot;
}

type DeviceRootRecord = DeviceRootSnapshot;

interface DeviceRecord {
  readonly deviceId: string;
  displayName: string;
  environment: DeviceEnvironment;
  generationCounter: number;
  roots: Map<string, DeviceRootRecord>;
  lastSeenAt: string;
  online?: ActiveDevice;
}

interface PendingRequest {
  readonly requestId: string;
  readonly connection: ActiveDevice;
  readonly mutating: boolean;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export interface ActiveDevice {
  readonly deviceId: string;
  readonly connectionId: string;
  readonly generation: string;
  readonly principal: AuthPrincipal;
  readonly transport: DeviceBridgeTransport;
  readonly pending: Map<string, PendingRequest>;
}

export interface DeviceRegistryOptions {
  readonly catalogFile: string;
  readonly defaultTimeoutMs?: number;
  readonly maxBufferedBytes?: number;
}

const principalSchema = z.object({
  userId: z.string().min(1),
  displayName: z.string().min(1),
});

const persistedRootSchema = z.object({
  root: z.string().min(1),
  display_name: z.string().min(1).optional(),
  registered_by: principalSchema,
  registered_at: z.string().min(1),
  connection_id: z.string().min(1),
  generation: z.string().min(1),
});

const persistedDeviceSchema = z.object({
  device_id: deviceIdSchema,
  display_name: z.string().min(1),
  environment: deviceEnvironmentSchema,
  generation_counter: z.number().int().nonnegative(),
  roots: z.array(persistedRootSchema),
});

const persistedCatalogSchema = z.object({
  version: z.literal(1),
  devices: z.array(persistedDeviceSchema),
});

type PersistedCatalog = z.infer<typeof persistedCatalogSchema>;

const inspectedRootSchema = z.object({
  root: z.string().min(1),
  is_directory: z.literal(true),
});

export class DeviceBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly options: { readonly retryable?: boolean; readonly uncertain?: boolean } = {},
  ) {
    super(message);
    this.name = 'DeviceBridgeError';
  }

  get retryable(): boolean | undefined {
    return this.options.retryable;
  }

  get uncertain(): boolean | undefined {
    return this.options.uncertain;
  }
}

export class DeviceRegistry {
  private readonly records = new Map<string, DeviceRecord>();
  private readonly connections = new Map<string, ActiveDevice>();
  private readonly listeners = new Set<(change: DeviceRegistryChange) => void>();
  private readonly defaultTimeoutMs: number;
  private readonly maxBufferedBytes: number;
  private mutationTail: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(private readonly opts: DeviceRegistryOptions) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 15_000;
    this.maxBufferedBytes = opts.maxBufferedBytes ?? DEVICE_BRIDGE_MAX_BUFFERED_BYTES;
  }

  static async load(opts: DeviceRegistryOptions): Promise<DeviceRegistry> {
    const registry = new DeviceRegistry(opts);
    let raw: Buffer;
    try {
      raw = await readPrivateFile(opts.catalogFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return registry;
      throw error;
    }
    const catalog = persistedCatalogSchema.parse(JSON.parse(raw.toString('utf8')));
    for (const device of catalog.devices) {
      if (registry.records.has(device.device_id)) throw new Error(`duplicate device in catalog: ${device.device_id}`);
      const roots = new Map<string, DeviceRootRecord>();
      for (const root of device.roots) {
        const normalized = normalizeDeviceRoot(root.root);
        if (roots.has(normalized)) throw new Error(`duplicate root in catalog: ${device.device_id}`);
        roots.set(normalized, {
          root: normalized,
          displayName: root.display_name,
          registeredBy: root.registered_by,
          registeredAt: root.registered_at,
          connectionId: root.connection_id,
          generation: root.generation,
        });
      }
      registry.records.set(device.device_id, {
        deviceId: device.device_id,
        displayName: device.display_name,
        environment: device.environment,
        generationCounter: device.generation_counter,
        roots,
        lastSeenAt: new Date(0).toISOString(),
      });
    }
    return registry;
  }

  get catalogFile(): string {
    return this.opts.catalogFile;
  }

  onDidChange(listener: (change: DeviceRegistryChange) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  list(): DeviceSnapshot[] {
    return [...this.records.values()].map((record) => this.snapshot(record));
  }

  get(deviceId: string): DeviceSnapshot | undefined {
    const record = this.records.get(deviceId);
    return record === undefined ? undefined : this.snapshot(record);
  }

  connection(deviceId: string): ActiveDevice | undefined {
    return this.records.get(deviceId)?.online;
  }

  async connect(
    hello: DeviceHello,
    principal: AuthPrincipal,
    transport: DeviceBridgeTransport,
  ): Promise<ActiveDevice> {
    if (this.closed) throw new DeviceBridgeError('runtime.unavailable', 'device registry is closed');
    if (hello.environment.path_class !== 'posix') {
      throw new DeviceBridgeError('runtime.unsupported', 'device bridge protocol v1 supports posix paths only');
    }
    const existing = this.records.get(hello.device_id)?.online;
    if (existing !== undefined || this.connections.has(hello.connection_id)) {
      throw new DeviceBridgeError('device.conflict', `device ${hello.device_id} is already connected`);
    }
    const record = this.records.get(hello.device_id) ?? {
      deviceId: hello.device_id,
      displayName: hello.display_name,
      environment: hello.environment,
      generationCounter: 0,
      roots: new Map<string, DeviceRootRecord>(),
      lastSeenAt: new Date().toISOString(),
    };
    record.displayName = hello.display_name;
    record.environment = hello.environment;
    record.generationCounter += 1;
    record.lastSeenAt = new Date().toISOString();
    const connection: ActiveDevice = {
      deviceId: hello.device_id,
      connectionId: hello.connection_id,
      generation: `g_${record.generationCounter}`,
      principal,
      transport,
      pending: new Map<string, PendingRequest>(),
    };
    record.online = connection;
    this.records.set(record.deviceId, record);
    this.connections.set(connection.connectionId, connection);
    try {
      await this.persist();
    } catch (error) {
      this.records.get(record.deviceId)!.online = undefined;
      this.connections.delete(connection.connectionId);
      throw error;
    }
    this.emit('connection', record);
    return connection;
  }

  disconnect(connection: ActiveDevice): void {
    const record = this.records.get(connection.deviceId);
    if (record?.online !== connection) return;
    record.online = undefined;
    record.lastSeenAt = new Date().toISOString();
    this.connections.delete(connection.connectionId);
    this.rejectPending(connection, new DeviceBridgeError('runtime.unavailable', `device ${connection.deviceId} disconnected`, { retryable: true }));
    this.emit('connection', record);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const record of this.records.values()) {
      if (record.online !== undefined) this.disconnect(record.online);
    }
    this.listeners.clear();
    await this.mutationTail;
  }

  handleCommand(connection: ActiveDevice, frame: DeviceCommand): void {
    if (!this.isCurrent(connection)) {
      this.send(connection, {
        type: 'device.error',
        request_id: frame.request_id,
        error: { code: 'runtime.stale_generation', message: 'connection generation is no longer active' },
      });
      return;
    }
    void this.registerRoot(connection, frame).then(
      (root) => this.send(connection, { type: 'device.result', request_id: frame.request_id, result: root }),
      (error: unknown) => this.send(connection, {
        type: 'device.error',
        request_id: frame.request_id,
        error: errorPayload(error),
      }),
    );
  }

  handleResult(connection: ActiveDevice, frame: RuntimeResult): void {
    if (!this.isCurrent(connection) || !this.isCurrentResponse(connection, frame)) return;
    const pending = connection.pending.get(frame.request_id);
    if (pending === undefined) return;
    connection.pending.delete(frame.request_id);
    clearTimeout(pending.timer);
    pending.resolve(frame.result);
  }

  handleError(connection: ActiveDevice, frame: Extract<DeviceClientErrorFrame, { type: 'runtime.error' }>): void {
    if (!this.isCurrent(connection) || !this.isCurrentResponse(connection, frame)) return;
    const pending = connection.pending.get(frame.request_id);
    if (pending === undefined) return;
    connection.pending.delete(frame.request_id);
    clearTimeout(pending.timer);
    pending.reject(new DeviceBridgeError(frame.error.code, frame.error.message, {
      retryable: frame.error.retryable,
      uncertain: frame.error.uncertain,
    }));
  }

  touch(connection: ActiveDevice): void {
    if (!this.isCurrent(connection)) return;
    const record = this.records.get(connection.deviceId)!;
    record.lastSeenAt = new Date().toISOString();
  }

  request(
    deviceId: string,
    method: RemoteRuntimeMethod,
    params: unknown,
    options: { readonly mutating?: boolean; readonly timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new DeviceBridgeError('runtime.unavailable', 'device registry is closed'));
    if (!(remoteRuntimeMethods as readonly string[]).includes(method)) {
      return Promise.reject(new DeviceBridgeError('runtime.unsupported', `unsupported bridge method ${method}`));
    }
    const connection = this.records.get(deviceId)?.online;
    if (connection === undefined) {
      return Promise.reject(new DeviceBridgeError('runtime.unavailable', `device ${deviceId} is offline`, { retryable: true }));
    }
    if (connection.pending.size >= DEVICE_BRIDGE_MAX_PENDING_PER_DEVICE) {
      return Promise.reject(new DeviceBridgeError('runtime.busy', `too many pending requests for ${deviceId}`, { retryable: true }));
    }
    if (connection.transport.bufferedAmount > this.maxBufferedBytes) {
      return Promise.reject(new DeviceBridgeError('runtime.busy', `device ${deviceId} is backpressured`, { retryable: true }));
    }
    const requestId = randomUUID();
    const mutating = options.mutating === true;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(requestId);
        reject(timeoutError(deviceId, requestId, mutating));
      }, timeoutMs);
      timer.unref?.();
      connection.pending.set(requestId, {
        requestId,
        connection,
        mutating,
        timer,
        resolve,
        reject,
      });
      try {
        connection.transport.send({
          type: 'runtime.rpc',
          protocol_version: DEVICE_BRIDGE_PROTOCOL_VERSION,
          device_id: deviceId,
          connection_id: connection.connectionId,
          generation: connection.generation,
          request_id: requestId,
          method,
          params,
          timeout_ms: timeoutMs,
        });
      } catch (error) {
        connection.pending.delete(requestId);
        clearTimeout(timer);
        reject(new DeviceBridgeError(
          mutating ? 'runtime.write_uncertain' : 'runtime.unavailable',
          `failed to send ${method} to ${deviceId}: ${error instanceof Error ? error.message : String(error)}`,
          { retryable: !mutating, uncertain: mutating },
        ));
      }
    });
  }

  async authorizeWorkspace(deviceId: string, root: string): Promise<{ readonly root: string; readonly device: DeviceSnapshot }> {
    const record = this.records.get(deviceId);
    if (record === undefined) throw new DeviceBridgeError('runtime.not_found', `device ${deviceId} is not registered`);
    if (record.online === undefined) throw new DeviceBridgeError('runtime.unavailable', `device ${deviceId} is offline`, { retryable: true });
    const normalized = normalizeDeviceRoot(root);
    if (!record.roots.has(normalized)) {
      throw new DeviceBridgeError('runtime.denied', `root ${normalized} was not authorized by ${deviceId}`);
    }
    const inspected = await this.inspectRoot(record.online, normalized);
    if (normalizeDeviceRoot(inspected.root) !== normalized) {
      throw new DeviceBridgeError('runtime.denied', `authorized root ${normalized} resolved to ${inspected.root}`);
    }
    return { root: normalized, device: this.snapshot(record) };
  }

  private async registerRoot(connection: ActiveDevice, frame: DeviceCommand): Promise<DeviceRootSnapshot> {
    if (frame.command !== 'root.register') {
      throw new DeviceBridgeError('runtime.unsupported', `unsupported device command ${String(frame.command)}`);
    }
    const inspected = await this.inspectRoot(connection, frame.root.path);
    const root = normalizeDeviceRoot(inspected.root);
    const record = this.records.get(connection.deviceId)!;
    const snapshot: DeviceRootSnapshot = {
      root,
      displayName: frame.root.display_name,
      registeredBy: connection.principal,
      registeredAt: new Date().toISOString(),
      connectionId: connection.connectionId,
      generation: connection.generation,
    };
    record.roots.set(root, snapshot);
    record.lastSeenAt = new Date().toISOString();
    await this.persist();
    this.emit('roots', record);
    return snapshot;
  }

  private async inspectRoot(connection: ActiveDevice, path: string): Promise<{ readonly root: string; readonly isDirectory: true }> {
    const raw = await this.request(connection.deviceId, 'device.inspect_root', { path });
    const parsed = inspectedRootSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DeviceBridgeError('runtime.protocol_error', `device ${connection.deviceId} returned an invalid root inspection`);
    }
    return { root: parsed.data.root, isDirectory: parsed.data.is_directory };
  }

  private snapshot(record: DeviceRecord): DeviceSnapshot {
    const online = record.online;
    return {
      deviceId: record.deviceId,
      displayName: record.displayName,
      runtimeId: `desktop:${record.deviceId}`,
      online: online !== undefined,
      connectionId: online?.connectionId,
      generation: online?.generation,
      protocolVersion: DEVICE_BRIDGE_PROTOCOL_VERSION,
      environment: record.environment,
      capabilities: deviceCapabilitiesSchema.parse({ fs: true, process: false, terminal: false }),
      roots: [...record.roots.values()].map((root) => ({ ...root, registeredBy: { ...root.registeredBy } })),
      connectedBy: online?.principal,
      lastSeenAt: record.lastSeenAt,
    };
  }

  private isCurrent(connection: ActiveDevice): boolean {
    return this.records.get(connection.deviceId)?.online === connection && this.connections.get(connection.connectionId) === connection;
  }

  private isCurrentResponse(
    connection: ActiveDevice,
    frame: { readonly device_id: string; readonly connection_id: string; readonly generation: string; readonly protocol_version: number },
  ): boolean {
    return frame.protocol_version === DEVICE_BRIDGE_PROTOCOL_VERSION &&
      frame.device_id === connection.deviceId &&
      frame.connection_id === connection.connectionId &&
      frame.generation === connection.generation;
  }

  private rejectPending(connection: ActiveDevice, error: DeviceBridgeError): void {
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(pending.mutating
        ? new DeviceBridgeError('runtime.write_uncertain', `${error.message}; outcome of ${pending.requestId} is uncertain`, { uncertain: true })
        : error);
    }
    connection.pending.clear();
  }

  private send(connection: ActiveDevice, frame: DeviceServerFrame): void {
    try {
      connection.transport.send(frame);
    } catch {
    }
  }

  private emit(reason: DeviceRegistryChange['reason'], record: DeviceRecord): void {
    const change = { reason, device: this.snapshot(record) };
    for (const listener of this.listeners) listener(change);
  }

  private persist(): Promise<void> {
    const write = async (): Promise<void> => {
      const file: PersistedCatalog = {
        version: 1,
        devices: [...this.records.values()].map((record) => ({
          device_id: record.deviceId,
          display_name: record.displayName,
          environment: record.environment,
          generation_counter: record.generationCounter,
          roots: [...record.roots.values()].map((root) => ({
            root: root.root,
            display_name: root.displayName,
            registered_by: root.registeredBy,
            registered_at: root.registeredAt,
            connection_id: root.connectionId,
            generation: root.generation,
          })),
        })),
      };
      await writePrivateFile(this.opts.catalogFile, `${JSON.stringify(file, null, 2)}\n`);
    };
    const next = this.mutationTail.then(write, write);
    this.mutationTail = next.catch(() => {});
    return next;
  }
}

interface DeviceClientErrorFrame {
  readonly type: 'runtime.error';
  readonly protocol_version: number;
  readonly device_id: string;
  readonly connection_id: string;
  readonly generation: string;
  readonly request_id: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
    readonly uncertain?: boolean;
  };
}

function normalizeDeviceRoot(root: string): string {
  const normalized = posix.resolve(root);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

function timeoutError(deviceId: string, requestId: string, mutating: boolean): DeviceBridgeError {
  return mutating
    ? new DeviceBridgeError('runtime.write_uncertain', `write ${requestId} timed out on ${deviceId}; outcome is uncertain`, { uncertain: true })
    : new DeviceBridgeError('runtime.timeout', `read ${requestId} timed out on ${deviceId}`, { retryable: true });
}

function errorPayload(error: unknown): { code: string; message: string; retryable?: boolean; uncertain?: boolean } {
  if (error instanceof DeviceBridgeError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      uncertain: error.uncertain,
    };
  }
  return { code: 'runtime.internal', message: error instanceof Error ? error.message : String(error) };
}
