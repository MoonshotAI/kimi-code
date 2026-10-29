import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

import {
  ensureMainAgent,
  getLiveSessionById,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentRuntimeService,
  IAgentRuntimeBindingService,
  IHostFileSystem,
  IHostProcessService,
  IWorkspaceInstanceManager,
} from '@moonshot-ai/agent-core-v2';
import { HostFileSystem } from '@moonshot-ai/agent-core-v2/os/backends/node-local/hostFsService';
import type { HostFileStat } from '@moonshot-ai/agent-core-v2/os/interface/hostFileSystem';
import { DeviceRegistry } from '../src/devices/deviceRegistry';
import {
  DEVICE_BRIDGE_PATH,
  DEVICE_BRIDGE_PROTOCOL_VERSION,
  type DeviceServerFrame,
  type RemoteRuntimeMethod,
  type RuntimeRpc,
} from '../src/devices/protocol';
import { type RunningServer, startServer } from '../src/start';
import { registerCentralUser, INTERNAL_CENTRAL_SERVER_FLAG_ENV } from '../src/services/auth/centralUsers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';

const ALICE_TOKEN = 'alice-device-token-0123456789abcdef0123456789';
const BOB_TOKEN = 'bob-device-token-abcdef0123456789abcdef012345';
const ROOT_FILE = 'note.txt';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  details?: unknown;
}

interface MockLlm {
  readonly port: number;
  close(): Promise<void>;
}

function sseText(text: string): string {
  return [
    `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

async function startMockLlm(): Promise<MockLlm> {
  const server: Server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sseText('ok'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no llm port');
  return { port: address.port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function configToml(port: number): string {
  return [
    'default_model = "stub"',
    '',
    '[providers.stub]',
    'type = "openai"',
    `base_url = "http://127.0.0.1:${String(port)}"`,
    'api_key = "stub"',
    '',
    '[models.stub]',
    'provider = "stub"',
    'model = "stub"',
    'max_context_size = 100000',
    '',
  ].join('\n');
}

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function statToWire(stat: HostFileStat) {
  return {
    is_file: stat.isFile,
    is_directory: stat.isDirectory,
    is_symbolic_link: stat.isSymbolicLink,
    size: stat.size,
    mtime_ms: stat.mtimeMs,
    ino: stat.ino,
  };
}

class FakeDesktop {
  readonly requests: RuntimeRpc[] = [];
  readonly held = new Map<string, RuntimeRpc>();
  readonly holdMethods = new Set<string>();
  private readonly fs = new HostFileSystem();
  private readonly authorizedRoots: Set<string>;
  private socket?: WebSocket;
  private welcome?: Extract<DeviceServerFrame, { type: 'device.welcome' }>;
  private readonly commandWaiters = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private welcomeWaiter?: { resolve(): void; reject(error: Error): void };
  private closedWaiter?: () => void;

  constructor(
    readonly deviceId: string,
    private readonly displayName: string,
    private readonly connectionId: string,
    private readonly url: string,
    private readonly token: string,
    authorizedRoots: readonly string[] = [],
    private readonly protocolVersion: number = DEVICE_BRIDGE_PROTOCOL_VERSION,
  ) {
    this.authorizedRoots = new Set(authorizedRoots);
  }

  get generation(): string {
    return this.welcome?.generation ?? '';
  }

  async connect(): Promise<void> {
    const socket = new WebSocket(this.url, [`kimi-code.bearer.${this.token}`]);
    this.socket = socket;
    socket.on('message', (data) => void this.onMessage(rawToString(data)));
    socket.on('close', () => this.closedWaiter?.());
    const opened = new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', (error) => reject(error));
    });
    const welcomed = new Promise<void>((resolve, reject) => {
      this.welcomeWaiter = { resolve, reject };
    });
    await opened;
    socket.send(JSON.stringify({
      type: 'device.hello',
      protocol_version: this.protocolVersion,
      device_id: this.deviceId,
      display_name: this.displayName,
      connection_id: this.connectionId,
      environment: {
        os_kind: 'Linux',
        os_arch: 'x64',
        os_version: 'fake-desktop',
        shell_name: 'bash',
        shell_path: '/bin/bash',
        path_class: 'posix',
        home_dir: '/home/fake',
      },
      capabilities: { fs: true, process: false, terminal: false },
    }));
    await welcomed;
  }

  async registerRoot(path: string): Promise<void> {
    const requestId = `root-${String(this.commandWaiters.size + 1)}`;
    const result = new Promise<unknown>((resolve, reject) => {
      this.commandWaiters.set(requestId, { resolve, reject });
    });
    this.socket?.send(JSON.stringify({
      type: 'device.command',
      request_id: requestId,
      command: 'root.register',
      root: { path, display_name: 'Authorized project' },
    }));
    const root = await result;
    const parsed = root as { root: string };
    this.authorizedRoots.add(parsed.root);
  }

  async unregisterRoot(path: string): Promise<void> {
    const requestId = `unroot-${String(this.commandWaiters.size + 1)}`;
    const result = new Promise<unknown>((resolve, reject) => {
      this.commandWaiters.set(requestId, { resolve, reject });
    });
    this.socket?.send(JSON.stringify({
      type: 'device.command',
      request_id: requestId,
      command: 'root.unregister',
      root: { path },
    }));
    const root = await result as { root: string };
    this.authorizedRoots.delete(root.root);
  }

  hold(method: RemoteRuntimeMethod): void {
    this.holdMethods.add(method);
  }

  release(method: RemoteRuntimeMethod): void {
    this.holdMethods.delete(method);
  }

  async respond(frame: RuntimeRpc, generation = frame.generation): Promise<void> {
    try {
      const result = await this.execute(frame.method, frame.params);
      this.sendFrame({
        type: 'runtime.result',
        protocol_version: DEVICE_BRIDGE_PROTOCOL_VERSION,
        device_id: frame.device_id,
        connection_id: frame.connection_id,
        generation,
        request_id: frame.request_id,
        result,
      });
    } catch (error) {
      this.sendFrame({
        type: 'runtime.error',
        protocol_version: DEVICE_BRIDGE_PROTOCOL_VERSION,
        device_id: frame.device_id,
        connection_id: frame.connection_id,
        generation,
        request_id: frame.request_id,
        error: {
          code: typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'runtime.internal',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async close(): Promise<void> {
    if (this.socket === undefined || this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => {
      this.closedWaiter = resolve;
    });
    this.socket.close();
    await closed;
  }

  private async onMessage(raw: string): Promise<void> {
    const frame = JSON.parse(raw) as DeviceServerFrame | { type: 'runtime.error' };
    switch (frame.type) {
      case 'device.welcome': {
        this.welcome = frame;
        this.welcomeWaiter?.resolve();
        return;
      }
      case 'device.error': {
        const error = new Error(frame.error.message) as Error & { code?: string };
        error.code = frame.error.code;
        const requestId = frame.request_id;
        if (requestId !== undefined) this.commandWaiters.get(requestId)?.reject(error);
        this.welcomeWaiter?.reject(error);
        return;
      }
      case 'device.result': {
        this.commandWaiters.get(frame.request_id)?.resolve(frame.result);
        this.commandWaiters.delete(frame.request_id);
        return;
      }
      case 'device.ping': {
        this.sendFrame({ type: 'device.pong' });
        return;
      }
      case 'runtime.rpc': {
        this.requests.push(frame);
        if (this.holdMethods.has(frame.method as RemoteRuntimeMethod)) {
          this.held.set(frame.request_id, frame);
          return;
        }
        await this.respond(frame);
        return;
      }
      default:
        return;
    }
  }

  private sendFrame(frame: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(frame));
  }

  private async execute(method: string, params: unknown): Promise<unknown> {
    if (method === 'device.inspect_root') {
      const input = params as { path: string };
      const root = await this.fs.realpath(input.path);
      const stat = await this.fs.stat(root);
      if (!stat.isDirectory) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      return { root, is_directory: true };
    }
    const input = params as Record<string, unknown>;
    const path = String(input['path']);
    this.assertAuthorized(path);
    switch (method) {
      case 'fs.realpath': {
        const resolved = await this.fs.realpath(path);
        this.assertAuthorized(resolved);
        return { path: resolved };
      }
      case 'fs.read_text':
        return { text: await this.fs.readText(path, input as { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' }) };
      case 'fs.write_text':
        await this.fs.writeText(path, String(input['data']));
        return null;
      case 'fs.append_text':
        await this.fs.appendText(path, String(input['data']));
        return null;
      case 'fs.read_bytes':
        return { base64: Buffer.from(await this.fs.readBytes(path, input['n'] as number | undefined, input['offset'] as number | undefined)).toString('base64') };
      case 'fs.write_bytes':
        await this.fs.writeBytes(path, Buffer.from(String(input['base64']), 'base64'));
        return null;
      case 'fs.create_exclusive':
        return { created: await this.fs.createExclusive(path, Buffer.from(String(input['base64']), 'base64')) };
      case 'fs.stat':
        return statToWire(await this.fs.stat(path));
      case 'fs.lstat':
        return statToWire(await this.fs.lstat(path));
      case 'fs.readdir':
        return (await this.fs.readdir(path)).map((entry) => ({
          name: entry.name,
          is_file: entry.isFile,
          is_directory: entry.isDirectory,
          is_symbolic_link: entry.isSymbolicLink,
        }));
      case 'fs.mkdir':
        await this.fs.mkdir(path, { recursive: input['recursive'] === true });
        return null;
      case 'fs.remove':
        await this.fs.remove(path);
        return null;
      case 'fs.rename':
        await this.fs.rename(path, String(input['next_path']));
        return null;
      default:
        throw Object.assign(new Error(`unsupported ${method}`), { code: 'runtime.unsupported' });
    }
  }

  private assertAuthorized(path: string): void {
    const resolved = posix.resolve(path);
    const allowed = [...this.authorizedRoots].some((root) => {
      const relative = posix.relative(root, resolved);
      return relative === '' || (!relative.startsWith('..') && !posix.isAbsolute(relative));
    });
    if (!allowed) throw Object.assign(new Error(`device denied ${resolved}`), { code: 'runtime.denied' });
  }
}

describe('Desktop device bridge M2', () => {
  let home: string;
  let rootA: string;
  let rootB: string;
  let outside: string;
  let server: RunningServer;
  let mock: MockLlm;
  let base: string;
  let bridgeUrl: string;
  let deviceA: FakeDesktop;
  let deviceB: FakeDesktop;
  let workspaceA: string;
  let workspaceB: string;
  let sessionA: string;
  let hostStat: ReturnType<typeof vi.spyOn>;
  let hostSpawn: ReturnType<typeof vi.spyOn>;
  const appEvents: Array<{ type?: string; payload?: { type?: string } }> = [];
  let appWs: WebSocket;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-device-m2-home-'));
    rootA = await mkdtemp(join(tmpdir(), 'kimi-device-m2-a-'));
    rootB = await mkdtemp(join(tmpdir(), 'kimi-device-m2-b-'));
    outside = await mkdtemp(join(tmpdir(), 'kimi-device-m2-outside-'));
    await writeFile(join(rootA, ROOT_FILE), 'hello\nworld\n', 'utf8');
    await writeFile(join(outside, 'secret.txt'), 'outside', 'utf8');
    mock = await startMockLlm();
    await writeFile(join(home, 'config.toml'), configToml(mock.port), 'utf8');
    await registerCentralUser({ homeDir: home, userId: 'alice', displayName: 'Alice', token: ALICE_TOKEN });
    await registerCentralUser({ homeDir: home, userId: 'bob', displayName: 'Bob', token: BOB_TOKEN });
    server = await startServer({
      hostIdentity: { productName: 'kimi-code-test', version: '0.0.0', platform: 'test' },
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      env: { [INTERNAL_CENTRAL_SERVER_FLAG_ENV]: '1' },
      deviceBridge: { defaultTimeoutMs: 150, heartbeatIntervalMs: 5_000 },
    });
    base = `http://127.0.0.1:${server.port}`;
    bridgeUrl = `ws://127.0.0.1:${server.port}${DEVICE_BRIDGE_PATH}`;
    hostStat = vi.spyOn(server.core.accessor.get(IHostFileSystem), 'stat');
    hostSpawn = vi.spyOn(server.core.accessor.get(IHostProcessService), 'spawn');
    appWs = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/ws`, [`kimi-code.bearer.${ALICE_TOKEN}`]);
    appWs.on('message', (data) => appEvents.push(JSON.parse(rawToString(data)) as { type?: string }));
    await vi.waitFor(() => {
      if (appWs.readyState !== WebSocket.OPEN) throw new Error('app WebSocket is not open');
    });

    deviceA = new FakeDesktop('dev-a', 'Alice Desktop', 'conn-a-1', bridgeUrl, ALICE_TOKEN);
    await deviceA.connect();
    await deviceA.registerRoot(rootA);
    deviceB = new FakeDesktop('dev-b', 'Bob Desktop', 'conn-b-1', bridgeUrl, BOB_TOKEN);
    await deviceB.connect();
    await deviceB.registerRoot(rootA);

    workspaceA = await createWorkspace(rootA, 'desktop:dev-a');
    workspaceB = await createWorkspace(rootA, 'desktop:dev-b');
    const created = await call<{ id: string }>(ALICE_TOKEN, 'POST', '/api/v1/sessions', { workspace_id: workspaceA });
    if (created.body.code !== 0) throw new Error(`session creation failed: ${created.body.msg}`);
    sessionA = created.body.data.id;
    const handle = getLiveSessionById(server.core.accessor, sessionA)!;
    await ensureMainAgent(handle);
  }, 30000);

  afterAll(async () => {
    appWs?.close();
    await deviceA?.close();
    await deviceB?.close();
    await server?.close();
    await mock?.close();
    await Promise.all([home, rootA, rootB, outside].map((path) => path === undefined ? Promise.resolve() : rm(path, { recursive: true, force: true, maxRetries: 3 })));
  });

  async function call<T>(
    token: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(method === 'GET' ? {} : { body: body === undefined ? undefined : JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as Envelope<T> };
  }

  async function createWorkspace(root: string, runtimeId: string): Promise<string> {
    const response = await call<{ id: string }>(ALICE_TOKEN, 'POST', '/api/v1/workspaces', {
      root,
      runtime_id: runtimeId,
      name: `Remote ${runtimeId}`,
    });
    expect(response.body.code).toBe(0);
    return response.body.data.id;
  }

  function remoteFs(workspaceId = workspaceA) {
    const workspace = server.core.accessor.get(IWorkspaceInstanceManager).get(workspaceId)!;
    const runtime = workspace.runtimes.current(workspaceId === workspaceA ? 'desktop:dev-a' : 'desktop:dev-b')!;
    return runtime.fs!;
  }

  it('authenticates devices, keeps authorization on the bridge, and publishes catalogs and events', async () => {
    const devices = await call<{ items: Array<{ device_id: string; online: boolean; roots: Array<{ root: string; registered_by: { user_id: string } }> }> }>(ALICE_TOKEN, 'GET', '/api/v1/devices');
    expect(devices.body.code).toBe(0);
    expect(devices.body.data.items).toHaveLength(2);
    expect(devices.body.data.items.find((item) => item.device_id === 'dev-a')).toMatchObject({ online: true });
    expect(devices.body.data.items[0]?.roots[0]?.registered_by.user_id).toBe('alice');
    expect(devices.body.data.items[1]?.roots[0]?.registered_by.user_id).toBe('bob');

    const runtimes = await call<{ items: Array<{ runtime_id: string; online: boolean; capabilities: { process: boolean; terminal: boolean } }> }>(ALICE_TOKEN, 'GET', '/api/v1/runtimes');
    expect(runtimes.body.data.items.find((item) => item.runtime_id === 'desktop:dev-a')).toMatchObject({
      online: true,
      capabilities: { process: false, terminal: false },
    });
    const denied = await call<null>(ALICE_TOKEN, 'POST', '/api/v1/workspaces', { root: rootB, runtime_id: 'desktop:dev-a' });
    expect(denied.body.code).toBe(40301);
    expect((denied.body.details as { runtime_error: { code: string } }).runtime_error.code).toBe('runtime.denied');
    expect(hostStat.mock.calls.filter(([path]: [string]) => path === rootA || path === rootB)).toHaveLength(0);
    expect(workspaceA).not.toBe(workspaceB);
    expect(appEvents.some((frame) => frame.type === 'event.device.updated' || frame.payload?.type === 'event.device.updated')).toBe(true);

    const asyncApi = await fetch(`${base}/asyncapi.json`, { headers: { authorization: `Bearer ${ALICE_TOKEN}` } }).then((res) => res.json() as Promise<Record<string, unknown>>);
    expect(JSON.stringify(asyncApi)).toContain('deviceClientFrame');
    expect(JSON.stringify(asyncApi)).toContain(DEVICE_BRIDGE_PATH);

    const duplicate = new FakeDesktop('dev-a', 'Duplicate', 'conn-a-duplicate', bridgeUrl, ALICE_TOKEN);
    await expect(duplicate.connect()).rejects.toMatchObject({ code: 'device.conflict' });
    await duplicate.close();
    const unsupported = new FakeDesktop('dev-unsupported', 'Unsupported', 'conn-unsupported', bridgeUrl, ALICE_TOKEN, [], 99);
    await expect(unsupported.connect()).rejects.toMatchObject({ code: 'runtime.unsupported' });
    await unsupported.close();
  });

  it('routes workspace FS and agent Read Write Edit through the authorized Desktop', async () => {
    const handle = getLiveSessionById(server.core.accessor, sessionA)!;
    const main = handle.accessor.get(IAgentLifecycleService).handleOf('main')!;
    const runtime = main.accessor.get(IAgentRuntimeService).inspect();
    expect(runtime.identity.runtimeId).toBe('desktop:dev-a');
    expect(runtime.capabilities).toEqual(new Set(['fs']));
    expect(runtime.process).toBeUndefined();
    expect(() => main.accessor.get(IAgentRuntimeService).acquire(['process'])).toThrow('runtime');
    expect(hostSpawn).not.toHaveBeenCalled();

    const { IReadTool } = await import('@moonshot-ai/agent-core-v2/agent/tools/os/read/read');
    const { IWriteTool } = await import('@moonshot-ai/agent-core-v2/agent/tools/os/write/write');
    const { IEditTool } = await import('@moonshot-ai/agent-core-v2/agent/tools/edit/edit');
    const read = await executeTool(main.accessor.get(IReadTool), { path: join(rootA, ROOT_FILE) });
    expect(read.isError).not.toBe(true);
    expect(read.output).toContain('hello');
    const edited = await executeTool(main.accessor.get(IEditTool), {
      path: join(rootA, ROOT_FILE),
      old_string: 'world',
      new_string: 'device',
    });
    expect(edited.isError).not.toBe(true);
    const written = await executeTool(main.accessor.get(IWriteTool), {
      path: join(rootA, ROOT_FILE),
      content: 'hello\ndevice\nagain\n',
      mode: 'overwrite',
    });
    expect(written.isError).not.toBe(true);
    expect(await readFile(join(rootA, ROOT_FILE), 'utf8')).toBe('hello\ndevice\nagain\n');

    const list = await call<{ items: Array<{ path: string }> }>(ALICE_TOKEN, 'POST', '/api/v1/workspace/fs:list', {
      workspace: workspaceA,
      runtime_id: 'desktop:dev-a',
      path: '.',
      follow_gitignore: false,
    });
    expect(list.body.code).toBe(0);
    expect(list.body.data.items.some((item) => item.path === ROOT_FILE)).toBe(true);
    const readRoute = await call<{ content: string }>(ALICE_TOKEN, 'POST', `/api/v1/sessions/${sessionA}/fs:read`, {
      runtime_id: 'desktop:dev-a',
      path: ROOT_FILE,
      encoding: 'utf-8',
      offset: 0,
      length: 1000,
    });
    expect(readRoute.body.data.content).toContain('device');
    for (const action of ['search', 'suggest']) {
      const response = await call<{ items: Array<{ path: string }> }>(ALICE_TOKEN, 'POST', `/api/v1/workspace/fs:${action}`, {
        workspace: workspaceA,
        runtime_id: 'desktop:dev-a',
        query: 'note',
        follow_gitignore: false,
      });
      expect(response.body.code).toBe(0);
      expect(response.body.data.items.length).toBeGreaterThan(0);
    }
    const grep = await call<{ files: Array<{ path: string }> }>(ALICE_TOKEN, 'POST', `/api/v1/sessions/${sessionA}/fs:grep`, {
      runtime_id: 'desktop:dev-a',
      pattern: 'device',
      follow_gitignore: false,
    });
    expect(grep.body.code).toBe(0);
    expect(grep.body.data.files.length).toBeGreaterThan(0);
  }, 30000);

  it('supports the complete FS contract, binary downloads, path containment and symlink denial', async () => {
    const fs = remoteFs();
    const binary = new Uint8Array([0, 1, 2, 255, 254, 128]);
    await fs.writeBytes(join(rootA, 'binary.dat'), binary);
    expect(Buffer.from(await fs.readBytes(join(rootA, 'binary.dat')))).toEqual(Buffer.from(binary));
    const download = await fetch(`${base}/api/v1/sessions/${sessionA}/fs/binary.dat:download?runtime_id=desktop%3Adev-a`, {
      headers: { authorization: `Bearer ${ALICE_TOKEN}` },
    });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(Buffer.from(binary));

    expect(await fs.createExclusive(join(rootA, 'exclusive.txt'), Buffer.from('x'))).toBe(true);
    expect(await fs.createExclusive(join(rootA, 'exclusive.txt'), Buffer.from('x'))).toBe(false);
    await fs.appendText(join(rootA, 'exclusive.txt'), 'y');
    expect(await fs.readText(join(rootA, 'exclusive.txt'))).toBe('xy');
    await fs.mkdir(join(rootA, 'nested'), { recursive: true });
    await fs.writeText(join(rootA, 'nested', 'before.txt'), 'renamed');
    await fs.rename(join(rootA, 'nested', 'before.txt'), join(rootA, 'nested', 'after.txt'));
    expect(await fs.readText(join(rootA, 'nested', 'after.txt'))).toBe('renamed');
    expect((await fs.stat(join(rootA, 'nested'))).isDirectory).toBe(true);
    expect((await fs.lstat(join(rootA, 'nested', 'after.txt'))).isFile).toBe(true);
    expect((await fs.readdir(join(rootA, 'nested'))).map((entry) => entry.name)).toContain('after.txt');
    expect(await fs.realpath(join(rootA, 'nested', 'after.txt'))).toBe(join(rootA, 'nested', 'after.txt'));
    const lines: string[] = [];
    for await (const line of fs.readLines(join(rootA, ROOT_FILE))) lines.push(line);
    expect(lines.length).toBeGreaterThan(1);
    await fs.remove(join(rootA, 'nested', 'after.txt'));
    await expect(fs.stat(join(rootA, 'nested', 'after.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(fs.readText(join(rootA, '..', 'secret.txt'))).rejects.toMatchObject({ code: 'runtime.denied' });
    await symlink(outside, join(rootA, 'escape'), 'dir');
    await expect(fs.readText(join(rootA, 'escape', 'secret.txt'))).rejects.toMatchObject({ code: 'runtime.denied' });
    await expect(fs.writeText(join(rootA, 'escape', 'new.txt'), 'no')).rejects.toMatchObject({ code: 'runtime.denied' });
  }, 30000);

  it('fails closed offline, rejects stale generations, marks writes uncertain and keeps the central writer', async () => {
    const beforeHandle = getLiveSessionById(server.core.accessor, sessionA)!;
    const beforeMain = beforeHandle.accessor.get(IAgentLifecycleService).handleOf('main')!;
    const beforeLoop = beforeMain.accessor.get(IAgentLoopService);
    const oldGeneration = deviceA.generation;
    await deviceA.close();
    await vi.waitFor(() => expect(server.devices.get('dev-a')?.online).toBe(false));
    await expect(remoteFs().readText(join(rootA, ROOT_FILE))).rejects.toMatchObject({ code: 'runtime.unavailable' });
    expect(getLiveSessionById(server.core.accessor, sessionA)).toBe(beforeHandle);
    expect(beforeMain.accessor.get(IAgentLoopService)).toBe(beforeLoop);

    deviceA = new FakeDesktop('dev-a', 'Alice Desktop', 'conn-a-2', bridgeUrl, ALICE_TOKEN, [rootA]);
    await deviceA.connect();
    await vi.waitFor(() => expect(server.devices.get('dev-a')?.online).toBe(true));
    expect(deviceA.generation).not.toBe(oldGeneration);
    expect(deviceA.generation).not.toBe('');
    await vi.waitFor(() => {
      const workspace = server.core.accessor.get(IWorkspaceInstanceManager).get(workspaceA)!;
      expect(workspace.runtimes.current('desktop:dev-a')?.status).toBe('ready');
    });
    deviceA.hold('fs.realpath');
    const pending = remoteFs().stat(join(rootA, ROOT_FILE));
    const requestForNote = (frame: RuntimeRpc): boolean =>
      frame.method === 'fs.realpath' && (frame.params as { path: string }).path === join(rootA, ROOT_FILE);
    await vi.waitFor(() => expect([...deviceA.held.values()].some(requestForNote)).toBe(true));
    const request = [...deviceA.held.values()].findLast(requestForNote)!;
    await deviceA.respond(request, oldGeneration);
    await deviceA.respond(request, deviceA.generation);
    await expect(pending).resolves.toMatchObject({ isFile: true });
    deviceA.release('fs.realpath');

    deviceA.hold('fs.stat');
    await expect(remoteFs().stat(join(rootA, ROOT_FILE))).rejects.toMatchObject({ code: 'runtime.timeout' });
    deviceA.release('fs.stat');
    deviceA.held.clear();
    deviceA.hold('fs.write_text');
    await expect(remoteFs().writeText(join(rootA, 'uncertain.txt'), 'unknown')).rejects.toMatchObject({
      code: 'runtime.write_uncertain',
      uncertain: true,
    });
    deviceA.release('fs.write_text');
    deviceA.held.clear();
    deviceA.hold('fs.write_text');
    const disconnectedWrite = remoteFs().writeText(join(rootA, 'disconnect-write.txt'), 'unknown');
    const disconnectedAssertion = expect(disconnectedWrite).rejects.toMatchObject({ code: 'runtime.write_uncertain', uncertain: true });
    await vi.waitFor(() => expect([...deviceA.held.values()].some((frame) => frame.method === 'fs.write_text')).toBe(true));
    await deviceA.close();
    await disconnectedAssertion;
    deviceA.release('fs.write_text');
    deviceA.held.clear();
    expect(getLiveSessionById(server.core.accessor, sessionA)).toBe(beforeHandle);
    expect(beforeMain.accessor.get(IAgentLoopService)).toBe(beforeLoop);
  }, 30000);

  it('persists device and root metadata without treating offline catalog entries as local', async () => {
    const catalog = await DeviceRegistry.load({ catalogFile: server.devices.registry.catalogFile });
    const device = catalog.get('dev-a');
    expect(device).toMatchObject({ deviceId: 'dev-a', online: false });
    expect(device?.roots.map((root) => root.root)).toContain(rootA);
    await catalog.close();
    const handle = getLiveSessionById(server.core.accessor, sessionA)!;
    const main = handle.accessor.get(IAgentLifecycleService).handleOf('main')!;
    expect(() => main.accessor.get(IAgentRuntimeService).acquire(['process'])).toThrow();
    const before = main.accessor.get(IAgentLoopService);
    expect(() => main.accessor.get(IAgentRuntimeBindingService).switch('desktop:missing')).toThrow();
    expect(main.accessor.get(IAgentLoopService)).toBe(before);
  });

  it('revokes roots only through the connected Desktop and denies later FS calls', async () => {
    deviceA = new FakeDesktop('dev-a', 'Alice Desktop', 'conn-a-3', bridgeUrl, ALICE_TOKEN, [rootA]);
    await deviceA.connect();
    await vi.waitFor(() => expect(server.devices.get('dev-a')?.online).toBe(true));
    await expect(remoteFs().readText(join(rootA, ROOT_FILE))).resolves.toContain('device');
    await deviceA.unregisterRoot(rootA);
    await expect(remoteFs().readText(join(rootA, ROOT_FILE))).rejects.toMatchObject({ code: 'runtime.denied' });
    const devices = await call<{ items: Array<{ device_id: string; roots: unknown[] }> }>(ALICE_TOKEN, 'GET', '/api/v1/devices');
    expect(devices.body.data.items.find((item) => item.device_id === 'dev-a')?.roots).toEqual([]);
  }, 30000);

  it('rebuilds the original workspace when connection arrives before root registration', async () => {
    const manager = server.core.accessor.get(IWorkspaceInstanceManager);
    const lease = await manager.acquire({ workspaceId: workspaceB });
    const workspace = lease.instance;
    const oldGeneration = deviceB.generation;
    await deviceB.unregisterRoot(rootA);
    await deviceB.close();
    await vi.waitFor(() => expect(server.devices.get('dev-b')?.online).toBe(false));

    deviceB = new FakeDesktop('dev-b', 'Bob Desktop', 'conn-b-2', bridgeUrl, BOB_TOKEN, [rootA]);
    await deviceB.connect();
    await vi.waitFor(() => {
      const snapshot = server.devices.get('dev-b')!;
      expect(snapshot.online).toBe(true);
      expect(snapshot.roots).toEqual([]);
    });
    await deviceB.registerRoot(rootA);
    await vi.waitFor(() => {
      const runtime = workspace.runtimes.current('desktop:dev-b')!;
      expect(runtime.identity.generation).toBe(deviceB.generation);
      expect(runtime.status).toBe('ready');
    });
    await expect(remoteFs(workspaceB).readText(join(rootA, ROOT_FILE))).resolves.toContain('device');

    deviceB.hold('fs.realpath');
    const pending = remoteFs(workspaceB).stat(join(rootA, ROOT_FILE));
    const requestForNote = (frame: RuntimeRpc): boolean =>
      frame.method === 'fs.realpath' && (frame.params as { path: string }).path === join(rootA, ROOT_FILE);
    await vi.waitFor(() => expect([...deviceB.held.values()].some(requestForNote)).toBe(true));
    const request = [...deviceB.held.values()].findLast(requestForNote)!;
    await deviceB.respond(request, oldGeneration);
    await deviceB.respond(request, deviceB.generation);
    await expect(pending).resolves.toMatchObject({ isFile: true });
    deviceB.release('fs.realpath');

    await deviceB.unregisterRoot(rootA);
    await vi.waitFor(() => expect(workspace.runtimes.current('desktop:dev-b')?.status).toBe('disconnected'));
    await expect(remoteFs(workspaceB).readText(join(rootA, ROOT_FILE))).rejects.toMatchObject({ code: 'runtime.denied' });
    await deviceB.close();
    await vi.waitFor(() => expect(server.devices.get('dev-b')?.online).toBe(false));
    await expect(remoteFs(workspaceB).readText(join(rootA, ROOT_FILE))).rejects.toMatchObject({ code: 'runtime.unavailable' });
    lease.dispose();
  }, 30000);
});

async function executeTool<T>(
  tool: { resolveExecution(args: T): unknown },
  args: T,
): Promise<{ isError?: boolean; output: unknown }> {
  const resolved = await tool.resolveExecution(args) as {
    isError?: boolean;
    execute?: (context: { turnId: number; toolCallId: string; signal: AbortSignal }) => Promise<{ isError?: boolean; output: unknown }>;
  };
  if (resolved.isError === true || resolved.execute === undefined) return resolved as { isError?: boolean; output: unknown };
  return resolved.execute({ turnId: 0, toolCallId: 'device-test', signal: new AbortController().signal });
}
