import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IWorkspaceInstanceManager } from '@moonshot-ai/agent-core-v2';
import type { HostFsChange, IHostFsWatchService } from '@moonshot-ai/agent-core-v2/os/interface/hostFsWatch';
import { FakeRuntime } from '@moonshot-ai/agent-core-v2/runtime/fakeRuntime';
import type { RuntimeProviderRuntimeHandle } from '@moonshot-ai/agent-core-v2/runtime/runtimeUnitHost';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { startServer, type RunningServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

let tmpDir: string;
let bridgeHome: string;
let workspace: string;
let server: RunningServer | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kap-fswatch-'));
  bridgeHome = mkdtempSync(join(tmpdir(), 'kap-fswatch-home-'));
  workspace = join(tmpDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, 'docs'), { recursive: true });
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
  }
  server = undefined;
  vi.unstubAllEnvs();
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function boot(): Promise<RunningServer> {
  server = await startServer({
    hostIdentity: TEST_HOST_IDENTITY,
    host: '127.0.0.1',
    port: 0,
    homeDir: bridgeHome,
    logger: pino({ level: 'silent' }),
    disableAuth: true,
  });
  return server;
}

function addressOf(r: RunningServer): string {
  return `http://${r.host}:${r.port}`;
}

function wsUrl(r: RunningServer): string {
  return `${addressOf(r).replace(/^http/, 'ws')}/api/v1/ws`;
}

async function createSession(r: RunningServer): Promise<string> {
  const res = await fetch(`${addressOf(r)}/api/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ metadata: { cwd: workspace } }),
  });
  const env = (await res.json()) as { code: number; data: { id: string } | null };
  if (env.code !== 0 || env.data === null) {
    throw new Error(`create session failed: ${JSON.stringify(env)}`);
  }
  return env.data.id;
}

interface WsFrame {
  type: string;
  payload?: Record<string, unknown>;
  id?: string;
  code?: number;
  msg?: string;
  seq?: number;
  session_id?: string;
}

interface Conn {
  ws: WebSocket;
  queue: WsFrame[];
  waiters: Array<(frame: WsFrame) => void>;
}

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function openConn(url: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue: WsFrame[] = [];
    const waiters: Array<(frame: WsFrame) => void> = [];
    ws.on('message', (data) => {
      let parsed: WsFrame;
      try {
        parsed = JSON.parse(rawToString(data)) as WsFrame;
      } catch {
        return;
      }
      if (waiters.length > 0) waiters.shift()?.(parsed);
      else queue.push(parsed);
    });
    ws.once('open', () => resolve({ ws, queue, waiters }));
    ws.once('error', (err) => reject(err));
  });
}

function receive(conn: Conn, timeoutMs: number): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    if (conn.queue.length > 0) {
      resolve(conn.queue.shift()!);
      return;
    }
    const t = setTimeout(() => {
      const idx = conn.waiters.indexOf(waiter);
      if (idx >= 0) conn.waiters.splice(idx, 1);
      reject(new Error(`no message in ${timeoutMs}ms`));
    }, timeoutMs);
    const waiter = (frame: WsFrame): void => {
      clearTimeout(t);
      resolve(frame);
    };
    conn.waiters.push(waiter);
  });
}

async function receiveType(conn: Conn, type: string, timeoutMs: number): Promise<WsFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`no message of type ${type} within ${timeoutMs}ms`);
    const frame = await receive(conn, remaining);
    if (frame.type === type) return frame;
  }
}

async function helloAndSubscribe(conn: Conn, clientId: string, sessionId: string): Promise<void> {
  await receiveType(conn, 'server_hello', 1000);
  conn.ws.send(
    JSON.stringify({
      type: 'client_hello',
      id: `cli_${clientId}`,
      payload: { client_id: clientId, subscriptions: [sessionId] },
    }),
  );
  await receiveType(conn, 'ack', 1000);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const WATCH_SETTLE_MS = 150;

describe('WS fs watch (kap-server)', () => {
  it('subscribe src → create file → receive event.fs.changed', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r));
    await helloAndSubscribe(conn, 'A', sid);

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'w1',
        payload: { session_id: sid, runtime_id: 'local', paths: ['src'] },
      }),
    );
    const ack = await receiveType(conn, 'ack', 1000);
    expect(ack.code).toBe(0);
    expect(ack.payload).toMatchObject({ watched_paths: ['src'] });

    await sleep(WATCH_SETTLE_MS);
    writeFileSync(join(workspace, 'src', 'new.ts'), 'export const x = 1;\n');

    const ev = await receiveType(conn, 'event.fs.changed', 2000);
    expect(ev.session_id).toBe(sid);
    const payload = ev.payload as {
      changes: Array<{ path: string; change: string; kind: string }>;
      coalesced_window_ms: number;
      truncated?: boolean;
    };
    expect(payload.coalesced_window_ms).toBe(200);
    expect(payload.truncated).toBeUndefined();
    expect(payload.changes.length).toBeGreaterThanOrEqual(1);
    const paths = payload.changes.map((c) => c.path);
    expect(paths.some((p) => p === 'src/new.ts' || p === 'src')).toBe(true);

    conn.ws.close();
  });

  it('watch_fs_add without runtime_id defaults to the local runtime', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r));
    await helloAndSubscribe(conn, 'A', sid);

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'w1',
        payload: { session_id: sid, paths: ['src'] },
      }),
    );
    const ack = await receiveType(conn, 'ack', 1000);
    expect(ack.code).toBe(0);
    expect(ack.payload).toMatchObject({ watched_paths: ['src'] });

    await sleep(WATCH_SETTLE_MS);
    writeFileSync(join(workspace, 'src', 'compat.ts'), 'export const y = 2;\n');

    const ev = await receiveType(conn, 'event.fs.changed', 2000);
    expect(ev.session_id).toBe(sid);

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_remove',
        id: 'w2',
        payload: { session_id: sid, paths: ['src'] },
      }),
    );
    const removeAck = await receiveType(conn, 'ack', 1000);
    expect(removeAck.code).toBe(0);

    conn.ws.close();
  });

  it.skipIf(process.platform === 'win32')(
    'burst > 500 changes inside 200ms window → truncated:true',
    { timeout: 15000 },
    async () => {
      vi.stubEnv('KIMI_CODE_FS_WATCH_DEBOUNCE_MS', '500');
      vi.stubEnv('KIMI_CODE_FS_WATCH_MAX_CHANGES_PER_WINDOW', '100');
      const r = await boot();
      const sid = await createSession(r);
      const conn = await openConn(wsUrl(r));
      await helloAndSubscribe(conn, 'A', sid);

      conn.ws.send(
        JSON.stringify({
          type: 'watch_fs_add',
          id: 'w2',
          payload: { session_id: sid, runtime_id: 'local', paths: ['.'] },
        }),
      );
      await receiveType(conn, 'ack', 1000);
      await sleep(WATCH_SETTLE_MS);

      const burstDir = join(workspace, 'burst');
      mkdirSync(burstDir, { recursive: true });
      for (let i = 0; i < 600; i++) writeFileSync(join(burstDir, `f${i}.txt`), `x${i}`);

      const deadline = Date.now() + 12000;
      let sawTruncated = false;
      while (Date.now() < deadline) {
        let frame: WsFrame;
        try {
          frame = await receive(conn, deadline - Date.now());
        } catch {
          break;
        }
        if (frame.type !== 'event.fs.changed') continue;
        const payload = frame.payload as { truncated?: boolean; count?: number };
        if (payload.truncated === true) {
          expect(payload.count).toBeGreaterThan(100);
          sawTruncated = true;
          break;
        }
      }
      expect(sawTruncated).toBe(true);
      conn.ws.close();
    },
  );

  it('two clients on disjoint paths receive only their own changes', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const a = await openConn(wsUrl(r));
    const b = await openConn(wsUrl(r));
    await helloAndSubscribe(a, 'A', sid);
    await helloAndSubscribe(b, 'B', sid);

    a.ws.send(
      JSON.stringify({ type: 'watch_fs_add', id: 'wA', payload: { session_id: sid, runtime_id: 'local', paths: ['src'] } }),
    );
    await receiveType(a, 'ack', 1000);
    b.ws.send(
      JSON.stringify({ type: 'watch_fs_add', id: 'wB', payload: { session_id: sid, runtime_id: 'local', paths: ['docs'] } }),
    );
    await receiveType(b, 'ack', 1000);

    await sleep(WATCH_SETTLE_MS);
    writeFileSync(join(workspace, 'src', 'a.ts'), 'a');
    writeFileSync(join(workspace, 'docs', 'b.md'), 'b');

    const evA = await receiveType(a, 'event.fs.changed', 2000);
    const pathsA = (evA.payload as { changes: Array<{ path: string }> }).changes.map((c) => c.path);
    expect(pathsA.some((p) => p.startsWith('src/'))).toBe(true);
    expect(pathsA.some((p) => p.startsWith('docs/'))).toBe(false);

    const evB = await receiveType(b, 'event.fs.changed', 2000);
    const pathsB = (evB.payload as { changes: Array<{ path: string }> }).changes.map((c) => c.path);
    expect(pathsB.some((p) => p.startsWith('docs/'))).toBe(true);
    expect(pathsB.some((p) => p.startsWith('src/'))).toBe(false);

    a.ws.close();
    b.ws.close();
  });

  it('> 100 paths on one connection → 42902 fs.watch_limit_exceeded', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r));
    await helloAndSubscribe(conn, 'A', sid);

    const paths: string[] = [];
    for (let i = 0; i < 101; i++) {
      const p = `dir${i}`;
      mkdirSync(join(workspace, p), { recursive: true });
      paths.push(p);
    }

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'w100',
        payload: { session_id: sid, runtime_id: 'local', paths: paths.slice(0, 100) },
      }),
    );
    const ack100 = await receiveType(conn, 'ack', 2000);
    expect(ack100.code).toBe(0);
    expect((ack100.payload as { current_count: number }).current_count).toBe(100);

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'w101',
        payload: { session_id: sid, runtime_id: 'local', paths: [paths[100]!] },
      }),
    );
    const ack101 = await receiveType(conn, 'ack', 2000);
    expect(ack101.code).toBe(42902);

    conn.ws.close();
  });

  it('idempotent: adding the same path twice keeps current_count singular', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r));
    await helloAndSubscribe(conn, 'A', sid);

    conn.ws.send(
      JSON.stringify({ type: 'watch_fs_add', id: 'w1', payload: { session_id: sid, runtime_id: 'local', paths: ['src'] } }),
    );
    await receiveType(conn, 'ack', 1000);
    conn.ws.send(
      JSON.stringify({ type: 'watch_fs_add', id: 'w2', payload: { session_id: sid, runtime_id: 'local', paths: ['src'] } }),
    );
    const ack = await receiveType(conn, 'ack', 1000);
    expect((ack.payload as { current_count: number }).current_count).toBe(1);

    conn.ws.close();
  });

  it('watch_fs_remove drops the subscription and acks updated watched_paths', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r));
    await helloAndSubscribe(conn, 'A', sid);

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'wadd',
        payload: { session_id: sid, runtime_id: 'local', paths: ['src', 'docs'] },
      }),
    );
    await receiveType(conn, 'ack', 1000);

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_remove',
        id: 'wrm',
        payload: { session_id: sid, runtime_id: 'local', paths: ['src'] },
      }),
    );
    const ack = await receiveType(conn, 'ack', 1000);
    const payload = ack.payload as { watched_paths: string[]; current_count: number };
    expect(payload.watched_paths).toEqual(['docs']);
    expect(payload.current_count).toBe(1);

    conn.ws.close();
  });

  it('watch_fs_add for `..` path → 41304 fs.path_escapes_session', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r));
    await helloAndSubscribe(conn, 'A', sid);

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'wbad',
        payload: { session_id: sid, runtime_id: 'local', paths: ['../escape'] },
      }),
    );
    const ack = await receiveType(conn, 'ack', 1000);
    expect(ack.code).toBe(41304);

    conn.ws.close();
  });

  it('keeps delivering events after the runtime generation is replaced, without a client re-add', async () => {
    const r = await boot();
    const sid = await createSession(r);

    interface FakeHandle {
      disposed: number;
      fire(change: HostFsChange): void;
    }
    const fakeWatch = (): { readonly service: IHostFsWatchService; readonly handles: FakeHandle[] } => {
      const handles: FakeHandle[] = [];
      const service = {
        watch: () => {
          const listeners = new Set<(change: HostFsChange) => void>();
          const handle: FakeHandle & {
            readonly ready: Promise<void>;
            onDidChange(listener: (change: HostFsChange) => void): { dispose(): void };
            dispose(): void;
          } = {
            ready: Promise.resolve(),
            disposed: 0,
            onDidChange: (listener) => {
              listeners.add(listener);
              return { dispose: () => { listeners.delete(listener); } };
            },
            dispose: () => { handle.disposed += 1; },
            fire: (change) => { for (const listener of [...listeners]) listener(change); },
          };
          handles.push(handle);
          return handle;
        },
      } as unknown as IHostFsWatchService;
      return { service, handles };
    };
    const watchOne = fakeWatch();
    const watchTwo = fakeWatch();
    let workspaceId = '';
    let handle: RuntimeProviderRuntimeHandle | undefined;
    const makeRuntime = (generation: string, service: IHostFsWatchService): FakeRuntime =>
      Object.assign(
        new FakeRuntime(
          { workspaceId, runtimeId: 'watch-test', generation },
          { capabilities: ['watch'] },
        ),
        { watch: service },
      );
    const provider = await r.core.accessor.get(IWorkspaceInstanceManager).addProvider({
      id: 'watch-test-provider',
      imports: { root: [], imports: [], local: [] },
      attach: async (context, host) => {
        workspaceId = context.id;
        handle = host.registerRuntime(makeRuntime('watch-generation-1', watchOne.service));
        return { dispose: () => handle!.remove() };
      },
    });

    const conn = await openConn(wsUrl(r));
    try {
      await helloAndSubscribe(conn, 'A', sid);
      conn.ws.send(
        JSON.stringify({
          type: 'watch_fs_add',
          id: 'w1',
          payload: { session_id: sid, runtime_id: 'watch-test', paths: ['src'] },
        }),
      );
      const ack = await receiveType(conn, 'ack', 1000);
      expect(ack.code).toBe(0);
      expect(ack.payload).toMatchObject({ watched_paths: ['src'] });
      expect(watchOne.handles).toHaveLength(1);

      watchOne.handles[0]!.fire({ path: join(workspace, 'src', 'one.ts'), action: 'created', kind: 'file' });
      const evOne = await receiveType(conn, 'event.fs.changed', 2000);
      expect((evOne.payload as { changes: Array<{ path: string }> }).changes.some((c) => c.path === 'src/one.ts')).toBe(true);

      await handle!.update(() => makeRuntime('watch-generation-2', watchTwo.service));

      const deadline = Date.now() + 2000;
      while (watchTwo.handles.length === 0 && Date.now() < deadline) await sleep(25);
      expect(watchTwo.handles).toHaveLength(1);
      expect(watchOne.handles[0]!.disposed).toBe(1);
      await sleep(WATCH_SETTLE_MS);

      watchTwo.handles[0]!.fire({ path: join(workspace, 'src', 'two.ts'), action: 'created', kind: 'file' });
      const evTwo = await receiveType(conn, 'event.fs.changed', 2000);
      expect(evTwo.session_id).toBe(sid);
      expect((evTwo.payload as { changes: Array<{ path: string }> }).changes.some((c) => c.path === 'src/two.ts')).toBe(true);
      expect(evTwo.seq).toBe((evOne.seq ?? 0) + 1);

      conn.ws.send(
        JSON.stringify({
          type: 'watch_fs_add',
          id: 'w2',
          payload: { session_id: sid, runtime_id: 'watch-test', paths: ['docs'] },
        }),
      );
      const ackTwo = await receiveType(conn, 'ack', 1000);
      expect(ackTwo.code).toBe(0);
      expect(ackTwo.payload).toMatchObject({ watched_paths: ['docs', 'src'] });
    } finally {
      conn.ws.close();
      await provider.dispose();
    }
  });
});
