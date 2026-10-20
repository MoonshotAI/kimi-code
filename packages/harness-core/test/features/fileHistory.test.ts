import { describe, expect, it } from 'vitest';

import { createFeature, useAgent } from '@moonshot-ai/agent-core/app/index';
import { openBlobStore, type BlobBackend } from '@moonshot-ai/agent-core/blob/index';
import { createUserEntry } from '@moonshot-ai/agent-core/history/index';
import { useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import { createAssistantMessage, createUserMessage, type ToolCall } from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import { MAIN_AGENT_ID, type Agent, type Session } from '@moonshot-ai/agent-core/session/index';
import type { ToolDefinition, ToolResult } from '@moonshot-ai/agent-core/tool/index';

import {
  FileHistoryRef,
  createFileHistory,
  type FileHistoryFace,
  type FileHistoryState,
} from '#/features/fileHistory/index';
import type { OsFsPort } from '#/features/os/host/index';
import {
  createHarness,
  harnessInternals,
  memoryHarnessSpace,
  useAgentTools,
  type Harness,
  type HarnessSessionSpace,
} from '#/runtime/index';

const WORK_DIR = '/ws';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type FakeFs = OsFsPort & {
  readonly set: (path: string, content: string) => void;
  readonly drop: (path: string) => void;
};

function createFakeFs(): FakeFs {
  const files = new Map<string, { data: Uint8Array; mtimeMs: number }>();
  let clock = 0;
  const enoent = (): Error => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const read = (path: string): { data: Uint8Array; mtimeMs: number } => {
    const file = files.get(path);
    if (file === undefined) throw enoent();
    return file;
  };
  const write = (path: string, data: Uint8Array): void => {
    clock += 1;
    files.set(path, { data, mtimeMs: clock });
  };
  const statOf = (path: string) => {
    const file = read(path);
    return { isFile: true, isDirectory: false, size: file.data.byteLength, mtimeMs: file.mtimeMs };
  };
  return {
    set: (path, content) => {
      write(path, encoder.encode(content));
    },
    drop: (path) => {
      files.delete(path);
    },
    readText: async (path) => decoder.decode(read(path).data),
    writeText: async (path, data) => {
      write(path, encoder.encode(data));
    },
    appendText: async (path, data) => {
      const file = read(path);
      write(path, encoder.encode(`${decoder.decode(file.data)}${data}`));
    },
    readBytes: async (path, n) => {
      const file = read(path);
      return file.data.slice(0, n ?? file.data.byteLength);
    },
    writeBytes: async (path, data) => {
      write(path, data);
    },
    readLines: async function* (path) {
      yield* decoder.decode(read(path).data).split('\n');
    },
    createExclusive: async (path, data) => {
      if (files.has(path)) return false;
      write(path, data);
      return true;
    },
    stat: async (path) => statOf(path),
    lstat: async (path) => statOf(path),
    readdir: async () => [],
    mkdir: async () => {},
    remove: async (path) => {
      if (!files.delete(path)) throw enoent();
    },
    rename: async (from, to) => {
      const file = read(from);
      files.delete(from);
      write(to, file.data);
    },
    realpath: async (path) => path,
  };
}

type ScriptStep =
  | { text: string; effect?: () => void | Promise<void> }
  | { toolCall: { name: string; arguments: string } };

let queue: ScriptStep[] = [];
let callSeq = 0;

function textOutcome(text: string, toolCalls: ToolCall[] = []): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls) };
}

function createMockRequester(): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async () => {
      const out = queue.shift() ?? { text: 'done' };
      if ('toolCall' in out) {
        return textOutcome('', [
          {
            type: 'function',
            id: `call-${(callSeq += 1)}`,
            name: out.toolCall.name,
            arguments: out.toolCall.arguments,
          },
        ]);
      }
      if (out.effect !== undefined) await out.effect();
      return textOutcome(out.text);
    },
  };
  return self;
}

function user(text: string) {
  return createUserEntry(createUserMessage(text), { source: 'input' });
}

function setRequester(harness: Harness, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime = session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

interface BlockHandle {
  settle(text: string): void;
}

function bindTestFsTools(fs: FakeFs, block: { current?: BlockHandle }) {
  const editTool: ToolDefinition = {
    name: 'Edit',
    description: 'test edit',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      additionalProperties: false,
    },
    execute: async ({ toolCall }) => {
      const args = JSON.parse(toolCall.arguments ?? '{}') as {
        path: string;
        old_string: string;
        new_string: string;
      };
      const text = await fs.readText(args.path);
      if (!text.includes(args.old_string)) {
        return { content: [{ type: 'text', text: 'old_string not found' }] };
      }
      await fs.writeText(args.path, text.replace(args.old_string, args.new_string));
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  const writeTool: ToolDefinition = {
    name: 'Write',
    description: 'test write',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      additionalProperties: false,
    },
    execute: async ({ toolCall }) => {
      const args = JSON.parse(toolCall.arguments ?? '{}') as { path: string; content: string };
      await fs.writeText(args.path, args.content);
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  const blockTool: ToolDefinition = {
    name: 'TestBlock',
    description: 'test blocking tool',
    parameters: { type: 'object', additionalProperties: false },
    execute: ({ signal }) =>
      new Promise<ToolResult>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('test block aborted'));
        });
        block.current = {
          settle: (text) => {
            resolve({ content: [{ type: 'text', text }] });
          },
        };
      }),
  };
  return createFeature('test-fs-tools', {
    agent() {
      useAgentTools(editTool, writeTool, blockTool);
    },
  });
}

function editStep(path: string, oldString: string, newString: string): ScriptStep {
  return {
    toolCall: {
      name: 'Edit',
      arguments: JSON.stringify({ path, old_string: oldString, new_string: newString }),
    },
  };
}

function writeStep(path: string, content: string): ScriptStep {
  return {
    toolCall: { name: 'Write', arguments: JSON.stringify({ path, content }) },
  };
}

function blobSpace(blobFiles: Map<string, Uint8Array>): HarnessSessionSpace {
  const base = memoryHarnessSpace();
  const backend: BlobBackend = {
    has: async (key) => blobFiles.has(key),
    read: async (key) => blobFiles.get(key),
    write: async (key, data) => {
      blobFiles.set(key, data);
    },
  };
  const blobs = openBlobStore(backend);
  return {
    ...base,
    create: async (id, record) => ({ ...(await base.create(id, record)), blobs }),
    open: async (id) => ({ ...(await base.open(id)), blobs }),
    copy: async (from, to) => ({ ...(await base.copy(from, to)), blobs }),
  };
}

interface HistoryTestEnv {
  readonly harness: Harness;
  readonly session: Session;
  readonly fs: FakeFs;
  readonly blobFiles: Map<string, Uint8Array>;
  readonly block: { current?: BlockHandle };
  main(): Agent;
  face(agentId?: string): FileHistoryFace;
  runTurn(text?: string): Promise<void>;
  remount(): Promise<void>;
  dispose(): Promise<void>;
}

async function startHistoryTest(): Promise<HistoryTestEnv> {
  const blobFiles = new Map<string, Uint8Array>();
  const harness = createHarness({ space: blobSpace(blobFiles) });
  const fs = createFakeFs();
  const block: { current?: BlockHandle } = {};
  const faces = new Map<string, Readonly<ShallowRef<FileHistoryFace | undefined>>>();
  const probe = createFeature('file-history-probe', {
    agent() {
      faces.set(useAgent().id, useInject(FileHistoryRef));
    },
  });
  harness.app.features.add(createFileHistory({ workDir: WORK_DIR, fs }));
  harness.app.features.add(bindTestFsTools(fs, block));
  harness.app.features.add(probe);
  const session = await harness.app.create({ sessionId: 'sess' });
  let main = await harness.ensureAgent(session, MAIN_AGENT_ID);
  setRequester(harness, 'sess', MAIN_AGENT_ID, createMockRequester());
  const face = (agentId: string = MAIN_AGENT_ID): FileHistoryFace => {
    const resolved = faces.get(agentId)?.value;
    if (resolved === undefined) throw new Error(`no fileHistory face for agent '${agentId}'`);
    return resolved;
  };
  const runTurn = async (text = 'go'): Promise<void> => {
    await main.loop.runTurn(user(text));
    await main.flush();
    await face().settled();
  };
  const remount = async (): Promise<void> => {
    await session.close(MAIN_AGENT_ID);
    main = await harness.ensureAgent(session, MAIN_AGENT_ID);
    setRequester(harness, 'sess', MAIN_AGENT_ID, createMockRequester());
    await face().settled();
  };
  const dispose = async (): Promise<void> => {
    await harness.close();
  };
  return {
    harness,
    session,
    fs,
    blobFiles,
    block,
    main: () => main,
    face,
    runTurn,
    remount,
    dispose,
  };
}

function entryAt(
  state: FileHistoryState,
  turnId: number,
  phase: 'start' | 'end',
  path: string,
) {
  return state.checkpoints.find((c) => c.turnId === turnId && (c.phase ?? 'start') === phase)
    ?.entries[path];
}

describe('fileHistory feature', () => {
  it('captures pre-edit content once per turn and versions the turn diff', async () => {
    const env = await startHistoryTest();
    env.fs.set('/ws/a.txt', 'one\ntwo\n');

    queue = [
      editStep('/ws/a.txt', 'two', 'TWO'),
      editStep('/ws/a.txt', 'one', 'ONE'),
      { text: 'done' },
    ];
    await env.runTurn();

    const state = env.face().history();
    expect(state.tracked).toEqual(['a.txt']);
    expect(Object.keys(state.checkpoints.find((c) => c.turnId === 0)!.entries)).toEqual(['a.txt']);
    expect(entryAt(state, 0, 'start', 'a.txt')?.version).toBe(1);
    expect(entryAt(state, 0, 'end', 'a.txt')?.version).toBe(2);
    expect((await env.face().contentAt(0, 'a.txt'))?.content).toBe('one\ntwo\n');
    expect((await env.face().contentAt(0, '/ws/a.txt', 'end'))?.content).toBe('ONE\nTWO\n');
    expect(await env.face().contentAt(1, 'a.txt')).toBeUndefined();
    expect(await env.face().changes(0)).toEqual([
      { path: 'a.txt', status: 'modified', additions: 2, deletions: 2 },
    ]);
    expect(await env.face().turnRecorded(0)).toBe(true);
    expect(await env.face().turnRecorded(1)).toBe(false);
    expect(await env.face().turnRecorded(99)).toBe(false);
    await env.dispose();
  });

  it('records file creation and deletion across turns', async () => {
    const env = await startHistoryTest();

    queue = [writeStep('/ws/new.txt', 'created\n'), { text: 'done' }];
    await env.runTurn();
    expect(entryAt(env.face().history(), 0, 'start', 'new.txt')).toEqual({ key: null, version: 1 });
    expect(await env.face().changes(0)).toEqual([
      { path: 'new.txt', status: 'added', additions: 1, deletions: 0 },
    ]);

    queue = [
      editStep('/ws/new.txt', 'created', 'gone'),
      {
        text: 'done',
        effect: () => {
          env.fs.drop('/ws/new.txt');
        },
      },
    ];
    await env.runTurn();
    expect(entryAt(env.face().history(), 1, 'end', 'new.txt')?.key).toBeNull();
    expect(await env.face().changes(1)).toEqual([
      { path: 'new.txt', status: 'deleted', additions: 0, deletions: 1 },
    ]);
    expect(await env.face().turnRecorded(1)).toBe(true);
    await env.dispose();
  });

  it('excludes user edits between turns via the end-of-turn checkpoint', async () => {
    const env = await startHistoryTest();
    env.fs.set('/ws/a.txt', 'alpha\n');

    queue = [editStep('/ws/a.txt', 'alpha', 'alpha\nagent'), { text: 'done' }];
    await env.runTurn();
    expect(await env.face().changes(0)).toEqual([
      { path: 'a.txt', status: 'modified', additions: 1, deletions: 0 },
    ]);

    env.fs.set('/ws/a.txt', 'alpha\nagent\nuser\n');
    queue = [{ text: 'done' }];
    await env.runTurn();
    expect(await env.face().changes(1)).toEqual([]);
    expect(await env.face().turnRecorded(1)).toBe(false);
    expect((await env.face().contentAt(0, 'a.txt', 'end'))?.content).toBe('alpha\nagent\n');
    expect(await env.face().contentAt(1, 'a.txt')).toBeUndefined();
    await env.dispose();
  });

  it('reuses the previous backup when a tracked file is unchanged at the turn boundary', async () => {
    const env = await startHistoryTest();
    env.fs.set('/ws/b.txt', 'stable\n');

    queue = [editStep('/ws/b.txt', 'MISSING', 'x'), { text: 'done' }];
    await env.runTurn();
    const state = env.face().history();
    expect(entryAt(state, 0, 'start', 'b.txt')?.version).toBe(1);
    expect(entryAt(state, 0, 'end', 'b.txt')).toBeUndefined();
    expect(await env.face().changes(0)).toEqual([]);
    expect(await env.face().turnRecorded(0)).toBe(true);
    expect((await env.face().contentAt(0, 'b.txt'))?.content).toBe('stable\n');

    queue = [{ text: 'done' }];
    await env.runTurn();
    expect(env.face().history().checkpoints.some((c) => c.turnId === 1)).toBe(false);
    expect(env.blobFiles.size).toBe(1);
    await env.dispose();
  });

  it('drops turns outside the retention window and re-baselines returning files', async () => {
    const env = await startHistoryTest();
    env.fs.set('/ws/w.txt', 'v1\n');

    queue = [editStep('/ws/w.txt', 'v1', 'v2'), { text: 'done' }];
    await env.runTurn();
    for (let turn = 1; turn <= 6; turn += 1) {
      queue = [writeStep(`/ws/filler-${String(turn)}.txt`, 'f\n'), { text: 'done' }];
      await env.runTurn();
    }

    const state = env.face().history();
    expect(state.checkpoints.some((c) => c.turnId === 0)).toBe(false);
    expect(state.tracked).not.toContain('w.txt');
    expect(await env.face().changes(0)).toEqual([]);
    expect(await env.face().turnRecorded(0)).toBe(false);

    queue = [editStep('/ws/w.txt', 'v2', 'v3'), { text: 'done' }];
    await env.runTurn();
    const rebased = entryAt(env.face().history(), 7, 'start', 'w.txt');
    expect(rebased?.version).toBe(1);
    expect((await env.face().contentAt(7, 'w.txt'))?.content).toBe('v2\n');
    await env.dispose();
  });

  it('keeps window-edge turns resolvable and detects a lost baseline blob', async () => {
    const env = await startHistoryTest();
    env.fs.set('/ws/e.txt', 'one\n');

    queue = [editStep('/ws/e.txt', 'one', 'two'), { text: 'done' }];
    await env.runTurn();
    queue = [editStep('/ws/e.txt', 'two', 'three'), { text: 'done' }];
    await env.runTurn();
    for (let turn = 2; turn <= 5; turn += 1) {
      queue = [writeStep(`/ws/filler-${String(turn)}.txt`, 'f\n'), { text: 'done' }];
      await env.runTurn();
    }

    const state = env.face().history();
    expect(state.checkpoints.some((c) => c.turnId === 0)).toBe(false);
    expect(await env.face().changes(1)).toEqual([
      { path: 'e.txt', status: 'modified', additions: 1, deletions: 1 },
    ]);
    expect((await env.face().contentAt(1, 'e.txt'))?.content).toBe('two\n');
    expect(await env.face().turnRecorded(1)).toBe(true);

    const keyed = entryAt(env.face().history(), 1, 'start', 'e.txt');
    expect(keyed?.key).not.toBeNull();
    env.blobFiles.delete(`data/${(keyed?.key ?? '').slice('file-history/'.length)}`);
    expect(await env.face().turnRecorded(1)).toBe(false);
    await env.dispose();
  });

  it('restores checkpoints and tracked files from the journal after a remount', async () => {
    const env = await startHistoryTest();
    env.fs.set('/ws/a.txt', 'x\n');

    queue = [editStep('/ws/a.txt', 'x', 'y'), { text: 'done' }];
    await env.runTurn();
    await env.remount();

    const state = env.face().history();
    expect(state.tracked).toEqual(['a.txt']);
    expect(entryAt(state, 0, 'start', 'a.txt')?.version).toBe(1);
    expect((await env.face().contentAt(0, 'a.txt'))?.content).toBe('x\n');
    expect((await env.face().contentAt(0, 'a.txt', 'end'))?.content).toBe('y\n');
    expect(await env.face().changes(0)).toEqual([
      { path: 'a.txt', status: 'modified', additions: 1, deletions: 1 },
    ]);
    expect(await env.face().turnRecorded(0)).toBe(true);

    queue = [editStep('/ws/a.txt', 'y', 'z'), { text: 'done' }];
    await env.runTurn();
    expect(entryAt(env.face().history(), 1, 'start', 'a.txt')?.version).toBe(2);
    expect((await env.face().contentAt(1, 'a.txt'))?.content).toBe('y\n');
    await env.dispose();
  });

  it('forwards subagent edits into the main agent active turn', async () => {
    const env = await startHistoryTest();
    env.fs.set('/ws/sub.txt', 'a\n');

    queue = [
      { toolCall: { name: 'TestBlock', arguments: '{}' } },
      editStep('/ws/sub.txt', 'a', 'b'),
      { text: 'sub done' },
      { text: 'main done' },
    ];
    const mainStarted = env.main().loop.wait('turn.started');
    const mainTurn = env.main().loop.runTurn(user('main go'));
    await mainStarted;

    const sub = await env.harness.ensureAgent(env.session, 'sub-1');
    setRequester(env.harness, 'sess', 'sub-1', createMockRequester());
    await sub.loop.runTurn(user('sub go'));
    await sub.flush();

    expect(env.face('sub-1').history().checkpoints).toEqual([]);
    const mainFace = env.face();
    expect(entryAt(mainFace.history(), 0, 'start', 'sub.txt')?.version).toBe(1);
    expect(await mainFace.changes(0)).toEqual([
      { path: 'sub.txt', status: 'modified', additions: 1, deletions: 1 },
    ]);
    expect(await mainFace.turnRecorded(0)).toBe(true);

    env.block.current?.settle('unblocked');
    await mainTurn;
    await env.main().flush();
    await mainFace.settled();

    expect((await mainFace.contentAt(0, 'sub.txt'))?.content).toBe('a\n');
    expect((await mainFace.contentAt(0, 'sub.txt', 'end'))?.content).toBe('b\n');
    expect(await mainFace.changes(0)).toEqual([
      { path: 'sub.txt', status: 'modified', additions: 1, deletions: 1 },
    ]);
    await env.dispose();
  });

  it('reports an oversize modified file without line counts', async () => {
    const env = await startHistoryTest();
    const big = `h${'x'.repeat(4 * 1024 * 1024)}`;
    env.fs.set('/ws/big.txt', big);

    queue = [
      editStep('/ws/big.txt', 'MISSING', 'y'),
      {
        text: 'done',
        effect: () => {
          env.fs.set('/ws/big.txt', `${big}more`);
        },
      },
    ];
    await env.runTurn();

    const start = entryAt(env.face().history(), 0, 'start', 'big.txt');
    expect(start?.oversize).toBe(true);
    expect(start?.key).toBeNull();
    expect(start?.size).toBe(big.length);
    expect(entryAt(env.face().history(), 0, 'end', 'big.txt')?.oversize).toBe(true);
    expect(await env.face().changes(0)).toEqual([
      { path: 'big.txt', status: 'modified', additions: 0, deletions: 0, oversize: true },
    ]);
    expect(await env.face().contentAt(0, 'big.txt')).toBeUndefined();
    await env.dispose();
  });

  it('keeps files outside the workspace keyed by absolute path', async () => {
    const env = await startHistoryTest();
    env.fs.set('/elsewhere/notes.md', 'note\n');

    queue = [editStep('/elsewhere/notes.md', 'note', 'NOTE'), { text: 'done' }];
    await env.runTurn();

    expect(env.face().history().tracked).toEqual(['/elsewhere/notes.md']);
    expect((await env.face().contentAt(0, '/elsewhere/notes.md'))?.content).toBe('note\n');
    expect(await env.face().changes(0)).toEqual([
      { path: '/elsewhere/notes.md', status: 'modified', additions: 1, deletions: 1 },
    ]);
    await env.dispose();
  });
});
