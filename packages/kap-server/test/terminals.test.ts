import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  IHostTerminalService,
  InstantiationType,
  LifecycleScope,
  registerScopedService,
  type TerminalProcess,
  type TerminalSpawnOptions,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../src/protocol/error-codes';
import type { Terminal } from '@moonshot-ai/agent-core-v2/os/interface/terminal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

// --- Fake PTY service -------------------------------------------------------
//
// `startServer` bootstraps the real `HostTerminalService` (backed by node-pty).
// Registering this fake at App scope AFTER those imports overrides it —
// `buildCollection` applies scoped registrations in import order and the last
// `set` for a given (scope, id) wins. Every spawned process is pushed into the
// module-level collectors below so tests can inspect cwd / kill state.

class FakeTerminalProcess implements TerminalProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number | null }) => void>();
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = false;

  readonly onProcessData = (listener: (data: string) => void): { dispose(): void } => {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  };

  readonly onProcessExit = (
    listener: (event: { exitCode: number | null }) => void,
  ): { dispose(): void } => {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  };

  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(): void {
    this.killed = true;
  }
  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
  emitExit(exitCode: number | null): void {
    for (const listener of this.exitListeners) listener({ exitCode });
  }
}

class FakeHostTerminalService implements IHostTerminalService {
  declare readonly _serviceBrand: undefined;

  spawn(options: TerminalSpawnOptions): Promise<TerminalProcess> {
    spawnOptions.push(options);
    const proc = new FakeTerminalProcess();
    processes.push(proc);
    return Promise.resolve(proc);
  }
}

const spawnOptions: TerminalSpawnOptions[] = [];
const processes: FakeTerminalProcess[] = [];

registerScopedService(
  LifecycleScope.App,
  IHostTerminalService,
  FakeHostTerminalService,
  InstantiationType.Delayed,
  'terminal-test',
);

// --- Test harness -----------------------------------------------------------

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

describe('server-v2 /api/v1/sessions/{sid}/terminals', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let work: string | undefined;
  let base: string;

  beforeEach(async () => {
    spawnOptions.length = 0;
    processes.length = 0;
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-term-home-'));
    work = await mkdtemp(join(tmpdir(), 'kimi-server-v2-term-work-'));
    await writeFile(
      join(home, 'config.toml'),
      [
        '[providers.stub]',
        'type = "openai"',
        'base_url = "http://127.0.0.1:9999"',
        'api_key = "stub"',
        '',
        '[models.stub]',
        'provider = "stub"',
        'model = "stub"',
        'max_context_size = 1000',
        '',
      ].join('\n'),
    );
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
    if (work !== undefined) {
      await rm(work, { recursive: true, force: true });
      work = undefined;
    }
  });

  async function createSession(cwd: string): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd } }),
    } as never);
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function post<T>(path: string, body: unknown): Promise<Envelope<T>> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    } as never);
    return (await res.json()) as Envelope<T>;
  }

  async function get<T>(path: string): Promise<Envelope<T>> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return (await res.json()) as Envelope<T>;
  }

  it('creates terminals for multiple sessions using each session workspace cwd', async () => {
    const rootA = await mkdtemp(join(tmpdir(), 'kimi-server-v2-term-a-'));
    const rootB = await mkdtemp(join(tmpdir(), 'kimi-server-v2-term-b-'));
    try {
      const sidA = await createSession(rootA);
      const sidB = await createSession(rootB);

      const termA = (await post<Terminal>(`/api/v1/sessions/${sidA}/terminals`, { cols: 100, rows: 30 }))
        .data;
      const termB = (await post<Terminal>(`/api/v1/sessions/${sidB}/terminals`, {})).data;

      expect(termA.session_id).toBe(sidA);
      expect(termA.cols).toBe(100);
      expect(termA.rows).toBe(30);
      expect(termA.status).toBe('running');
      expect(termB.session_id).toBe(sidB);
      // Each session resolves cwd against its own workspace workDir.
      expect(spawnOptions.map((o) => o.cwd)).toEqual([resolve(rootA), resolve(rootB)]);

      const listA = (await get<{ items: Terminal[] }>(`/api/v1/sessions/${sidA}/terminals`)).data;
      const listB = (await get<{ items: Terminal[] }>(`/api/v1/sessions/${sidB}/terminals`)).data;
      expect(listA.items.map((t) => t.id)).toEqual([termA.id]);
      expect(listB.items.map((t) => t.id)).toEqual([termB.id]);
    } finally {
      await rm(rootA, { recursive: true, force: true });
      await rm(rootB, { recursive: true, force: true });
    }
  });

  it('resolves an explicit relative cwd against the session workspace', async () => {
    const sid = await createSession(work as string);
    const term = (await post<Terminal>(`/api/v1/sessions/${sid}/terminals`, { cwd: 'sub' })).data;
    expect(term.cwd).toBe(resolve(work as string, 'sub'));
    expect(spawnOptions[0]?.cwd).toBe(resolve(work as string, 'sub'));
  });

  it('gets and closes a terminal by session id', async () => {
    const sid = await createSession(work as string);
    const terminal = (await post<Terminal>(`/api/v1/sessions/${sid}/terminals`, {})).data;

    const got = (await get<Terminal>(`/api/v1/sessions/${sid}/terminals/${terminal.id}`)).data;
    expect(got.id).toBe(terminal.id);

    const closed = await post<{ closed: true }>(
      `/api/v1/sessions/${sid}/terminals/${terminal.id}:close`,
      {},
    );
    expect(closed.code).toBe(0);
    expect(closed.data).toEqual({ closed: true });
    expect(processes[0]?.killed).toBe(true);

    const after = (await get<Terminal>(`/api/v1/sessions/${sid}/terminals/${terminal.id}`)).data;
    expect(after.status).toBe('exited');
  });

  it('maps terminal-not-found, cwd-escape and unknown-session to protocol codes', async () => {
    const sid = await createSession(work as string);

    const missing = await get<unknown>(`/api/v1/sessions/${sid}/terminals/term_missing`);
    expect(missing.code).toBe(ErrorCode.TERMINAL_NOT_FOUND);

    const escaping = await post<unknown>(`/api/v1/sessions/${sid}/terminals`, {
      cwd: '../outside',
    });
    expect(escaping.code).toBe(ErrorCode.FS_PATH_ESCAPES_SESSION);

    const noSession = await get<unknown>(`/api/v1/sessions/sess_missing/terminals`);
    expect(noSession.code).toBe(ErrorCode.SESSION_NOT_FOUND);
  });
});
