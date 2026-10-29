import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import { z } from 'zod';

import { Emitter } from '#/_base/event';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import type { HostDirEntry, HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { RuntimeProviderAttachment, RuntimeProviderContext, RuntimeProviderFactory } from '#/runtime/runtimeProvider';
import type { RuntimeProviderHost } from '#/runtime/runtimeUnitHost';

import type { Runtime, RuntimeCapability, RuntimePath, RuntimeStatus } from './runtime';

export type RemoteRuntimeMethod =
  | 'device.inspect_root'
  | 'fs.read_text'
  | 'fs.write_text'
  | 'fs.append_text'
  | 'fs.read_bytes'
  | 'fs.write_bytes'
  | 'fs.create_exclusive'
  | 'fs.stat'
  | 'fs.lstat'
  | 'fs.readdir'
  | 'fs.mkdir'
  | 'fs.remove'
  | 'fs.rename'
  | 'fs.realpath';

export interface RemoteRuntimeEnvironment {
  readonly os_kind: string;
  readonly os_arch: string;
  readonly os_version: string;
  readonly shell_name: 'bash' | 'sh';
  readonly shell_path: string;
  readonly path_class: 'posix' | 'win32';
  readonly home_dir: string;
}

export interface RemoteRuntimeDeviceSnapshot {
  readonly deviceId: string;
  readonly runtimeId: string;
  readonly online: boolean;
  readonly generation?: string;
  readonly protocolVersion: number;
  readonly environment: RemoteRuntimeEnvironment;
  readonly roots: readonly { readonly root: string }[];
}

export interface RemoteRuntimeChange {
  readonly reason: 'connection' | 'roots';
  readonly device: RemoteRuntimeDeviceSnapshot;
}

export interface RemoteRuntimeConnector {
  get(deviceId: string): RemoteRuntimeDeviceSnapshot | undefined;
  onDidChange(listener: (change: RemoteRuntimeChange) => void): { dispose(): void };
  request(
    deviceId: string,
    method: RemoteRuntimeMethod,
    params: unknown,
    options?: { readonly mutating?: boolean; readonly timeoutMs?: number },
  ): Promise<unknown>;
}

export class RemoteRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly options: { readonly retryable?: boolean; readonly uncertain?: boolean } = {},
  ) {
    super(message);
    this.name = 'RemoteRuntimeError';
  }

  get retryable(): boolean | undefined {
    return this.options.retryable;
  }

  get uncertain(): boolean | undefined {
    return this.options.uncertain;
  }
}

export const REMOTE_RUNTIME_MAX_BINARY_BYTES = 10 * 1024 * 1024;

const hostStatSchema = z.object({
  is_file: z.boolean(),
  is_directory: z.boolean(),
  is_symbolic_link: z.boolean().optional(),
  size: z.number().nonnegative(),
  mtime_ms: z.number().optional(),
  ino: z.number().optional(),
});

const dirEntrySchema = z.object({
  name: z.string(),
  is_file: z.boolean(),
  is_directory: z.boolean(),
  is_symbolic_link: z.boolean().optional(),
});

const textResultSchema = z.object({ text: z.string() });
const bytesResultSchema = z.object({ base64: z.string() });
const pathResultSchema = z.object({ path: z.string().min(1) });
const createdResultSchema = z.object({ created: z.boolean() });

export class RemoteRuntimeProviderFactory implements RuntimeProviderFactory {
  readonly id = 'desktop';
  readonly imports = { root: [], imports: [], local: [] };

  constructor(
    private readonly connector: RemoteRuntimeConnector,
    private readonly enabled: () => boolean,
  ) {}

  async attach(context: RuntimeProviderContext, host: RuntimeProviderHost): Promise<RuntimeProviderAttachment> {
    const runtimeId = context.metadata.runtimeId ?? 'local';
    if (runtimeId === 'local' || !runtimeId.startsWith('desktop:')) return { dispose: () => {} };
    const deviceId = runtimeId.slice('desktop:'.length);
    if (!this.enabled()) throw new RemoteRuntimeError('runtime.unsupported', 'internal central server experiment is disabled');
    this.assertWorkspace(context, deviceId);
    let current = this.createRuntime(context, deviceId);
    const handle = host.registerRuntime(current);
    let disposed = false;
    const subscription = this.connector.onDidChange((change) => {
      if (disposed || change.reason !== 'connection' || change.device.deviceId !== deviceId) return;
      if (!change.device.online) {
        current.setStatus('disconnected');
        return;
      }
      void handle.update(() => {
        current = this.createRuntime(context, deviceId);
        return current;
      }).catch(() => {});
    });
    return {
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        subscription.dispose();
        await handle.remove();
      },
    };
  }

  private assertWorkspace(context: RuntimeProviderContext, deviceId: string): RemoteRuntimeDeviceSnapshot {
    if (deviceId.length === 0 || (context.metadata.deviceId ?? deviceId) !== deviceId) {
      throw new RemoteRuntimeError('runtime.not_found', `invalid remote runtime binding for workspace ${context.id}`);
    }
    const snapshot = this.connector.get(deviceId);
    if (snapshot === undefined) throw new RemoteRuntimeError('runtime.not_found', `device ${deviceId} is not registered`);
    const path = pathFor(snapshot.environment.path_class);
    const authorized = new Set(snapshot.roots.map((root) => normalizeRoot(path, root.root)));
    const requested = [context.root, ...context.metadata.additionalDirs];
    for (const root of requested) {
      if (!authorized.has(normalizeRoot(path, root))) {
        throw new RemoteRuntimeError('runtime.denied', `workspace root ${root} is not authorized on ${deviceId}`);
      }
    }
    return snapshot;
  }

  private createRuntime(context: RuntimeProviderContext, deviceId: string): RemoteRuntime {
    const snapshot = this.assertWorkspace(context, deviceId);
    return new RemoteRuntime(context.id, context.root, context.metadata.additionalDirs, snapshot, this.connector);
  }
}

export class RemoteRuntime implements Runtime {
  readonly identity: Runtime['identity'];
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set(['fs']);
  readonly environment: HostEnvironmentInfo;
  readonly path: RuntimePath;
  readonly workspace: Runtime['workspace'];
  readonly fs: IHostFileSystem;
  readonly process = undefined;
  readonly onDidChangeStatus;
  private readonly statusEmitter = new Emitter<RuntimeStatus>();
  private currentStatus: RuntimeStatus;

  constructor(
    workspaceId: string,
    workDir: string,
    additionalDirs: readonly string[],
    snapshot: RemoteRuntimeDeviceSnapshot,
    connector: RemoteRuntimeConnector,
  ) {
    this.identity = {
      workspaceId,
      runtimeId: snapshot.runtimeId,
      generation: snapshot.online ? snapshot.generation ?? 'online' : 'offline',
    };
    this.environment = {
      osKind: snapshot.environment.os_kind,
      osArch: snapshot.environment.os_arch,
      osVersion: snapshot.environment.os_version,
      shellName: snapshot.environment.shell_name,
      shellPath: snapshot.environment.shell_path,
      pathClass: snapshot.environment.path_class,
      homeDir: snapshot.environment.home_dir,
    };
    const path = pathFor(snapshot.environment.path_class);
    this.path = {
      separator: path.sep as '/' | '\\',
      delimiter: path.delimiter as ':' | ';',
      isAbsolute: (value) => path.isAbsolute(value),
      join: (...values) => path.join(...values),
      relative: (from, to) => path.relative(from, to),
      resolve: (...values) => path.resolve(...values),
      basename: (value) => path.basename(value),
      dirname: (value) => path.dirname(value),
    };
    this.workspace = {
      mapRoots: (roots) => ({
        workDir: path.resolve(roots.workDir),
        additionalDirs: roots.additionalDirs?.map((root) => path.resolve(root)),
      }),
    };
    this.currentStatus = snapshot.online ? 'ready' : 'disconnected';
    this.onDidChangeStatus = this.statusEmitter.event;
    this.fs = new RemoteHostFileSystem(snapshot.deviceId, [workDir, ...additionalDirs], this.path, connector);
  }

  get status(): RuntimeStatus {
    return this.currentStatus;
  }

  setStatus(status: RuntimeStatus): void {
    if (this.currentStatus === 'disposed' || this.currentStatus === status) return;
    this.currentStatus = status;
    this.statusEmitter.fire(status);
  }

  dispose(): void {
    if (this.currentStatus === 'disposed') return;
    this.currentStatus = 'disposed';
    this.statusEmitter.fire('disposed');
    this.statusEmitter.dispose();
  }
}

export class RemoteHostFileSystem implements IHostFileSystem {
  declare readonly _serviceBrand: undefined;
  private readonly roots: readonly string[];

  constructor(
    private readonly deviceId: string,
    roots: readonly string[],
    private readonly path: RuntimePath,
    private readonly connector: RemoteRuntimeConnector,
  ) {
    this.roots = roots.map((root) => normalizeRoot(path, root));
  }

  async readText(path: string, options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' }): Promise<string> {
    const resolved = await this.existingPath(path);
    const result = await this.call('fs.read_text', {
      path: resolved,
      encoding: options?.encoding,
      errors: options?.errors,
    });
    const parsed = textResultSchema.parse(result);
    assertTextSize(parsed.text);
    return parsed.text;
  }

  async writeText(path: string, data: string): Promise<void> {
    assertTextSize(data);
    const resolved = await this.writePath(path);
    await this.call('fs.write_text', { path: resolved, data }, true);
  }

  async appendText(path: string, data: string): Promise<void> {
    assertTextSize(data);
    const resolved = await this.writePath(path);
    await this.call('fs.append_text', { path: resolved, data }, true);
  }

  async readBytes(path: string, n?: number, offset = 0): Promise<Uint8Array> {
    if (n !== undefined && (!Number.isSafeInteger(n) || n < 0 || n > REMOTE_RUNTIME_MAX_BINARY_BYTES)) {
      throw new RemoteRuntimeError('runtime.too_large', `invalid remote read length ${String(n)}`);
    }
    const resolved = await this.existingPath(path);
    const result = bytesResultSchema.parse(await this.call('fs.read_bytes', { path: resolved, n, offset }));
    const bytes = Buffer.from(result.base64, 'base64');
    if (bytes.byteLength > REMOTE_RUNTIME_MAX_BINARY_BYTES) {
      throw new RemoteRuntimeError('runtime.too_large', `remote read exceeds ${REMOTE_RUNTIME_MAX_BINARY_BYTES} bytes`);
    }
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    assertBinarySize(data);
    const resolved = await this.writePath(path);
    await this.call('fs.write_bytes', { path: resolved, base64: Buffer.from(data).toString('base64') }, true);
  }

  async *readLines(path: string, options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' }): AsyncGenerator<string> {
    const text = await this.readText(path, options);
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text.codePointAt(index) !== 0x0a) continue;
      yield text.slice(start, index + 1);
      start = index + 1;
    }
    if (start < text.length) yield text.slice(start);
  }

  async createExclusive(path: string, data: Uint8Array): Promise<boolean> {
    assertBinarySize(data);
    const resolved = await this.parentSafePath(path);
    const result = createdResultSchema.parse(await this.call('fs.create_exclusive', {
      path: resolved,
      base64: Buffer.from(data).toString('base64'),
    }, true));
    return result.created;
  }

  async stat(path: string): Promise<HostFileStat> {
    const resolved = await this.existingPath(path);
    return parseStat(await this.call('fs.stat', { path: resolved }));
  }

  async lstat(path: string): Promise<HostFileStat> {
    const resolved = await this.parentSafePath(path);
    return parseStat(await this.call('fs.lstat', { path: resolved }));
  }

  async readdir(path: string): Promise<readonly HostDirEntry[]> {
    const resolved = await this.existingPath(path);
    const result = z.array(dirEntrySchema).max(100_000).parse(await this.call('fs.readdir', { path: resolved }));
    return result.map((entry) => ({
      name: entry.name,
      isFile: entry.is_file,
      isDirectory: entry.is_directory,
      isSymbolicLink: entry.is_symbolic_link,
    }));
  }

  async mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    const resolved = await this.writePath(path);
    await this.call('fs.mkdir', { path: resolved, recursive: options?.recursive ?? false }, true);
  }

  async remove(path: string): Promise<void> {
    const resolved = await this.parentSafePath(path);
    await this.call('fs.remove', { path: resolved }, true);
  }

  async rename(path: string, nextPath: string): Promise<void> {
    const source = await this.parentSafePath(path);
    const target = await this.parentSafePath(nextPath);
    await this.call('fs.rename', { path: source, next_path: target }, true);
  }

  async realpath(path: string): Promise<string> {
    return this.existingPath(path);
  }

  private async existingPath(path: string): Promise<string> {
    const resolved = this.assertContained(path);
    const result = pathResultSchema.parse(await this.call('fs.realpath', { path: resolved }));
    return this.assertContained(result.path);
  }

  private async writePath(path: string): Promise<string> {
    const resolved = this.assertContained(path);
    try {
      return await this.existingPath(resolved);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      return this.parentSafePath(resolved);
    }
  }

  private async parentSafePath(path: string): Promise<string> {
    const resolved = this.assertContained(path);
    if (this.roots.includes(normalizeRoot(this.path, resolved))) return resolved;
    const parent = this.path.dirname(resolved);
    const basename = this.path.basename(resolved);
    const realParent = await this.existingPrefix(parent);
    return this.assertContained(this.path.join(realParent, basename));
  }

  private async existingPrefix(path: string): Promise<string> {
    const tail: string[] = [];
    let current = this.assertContained(path);
    for (let index = 0; index < 256; index += 1) {
      try {
        const real = await this.existingPath(current);
        return tail.length === 0 ? real : this.assertContained(this.path.join(real, ...tail.toReversed()));
      } catch (error) {
        if (!isMissingPath(error)) throw error;
        const parent = this.path.dirname(current);
        if (parent === current) throw new RemoteRuntimeError('runtime.denied', `no existing authorized ancestor for ${path}`);
        tail.push(this.path.basename(current));
        current = parent;
      }
    }
    throw new RemoteRuntimeError('runtime.denied', `too many missing path components for ${path}`);
  }

  private assertContained(path: string): string {
    const resolved = this.path.resolve(path);
    const allowed = this.roots.some((root) => {
      const relative = this.path.relative(root, resolved);
      return relative === '' || (relative !== '..' && !relative.startsWith(`..${this.path.separator}`) && !this.path.isAbsolute(relative));
    });
    if (!allowed) throw new RemoteRuntimeError('runtime.denied', `path ${resolved} escapes authorized roots on ${this.deviceId}`);
    return resolved;
  }

  private async call(method: RemoteRuntimeMethod, params: unknown, mutating = false): Promise<unknown> {
    const snapshot = this.connector.get(this.deviceId);
    if (snapshot === undefined) throw new RemoteRuntimeError('runtime.not_found', `device ${this.deviceId} is not registered`);
    if (!snapshot.online) throw new RemoteRuntimeError('runtime.unavailable', `device ${this.deviceId} is offline`, { retryable: true });
    const authorized = new Set(snapshot.roots.map((root) => normalizeRoot(this.path, root.root)));
    if (!this.roots.some((root) => authorized.has(root))) {
      throw new RemoteRuntimeError('runtime.denied', `workspace authorization was revoked on ${this.deviceId}`);
    }
    try {
      return await this.connector.request(this.deviceId, method, params, { mutating });
    } catch (error) {
      const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
      const mapped = {
        'os.fs.not_found': 'ENOENT',
        'os.fs.not_directory': 'ENOTDIR',
        'os.fs.permission_denied': 'EACCES',
        'os.fs.already_exists': 'EEXIST',
        'os.fs.is_directory': 'EISDIR',
      }[String(code)];
      if (mapped !== undefined && error instanceof Error) {
        const candidate = error as { retryable?: boolean; uncertain?: boolean };
        throw new RemoteRuntimeError(mapped, error.message, {
          retryable: candidate.retryable,
          uncertain: candidate.uncertain,
        });
      }
      if (error instanceof Error && typeof code === 'string') throw error;
      throw new RemoteRuntimeError('runtime.internal', `remote ${method} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function pathFor(pathClass: 'posix' | 'win32') {
  return pathClass === 'win32' ? win32Path : posixPath;
}

function normalizeRoot(path: Pick<RuntimePath, 'resolve'>, root: string): string {
  const resolved = path.resolve(root);
  return resolved.length > 1 ? resolved.replace(/[\\/]+$/, '') : resolved;
}

function parseStat(value: unknown): HostFileStat {
  const stat = hostStatSchema.parse(value);
  return {
    isFile: stat.is_file,
    isDirectory: stat.is_directory,
    isSymbolicLink: stat.is_symbolic_link,
    size: stat.size,
    mtimeMs: stat.mtime_ms,
    ino: stat.ino,
  };
}

function isMissingPath(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'os.fs.not_found' || code === 'os.fs.not_directory';
}

function assertTextSize(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > REMOTE_RUNTIME_MAX_BINARY_BYTES) {
    throw new RemoteRuntimeError('runtime.too_large', `remote text exceeds ${REMOTE_RUNTIME_MAX_BINARY_BYTES} bytes`);
  }
}

function assertBinarySize(data: Uint8Array): void {
  if (data.byteLength > REMOTE_RUNTIME_MAX_BINARY_BYTES) {
    throw new RemoteRuntimeError('runtime.too_large', `remote binary exceeds ${REMOTE_RUNTIME_MAX_BINARY_BYTES} bytes`);
  }
}
