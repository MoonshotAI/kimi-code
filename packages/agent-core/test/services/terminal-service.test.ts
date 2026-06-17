import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Emitter } from '../../src';
import type { Session } from '@moonshot-ai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FsPathEscapesError,
  SessionNotFoundError,
  TerminalNotFoundError,
  TerminalService,
  type ISessionService,
  type TerminalBackend,
  type TerminalFrame,
  type TerminalProcess,
  type TerminalSpawnOptions,
} from '../../src/services';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-terminal-service-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

class FakeTerminalProcess implements TerminalProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;

  private readonly dataEmitter = new Emitter<string>();
  private readonly exitEmitter = new Emitter<{ exitCode: number | null }>();

  readonly onData = this.dataEmitter.event;
  readonly onExit = this.exitEmitter.event;

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
    this.exitEmitter.fire({ exitCode: null });
  }

  emitData(data: string): void {
    this.dataEmitter.fire(data);
  }

  emitExit(exitCode: number | null): void {
    this.exitEmitter.fire({ exitCode });
  }
}

class FakeTerminalBackend implements TerminalBackend {
  readonly spawns: TerminalSpawnOptions[] = [];
  readonly processes: FakeTerminalProcess[] = [];

  async spawn(options: TerminalSpawnOptions): Promise<TerminalProcess> {
    this.spawns.push(options);
    const process = new FakeTerminalProcess();
    this.processes.push(process);
    return process;
  }
}

class Sink {
  readonly frames: TerminalFrame[] = [];

  constructor(readonly id: string) {}

  send(frame: TerminalFrame): void {
    this.frames.push(frame);
  }
}

function session(id: string, cwd: string): Session {
  return {
    id,
    workspace_id: `wd_${id}`,
    title: id,
    created_at: '2026-06-04T10:30:00.000Z',
    updated_at: '2026-06-04T10:30:00.000Z',
    status: 'idle',
    archived: false,
    metadata: { cwd },
    agent_config: { model: '' },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_cost_usd: 0,
      context_tokens: 0,
      context_limit: 0,
      turn_count: 0,
    },
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
  };
}

function makeSessionService(sessions: Map<string, Session>): ISessionService {
  const emptyEmitter = new Emitter<never>();
  return {
    _serviceBrand: undefined,
    create: async () => {
      throw new Error('not implemented');
    },
    list: async () => ({ items: [...sessions.values()], has_more: false }),
    get: async (id: string) => {
      const found = sessions.get(id);
      if (found === undefined) throw new SessionNotFoundError(id);
      return found;
    },
    update: async () => {
      throw new Error('not implemented');
    },
    fork: async () => {
      throw new Error('not implemented');
    },
    listChildren: async () => ({ items: [], has_more: false }),
    createChild: async () => {
      throw new Error('not implemented');
    },
    getStatus: async () => {
      throw new Error('not implemented');
    },
    compact: async () => {
      throw new Error('not implemented');
    },
    undo: async () => {
      throw new Error('not implemented');
    },
    archive: async () => {
      throw new Error('not implemented');
    },
    onDidCreate: emptyEmitter.event,
    onDidClose: emptyEmitter.event,
  };
}

describe('TerminalService.create', () => {
  it('starts a terminal in the session workspace by default', async () => {
    const root = join(tmpDir, 'workspace-a');
    mkdirSync(root, { recursive: true });
    const backend = new FakeTerminalBackend();
    const svc = new TerminalService({ backend }, makeSessionService(new Map([
      ['sess_a', session('sess_a', root)],
    ])));

    const terminal = await svc.create('sess_a', {});

    expect(terminal.session_id).toBe('sess_a');
    expect(terminal.cwd).toBe(realpathSync(root));
    expect(backend.spawns[0]!.cwd).toBe(realpathSync(root));
  });

  it('supports independent terminals for any number of sessions', async () => {
    const rootA = join(tmpDir, 'workspace-a');
    const rootB = join(tmpDir, 'workspace-b');
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
    const backend = new FakeTerminalBackend();
    const svc = new TerminalService({ backend }, makeSessionService(new Map([
      ['sess_a', session('sess_a', rootA)],
      ['sess_b', session('sess_b', rootB)],
    ])));

    const termA = await svc.create('sess_a', {});
    const termB = await svc.create('sess_b', {});

    expect(termA.id).not.toBe(termB.id);
    expect((await svc.list('sess_a')).map((t) => t.id)).toEqual([termA.id]);
    expect((await svc.list('sess_b')).map((t) => t.id)).toEqual([termB.id]);
    expect(backend.spawns.map((spawn) => spawn.cwd)).toEqual([
      realpathSync(rootA),
      realpathSync(rootB),
    ]);
  });

  it('resolves relative cwd overrides under the session workspace', async () => {
    const root = join(tmpDir, 'workspace-c');
    const nested = join(root, 'packages/server');
    mkdirSync(nested, { recursive: true });
    const backend = new FakeTerminalBackend();
    const svc = new TerminalService({ backend }, makeSessionService(new Map([
      ['sess_c', session('sess_c', root)],
    ])));

    const terminal = await svc.create('sess_c', { cwd: 'packages/server' });

    expect(terminal.cwd).toBe(realpathSync(nested));
    expect(backend.spawns[0]!.cwd).toBe(realpathSync(nested));
  });

  it('rejects cwd overrides that escape the session workspace', async () => {
    const root = join(tmpDir, 'workspace-d');
    mkdirSync(root, { recursive: true });
    const backend = new FakeTerminalBackend();
    const svc = new TerminalService({ backend }, makeSessionService(new Map([
      ['sess_d', session('sess_d', root)],
    ])));

    await expect(svc.create('sess_d', { cwd: '../outside' })).rejects.toBeInstanceOf(
      FsPathEscapesError,
    );
  });
});

describe('TerminalService streams', () => {
  it('buffers output and replays frames after since_seq', async () => {
    const root = join(tmpDir, 'workspace-e');
    mkdirSync(root, { recursive: true });
    const backend = new FakeTerminalBackend();
    const svc = new TerminalService({ backend }, makeSessionService(new Map([
      ['sess_e', session('sess_e', root)],
    ])));
    const terminal = await svc.create('sess_e', {});
    const process = backend.processes[0]!;

    process.emitData('first');
    process.emitData('second');

    const sink = new Sink('conn_1');
    const result = await svc.attach('sess_e', terminal.id, sink, { sinceSeq: 1 });

    expect(result).toEqual({ replayed: 1 });
    expect(sink.frames).toMatchObject([
      { type: 'terminal_output', seq: 2, payload: { data: 'second' } },
    ]);

    process.emitData('third');
    expect(sink.frames.at(-1)).toMatchObject({
      type: 'terminal_output',
      seq: 3,
      payload: { data: 'third' },
    });
  });

  it('writes input, resizes, detaches sinks, and closes the backend process', async () => {
    const root = join(tmpDir, 'workspace-f');
    mkdirSync(root, { recursive: true });
    const backend = new FakeTerminalBackend();
    const svc = new TerminalService({ backend }, makeSessionService(new Map([
      ['sess_f', session('sess_f', root)],
    ])));
    const terminal = await svc.create('sess_f', {});
    const process = backend.processes[0]!;
    const sink = new Sink('conn_2');
    await svc.attach('sess_f', terminal.id, sink);

    await svc.write('sess_f', terminal.id, 'pwd\r');
    await svc.resize('sess_f', terminal.id, 100, 40);
    svc.detach('sess_f', terminal.id, sink.id);
    process.emitData('after detach');
    const closeResult = await svc.close('sess_f', terminal.id);

    expect(process.writes).toEqual(['pwd\r']);
    expect(process.resizes).toEqual([{ cols: 100, rows: 40 }]);
    expect(sink.frames).toEqual([]);
    expect(closeResult).toEqual({ closed: true });
    expect(process.killed).toBe(true);
    expect((await svc.get('sess_f', terminal.id)).status).toBe('exited');
  });

  it('throws TerminalNotFoundError when terminal_id is not owned by that session', async () => {
    const rootA = join(tmpDir, 'workspace-g-a');
    const rootB = join(tmpDir, 'workspace-g-b');
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
    const backend = new FakeTerminalBackend();
    const svc = new TerminalService({ backend }, makeSessionService(new Map([
      ['sess_a', session('sess_a', rootA)],
      ['sess_b', session('sess_b', rootB)],
    ])));
    const terminal = await svc.create('sess_a', {});

    await expect(svc.get('sess_b', terminal.id)).rejects.toBeInstanceOf(
      TerminalNotFoundError,
    );
  });
});
