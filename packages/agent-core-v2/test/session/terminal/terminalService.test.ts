/**
 * `terminal` lifecycle scenarios — bounded replay and exited-resource ownership.
 *
 * Exercises `ISessionTerminalService` and `IHostTerminalService` through DI,
 * using the real services with only the OS PTY/workspace/session boundaries
 * replaced. Covers live delivery, replay, exit retention, and App/Session
 * teardown. Run with `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/session/terminal/terminalService.test.ts`.
 */

import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { ErrorCodes } from '#/errors';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import {
  type TerminalAttachSink,
  type TerminalFrame,
  type TerminalProcess,
  type TerminalSpawnOptions,
  IHostTerminalService,
} from '#/os/interface/terminal';
import { HostTerminalService } from '#/os/backends/node-local/hostTerminalService';
import {
  ISessionTerminalService,
  SessionTerminalService,
} from '#/session/terminal/terminalService';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

class FakeTerminalProcess implements TerminalProcess {
  private readonly dataEmitter = new Emitter<string>();
  private readonly exitEmitter = new Emitter<{ exitCode: number | null }>();
  readonly onProcessData = this.dataEmitter.event;
  readonly onProcessExit = this.exitEmitter.event;
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = false;

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
    this.dataEmitter.fire(data);
  }
  emitExit(exitCode: number | null): void {
    this.exitEmitter.fire({ exitCode });
  }
  dispose(): void {
    this.dataEmitter.dispose();
    this.exitEmitter.dispose();
  }
}

class FakeHostTerminalService implements IHostTerminalService {
  declare readonly _serviceBrand: undefined;
  readonly processes: FakeTerminalProcess[] = [];
  readonly lastOptions: TerminalSpawnOptions[] = [];
  spawnGate: Promise<void> | undefined;

  async spawn(options: TerminalSpawnOptions): Promise<TerminalProcess> {
    this.lastOptions.push(options);
    const proc = new FakeTerminalProcess();
    this.processes.push(proc);
    await this.spawnGate;
    return proc;
  }
}

function stubWorkspace(workDir = '/ws'): ISessionWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workDir,
    additionalDirs: [],
    setWorkDir: () => {},
    setAdditionalDirs: () => {},
    resolve: (rel) => resolve(workDir, rel),
    isWithin: () => true,
    assertAllowed: (absPath) => resolve(workDir, absPath),
    addAdditionalDir: () => {},
    removeAdditionalDir: () => {},
  };
}

function stubSessionContext(sessionId = 's1'): ISessionContext {
  return makeSessionContext({
    sessionId,
    workspaceId: 'w1',
    sessionDir: '/ws/.session',
    sessionScope: `session:${sessionId}`,
    metaScope: `session:${sessionId}`,
    cwd: '/ws',
  });
}

function collectSink(id = 'sink-1'): { sink: TerminalAttachSink; frames: TerminalFrame[] } {
  const frames: TerminalFrame[] = [];
  return { sink: { id, send: (frame) => frames.push(frame) }, frames };
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createMockPty(onExitRegistered?: () => void): {
  readonly pty: import('node-pty').IPty;
  readonly dataListeners: Set<(data: string) => void>;
  readonly exitListeners: Set<(event: { exitCode: number }) => void>;
  readonly write: ReturnType<typeof vi.fn>;
  readonly resize: ReturnType<typeof vi.fn>;
  readonly kill: ReturnType<typeof vi.fn>;
} {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number }) => void>();
  const write = vi.fn();
  const resize = vi.fn();
  const kill = vi.fn();
  const pty = {
    onData: (listener: (data: string) => void) => {
      dataListeners.add(listener);
      return toDisposable(() => dataListeners.delete(listener));
    },
    onExit: (listener: (event: { exitCode: number }) => void) => {
      exitListeners.add(listener);
      onExitRegistered?.();
      return toDisposable(() => exitListeners.delete(listener));
    },
    write,
    resize,
    kill,
  } as unknown as import('node-pty').IPty;
  return { pty, dataListeners, exitListeners, write, resize, kill };
}

describe('session terminal lifecycle (live I/O, replay, and retention)', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let host: FakeHostTerminalService;

  beforeEach(() => {
    disposables = new DisposableStore();
    host = new FakeHostTerminalService();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IHostTerminalService, host);
        reg.define(ISessionTerminalService, SessionTerminalService);
        reg.defineInstance(ISessionWorkspaceContext, stubWorkspace());
        reg.defineInstance(ISessionContext, stubSessionContext());
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('creates a terminal and resolves cwd through the workspace', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({ cwd: 'sub', cols: 100, rows: 40 });

    expect(terminal.status).toBe('running');
    expect(terminal.session_id).toBe('s1');
    expect(terminal.cwd).toBe(resolve('/ws', 'sub'));
    expect(terminal.cols).toBe(100);
    expect(terminal.rows).toBe(40);
    expect(host.processes).toHaveLength(1);
    expect(host.lastOptions[0]?.cwd).toBe(resolve('/ws', 'sub'));
  });

  it('uses the workspace workDir when cwd is omitted', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    expect(terminal.cwd).toBe('/ws');
    expect(terminal.cols).toBe(80);
    expect(terminal.rows).toBe(24);
  });

  it('kills a deferred spawn when it resolves after Session disposal', async () => {
    const gate = deferred<void>();
    host.spawnGate = gate.promise;
    const svc = ix.get(ISessionTerminalService);
    const pendingCreate = svc.create({});
    const rejected = expect(pendingCreate).rejects.toMatchObject({
      code: ErrorCodes.SESSION_CLOSED,
    });

    disposables.dispose();
    gate.resolve();

    await rejected;
    expect(host.processes).toHaveLength(1);
    expect(host.processes[0]!.killed).toBe(true);
  });

  it('lists and gets terminals', async () => {
    const svc = ix.get(ISessionTerminalService);
    const created = await svc.create({});
    const listed = await svc.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);

    const fetched = await svc.get(created.id);
    expect(fetched.id).toBe(created.id);
  });

  it('throws TERMINAL_NOT_FOUND for an unknown terminal', async () => {
    const svc = ix.get(ISessionTerminalService);
    await expect(svc.get('nope')).rejects.toMatchObject({
      code: ErrorCodes.TERMINAL_NOT_FOUND,
    });
  });

  it('attaches a sink, replays buffered frames, then streams live output', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = host.processes[0]!;

    proc.emitData('hello');
    const { sink, frames } = collectSink();
    const { replayed } = await svc.attach(terminal.id, sink);
    expect(replayed).toBe(1);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'terminal_output',
      seq: 1,
      session_id: 's1',
      terminal_id: terminal.id,
      payload: { data: 'hello' },
    });

    proc.emitData('world');
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({ type: 'terminal_output', seq: 2, payload: { data: 'world' } });
  });

  it('replays only frames after sinceSeq', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = host.processes[0]!;
    proc.emitData('a');
    proc.emitData('b');
    proc.emitData('c');

    const { sink, frames } = collectSink();
    const { replayed } = await svc.attach(terminal.id, sink, { sinceSeq: 1 });
    expect(replayed).toBe(2);
    expect(frames.map((f) => (f as { seq?: number }).seq)).toEqual([2, 3]);
  });

  it('replays only complete output frames within the one MiB retention limit', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = host.processes[0]!;
    proc.emitData('a'.repeat(716_800));
    proc.emitData('b'.repeat(409_600));

    const { sink, frames } = collectSink();
    const result = await svc.attach(terminal.id, sink);

    expect(result).toEqual({ replayed: 1 });
    expect(frames).toMatchObject([
      { type: 'terminal_output', seq: 2, payload: { data: 'b'.repeat(409_600) } },
    ]);
    expect(
      frames.reduce(
        (bytes, frame) =>
          bytes +
          (frame.type === 'terminal_output' ? Buffer.byteLength(frame.payload.data) : 0),
        0,
      ),
    ).toBe(409_600);
  });

  it('replays the UTF-8 tail of a single oversized output frame', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = host.processes[0]!;
    proc.emitData(`prefix${'界'.repeat(349_526)}tails`);

    const { sink, frames } = collectSink();
    const result = await svc.attach(terminal.id, sink);

    expect(result).toEqual({ replayed: 1 });
    expect(frames).toHaveLength(1);
    const replayed = frames[0];
    expect(replayed).toMatchObject({ type: 'terminal_output', seq: 1 });
    const data = replayed?.type === 'terminal_output' ? replayed.payload.data : '';
    expect(data.startsWith('界')).toBe(true);
    expect(data.endsWith('tails')).toBe(true);
    expect(
      replayed?.type === 'terminal_output' ? Buffer.byteLength(replayed.payload.data) : 0,
    ).toBeLessThanOrEqual(1_048_576);
  });

  it('streams an oversized output frame without truncating live delivery', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = host.processes[0]!;
    const { sink, frames } = collectSink();
    await svc.attach(terminal.id, sink);
    const output = `prefix${'界'.repeat(349_526)}tails`;

    proc.emitData(output);

    expect(frames).toMatchObject([
      { type: 'terminal_output', seq: 1, payload: { data: output } },
    ]);
  });

  it('emits an exit frame and marks the terminal exited on process exit', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = host.processes[0]!;
    const { sink, frames } = collectSink();
    await svc.attach(terminal.id, sink);

    proc.emitExit(7);

    const exitFrame = frames.find((f) => f.type === 'terminal_exit');
    expect(exitFrame).toMatchObject({
      type: 'terminal_exit',
      terminal_id: terminal.id,
      payload: { exit_code: 7 },
    });
    const fetched = await svc.get(terminal.id);
    expect(fetched.status).toBe('exited');
    expect(fetched.exit_code).toBe(7);
  });

  it('replays retained output and the exit frame after process exit', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = host.processes[0]!;
    proc.emitData('tail');
    proc.emitExit(7);

    const { sink, frames } = collectSink();
    const result = await svc.attach(terminal.id, sink);

    expect(result).toEqual({ replayed: 2 });
    expect(frames).toMatchObject([
      { type: 'terminal_output', seq: 1, payload: { data: 'tail' } },
      { type: 'terminal_exit', payload: { exit_code: 7 } },
    ]);
  });

  it('lists at most 16 exited terminals across three waves', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminalIds: string[] = [];
    const retainedCounts: number[] = [];

    for (let wave = 0; wave < 3; wave += 1) {
      for (let index = 0; index < 8; index += 1) {
        const terminal = await svc.create({});
        terminalIds.push(terminal.id);
        const proc = host.processes.at(-1)!;
        proc.emitData('x'.repeat(65_536));
        proc.emitExit(0);
      }
      retainedCounts.push((await svc.list()).length);
    }

    expect(retainedCounts).toEqual([8, 16, 16]);
    expect((await svc.list()).map((terminal) => terminal.id)).toEqual(terminalIds.slice(8));
  });

  it('evicts exited terminals by exit order rather than creation order', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminals = [];
    for (let index = 0; index < 17; index += 1) {
      terminals.push(await svc.create({}));
    }
    const exitOrder = [...host.processes.slice(1), host.processes[0]!];

    for (const proc of exitOrder) {
      proc.emitExit(0);
    }

    const retained = await svc.list();
    expect(new Set(retained.map((terminal) => terminal.id))).toEqual(
      new Set([...terminals.slice(2).map((terminal) => terminal.id), terminals[0]!.id]),
    );
    await expect(svc.get(terminals[1]!.id)).rejects.toMatchObject({
      code: ErrorCodes.TERMINAL_NOT_FOUND,
    });
    await expect(svc.get(terminals[0]!.id)).resolves.toMatchObject({ status: 'exited' });
  });

  it('delegates write and resize to the process', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = host.processes[0]!;

    await svc.write(terminal.id, 'ls\n');
    await svc.resize(terminal.id, 120, 50);

    expect(proc.writes).toEqual(['ls\n']);
    expect(proc.resizes).toEqual([[120, 50]]);
    expect((await svc.get(terminal.id)).cols).toBe(120);
  });

  it('closes a terminal by killing the process and marking it exited', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = host.processes[0]!;

    const result = await svc.close(terminal.id);
    expect(result).toEqual({ closed: true });
    expect(proc.killed).toBe(true);
    expect((await svc.get(terminal.id)).status).toBe('exited');
  });

  it('detaches a sink so it stops receiving frames', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = host.processes[0]!;
    const { sink, frames } = collectSink();
    await svc.attach(terminal.id, sink);

    svc.detach(terminal.id, sink.id);
    proc.emitData('after-detach');
    expect(frames).toHaveLength(0);
  });

  it('kills every live process when the service is disposed', async () => {
    const svc = ix.get(ISessionTerminalService);
    await svc.create({});
    const proc = host.processes[0]!;

    disposables.dispose();
    expect(proc.killed).toBe(true);
  });

  it('does not kill an exited process when the service is disposed', async () => {
    const svc = ix.get(ISessionTerminalService);
    await svc.create({});
    const proc = host.processes[0]!;
    proc.emitExit(0);

    disposables.dispose();

    expect(proc.killed).toBe(false);
  });
});

describe('host terminal lifecycle (PTY forwarding and App ownership)', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let spawnPty: typeof import('node-pty').spawn;

  beforeEach(async () => {
    disposables = new DisposableStore();
    ({ spawn: spawnPty } = await import('node-pty'));
    vi.mocked(spawnPty).mockReset();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IHostTerminalService, HostTerminalService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('spawns a PTY through node-pty and forwards events', async () => {
    const mockPty = createMockPty();
    vi.mocked(spawnPty).mockReturnValue(mockPty.pty);

    const svc = ix.get(IHostTerminalService);
    const proc = await svc.spawn({ cwd: '/ws', shell: '/bin/sh', cols: 80, rows: 24 });

    expect(spawnPty).toHaveBeenCalledWith('/bin/sh', [], {
      name: 'xterm-256color',
      cwd: '/ws',
      cols: 80,
      rows: 24,
      env: process.env,
    });

    let receivedData = '';
    proc.onProcessData((data) => {
      receivedData += data;
    });
    for (const listener of [...mockPty.dataListeners]) listener('hello');
    expect(receivedData).toBe('hello');

    let receivedExit: { exitCode: number | null } | undefined;
    proc.onProcessExit((event) => {
      receivedExit = event;
    });
    for (const listener of [...mockPty.exitListeners]) listener({ exitCode: 5 });
    expect(receivedExit).toEqual({ exitCode: 5 });

    proc.write('ls\n');
    expect(mockPty.write).toHaveBeenCalledWith('ls\n');

    proc.resize(120, 50);
    expect(mockPty.resize).toHaveBeenCalledWith(120, 50);

    proc.kill();
    expect(mockPty.kill).toHaveBeenCalled();
  });

  it('releases an exited PTY before App disposal without breaking its listeners', async () => {
    const mockPty = createMockPty();
    vi.mocked(spawnPty).mockReturnValue(mockPty.pty);
    const svc = ix.get(IHostTerminalService);
    const proc = await svc.spawn({ cwd: '/ws', shell: '/bin/sh', cols: 80, rows: 24 });
    const output: string[] = [];
    let exitCode: number | null | undefined;
    proc.onProcessData((data) => output.push(data));
    proc.onProcessExit((event) => {
      exitCode = event.exitCode;
    });

    for (const listener of [...mockPty.dataListeners]) listener('complete output');
    for (const listener of [...mockPty.exitListeners]) listener({ exitCode: 0 });
    disposables.dispose();

    expect(output).toEqual(['complete output']);
    expect(exitCode).toBe(0);
    expect(mockPty.kill).not.toHaveBeenCalled();
  });

  it('rejects a spawn that resumes from import after App disposal', async () => {
    const svc = ix.get(IHostTerminalService);
    const pendingSpawn = svc.spawn({ cwd: '/ws', shell: '/bin/sh', cols: 80, rows: 24 });
    const rejected = expect(pendingSpawn).rejects.toThrow('Host terminal service is disposed');

    disposables.dispose();

    await rejected;
    expect(spawnPty).not.toHaveBeenCalled();
  });

  it('kills a PTY created while App disposal interrupts spawn', async () => {
    const mockPty = createMockPty();
    vi.mocked(spawnPty).mockImplementation(() => {
      disposables.dispose();
      return mockPty.pty;
    });
    const svc = ix.get(IHostTerminalService);

    await expect(
      svc.spawn({ cwd: '/ws', shell: '/bin/sh', cols: 80, rows: 24 }),
    ).rejects.toThrow('Host terminal service is disposed');

    expect(mockPty.kill).toHaveBeenCalledTimes(1);
  });

  it('rejects a PTY when App disposal interrupts exit-listener registration', async () => {
    const mockPty = createMockPty(() => disposables.dispose());
    vi.mocked(spawnPty).mockReturnValue(mockPty.pty);
    const svc = ix.get(IHostTerminalService);

    await expect(
      svc.spawn({ cwd: '/ws', shell: '/bin/sh', cols: 80, rows: 24 }),
    ).rejects.toThrow('Host terminal service is disposed');

    expect(mockPty.kill).toHaveBeenCalledTimes(1);
    expect(mockPty.exitListeners.size).toBe(0);
  });
});
