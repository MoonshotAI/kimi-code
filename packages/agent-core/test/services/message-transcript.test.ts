/**
 * Wire-transcript reader tests (full-history view for compacted sessions).
 *
 * Coverage:
 *   - reduceWireRecords: append + loop events; compaction keeps the prefix and
 *     inserts the summary at the fold point; undo (skip injections, stop at
 *     compaction summaries and clear floors); clear resets the folded view but
 *     keeps the transcript; deferred messages during an open tool exchange;
 *     tool.result `<system>` status wrapping
 *   - readWireRecords: tolerates a torn final line, throws on mid-file corruption
 *   - readWireTranscript: blobref → data URI rehydration from the blobs dir
 *   - MessageService: compacted session lists its FULL history; unflushed live
 *     tail is appended; wire-derived record times drive created_at
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentContextData,
  AgentRecord,
  ContextMessage,
  CoreRPC,
  SessionSummary,
} from '../../src';

import {
  type ICoreProcessService,
  MessageService,
  readWireRecords,
  readWireTranscript,
  reduceWireRecords,
} from '../../src/services';

const SESSION_ID = 'sess_01HZWIRE';
const SESSION_CREATED_AT = 1_700_000_000_000;

function userMessage(text: string, origin?: ContextMessage['origin']): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    ...(origin !== undefined ? { origin } : {}),
  } as ContextMessage;
}

function appendMessage(message: ContextMessage, time?: number): AgentRecord {
  return { type: 'context.append_message', message, time } as AgentRecord;
}

function loopEvent(event: Record<string, unknown>, time?: number): AgentRecord {
  return { type: 'context.append_loop_event', event, time } as unknown as AgentRecord;
}

/** step.begin + content.part + step.end producing one assistant text message. */
function assistantStep(uuid: string, text: string, time?: number): AgentRecord[] {
  return [
    loopEvent({ type: 'step.begin', uuid, turnId: 't', step: 0 }, time),
    loopEvent({ type: 'content.part', uuid: 'p', turnId: 't', step: 0, stepUuid: uuid, part: { type: 'text', text } }),
    loopEvent({ type: 'step.end', uuid, turnId: 't', step: 0 }),
  ];
}

function compaction(summary: string, compactedCount: number, time?: number): AgentRecord {
  return {
    type: 'context.apply_compaction',
    summary,
    compactedCount,
    tokensBefore: 1000,
    tokensAfter: 100,
    time,
  } as AgentRecord;
}

function textOf(message: ContextMessage): string {
  return message.content
    .map((p) => (p.type === 'text' ? p.text : `[${p.type}]`))
    .join('');
}

describe('reduceWireRecords', () => {
  it('builds the transcript from append_message and loop events', () => {
    const { entries, foldedLength } = reduceWireRecords([
      appendMessage(userMessage('u1')),
      ...assistantStep('s1', 'a1'),
    ]);
    expect(entries.map((e) => textOf(e.message))).toEqual(['u1', 'a1']);
    expect(entries.map((e) => e.message.role)).toEqual(['user', 'assistant']);
    expect(foldedLength).toBe(2);
  });

  it('compaction keeps the prefix and inserts the summary at the fold point', () => {
    const { entries, foldedLength } = reduceWireRecords([
      appendMessage(userMessage('u1')),
      ...assistantStep('s1', 'a1'),
      appendMessage(userMessage('u2')),
      ...assistantStep('s2', 'a2'),
      // folded history is [u1, a1, u2, a2]; compact the first 3, keep a2.
      compaction('SUM', 3),
      appendMessage(userMessage('u3')),
    ]);
    expect(entries.map((e) => textOf(e.message))).toEqual([
      'u1',
      'a1',
      'u2',
      'SUM',
      'a2',
      'u3',
    ]);
    expect(entries[3]!.message.origin).toEqual({ kind: 'compaction_summary' });
    // live folded view would be [SUM, a2, u3]
    expect(foldedLength).toBe(3);
  });

  it('handles repeated compactions', () => {
    const { entries, foldedLength } = reduceWireRecords([
      appendMessage(userMessage('u1')),
      compaction('S1', 1),
      appendMessage(userMessage('u2')),
      // folded = [S1, u2]; compact both.
      compaction('S2', 2),
    ]);
    expect(entries.map((e) => textOf(e.message))).toEqual(['u1', 'S1', 'u2', 'S2']);
    expect(foldedLength).toBe(1);
  });

  it('undo removes through the last real user prompt and skips injections', () => {
    const { entries, foldedLength } = reduceWireRecords([
      appendMessage(userMessage('u1')),
      ...assistantStep('s1', 'a1'),
      appendMessage(userMessage('u2')),
      appendMessage(userMessage('note', { kind: 'injection', variant: 'x' })),
      ...assistantStep('s2', 'a2'),
      { type: 'context.undo', count: 1 } as AgentRecord,
    ]);
    // a2 removed, injection skipped (kept), u2 removed → stop.
    expect(entries.map((e) => textOf(e.message))).toEqual(['u1', 'a1', 'note']);
    expect(foldedLength).toBe(3);
  });

  it('undo stops at a compaction summary boundary', () => {
    const { entries } = reduceWireRecords([
      appendMessage(userMessage('u1')),
      compaction('SUM', 1),
      appendMessage(userMessage('u2')),
      { type: 'context.undo', count: 5 } as AgentRecord,
    ]);
    expect(entries.map((e) => textOf(e.message))).toEqual(['u1', 'SUM']);
  });

  it('clear keeps prior messages in the transcript and floors later undos', () => {
    const { entries, foldedLength } = reduceWireRecords([
      appendMessage(userMessage('u1')),
      { type: 'context.clear' } as AgentRecord,
      appendMessage(userMessage('u2')),
      { type: 'context.undo', count: 5 } as AgentRecord,
    ]);
    expect(entries.map((e) => textOf(e.message))).toEqual(['u1']);
    expect(foldedLength).toBe(0);
  });

  it('defers messages appended during an open tool exchange', () => {
    const { entries } = reduceWireRecords([
      loopEvent({ type: 'step.begin', uuid: 's1', turnId: 't', step: 0 }),
      loopEvent({
        type: 'tool.call',
        uuid: 'c1',
        turnId: 't',
        step: 0,
        stepUuid: 's1',
        toolCallId: 'call_1',
        name: 'Bash',
        args: { command: 'ls' },
      }),
      appendMessage(userMessage('steer', { kind: 'injection', variant: 'steer' })),
      loopEvent({
        type: 'tool.result',
        parentUuid: 's1',
        toolCallId: 'call_1',
        result: { output: 'ok' },
      }),
      loopEvent({ type: 'step.end', uuid: 's1', turnId: 't', step: 0 }),
    ]);
    expect(entries.map((e) => e.message.role)).toEqual(['assistant', 'tool', 'user']);
    expect(entries[0]!.message.toolCalls).toEqual([
      { type: 'function', id: 'call_1', name: 'Bash', arguments: '{"command":"ls"}' },
    ]);
    expect(entries[1]!.message.toolCallId).toBe('call_1');
    expect(textOf(entries[1]!.message)).toBe('ok');
  });

  it('wraps tool errors and empty outputs with <system> statuses like agent-core', () => {
    const { entries } = reduceWireRecords([
      loopEvent({ type: 'step.begin', uuid: 's1', turnId: 't', step: 0 }),
      loopEvent({
        type: 'tool.result',
        parentUuid: 's1',
        toolCallId: 'call_err',
        result: { output: 'boom', isError: true },
      }),
      loopEvent({
        type: 'tool.result',
        parentUuid: 's1',
        toolCallId: 'call_empty',
        result: { output: '' },
      }),
    ]);
    expect(textOf(entries[1]!.message)).toBe(
      '<system>ERROR: Tool execution failed.</system>\nboom',
    );
    expect(entries[1]!.message.isError).toBe(true);
    expect(textOf(entries[2]!.message)).toBe('<system>Tool output is empty.</system>');
  });
});

describe('readWireRecords / readWireTranscript', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'kimi-wire-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('drops a torn final line but throws on mid-file corruption', async () => {
    const good = JSON.stringify(appendMessage(userMessage('u1')));
    const torn = path.join(dir, 'torn.jsonl');
    await writeFile(torn, `${good}\n{"type":"context.appe`, 'utf8');
    const records = await readWireRecords(torn);
    expect(records).toHaveLength(1);

    const corrupt = path.join(dir, 'corrupt.jsonl');
    await writeFile(corrupt, `not-json\n${good}\n`, 'utf8');
    await expect(readWireRecords(corrupt)).rejects.toThrow(/corrupted line 1/);
  });

  it('rehydrates blobref media urls from the blobs dir', async () => {
    const hash = 'deadbeefdeadbeefdeadbeefdeadbeef';
    const agentDir = path.join(dir, 'agents', 'main');
    await mkdir(path.join(agentDir, 'blobs'), { recursive: true });
    await writeFile(path.join(agentDir, 'blobs', hash), Buffer.from('PNG!'));
    const message: ContextMessage = {
      role: 'user',
      content: [
        { type: 'image_url', imageUrl: { url: `blobref:image/png;${hash}` } },
        { type: 'image_url', imageUrl: { url: 'blobref:image/png;0123456789abcdef0123' } },
      ],
      toolCalls: [],
    } as ContextMessage;
    await writeFile(
      path.join(agentDir, 'wire.jsonl'),
      `${JSON.stringify(appendMessage(message))}\n`,
      'utf8',
    );

    const transcript = await readWireTranscript(dir, 'main');
    const parts = transcript.entries[0]!.message.content as {
      imageUrl: { url: string };
    }[];
    expect(parts[0]!.imageUrl.url).toBe(
      `data:image/png;base64,${Buffer.from('PNG!').toString('base64')}`,
    );
    expect(parts[1]!.imageUrl.url).toBe('[media missing]');
  });
});

describe('MessageService over a compacted wire log', () => {
  let dir: string;
  let liveHistory: ContextMessage[];
  let bridge: ICoreProcessService;
  let impl: MessageService;

  function summary(): SessionSummary {
    return {
      id: SESSION_ID,
      workDir: '/tmp/ws',
      sessionDir: dir,
      createdAt: SESSION_CREATED_AT,
      updatedAt: SESSION_CREATED_AT,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'kimi-msg-test-'));
    const records: AgentRecord[] = [
      appendMessage(userMessage('u1'), SESSION_CREATED_AT + 1_000),
      ...assistantStep('s1', 'a1', SESSION_CREATED_AT + 2_000),
      appendMessage(userMessage('u2'), SESSION_CREATED_AT + 3_000),
      ...assistantStep('s2', 'a2', SESSION_CREATED_AT + 4_000),
      // folded = [u1, a1, u2, a2] → compact first 3.
      compaction('SUM', 3, SESSION_CREATED_AT + 5_000),
    ];
    await mkdir(path.join(dir, 'agents', 'main'), { recursive: true });
    await writeFile(
      path.join(dir, 'agents', 'main', 'wire.jsonl'),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf8',
    );
    // What getContext would return after the fold.
    liveHistory = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'SUM' }],
        toolCalls: [],
        origin: { kind: 'compaction_summary' },
      } as ContextMessage,
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'a2' }],
        toolCalls: [],
      } as ContextMessage,
    ];
    const rpc: Partial<CoreRPC> = {
      listSessions: vi.fn().mockImplementation(async () => [summary()]),
      resumeSession: vi.fn().mockResolvedValue(undefined as unknown as never),
      getContext: vi.fn().mockImplementation(async (): Promise<AgentContextData> => {
        return { history: liveHistory, tokenCount: 0 };
      }),
    };
    bridge = {
      rpc: rpc as CoreRPC,
      ready: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      _serviceBrand: undefined,
    };
    impl = new MessageService(bridge);
  });

  afterEach(async () => {
    impl.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it('lists the FULL history (compacted prefix + summary + tail)', async () => {
    const page = await impl.list(SESSION_ID, { page_size: 100 });
    const asc = [...page.items].reverse();
    expect(
      asc.map((m) => (m.content[0] as { text?: string }).text ?? '[non-text]'),
    ).toEqual(['u1', 'a1', 'u2', 'SUM', 'a2']);
    expect(asc[3]!.metadata).toEqual({ origin: { kind: 'compaction_summary' } });
  });

  it('uses wire record times for created_at, strictly increasing', async () => {
    const page = await impl.list(SESSION_ID, { page_size: 100 });
    const asc = [...page.items].reverse();
    expect(asc[0]!.created_at).toBe(
      new Date(SESSION_CREATED_AT + 1_000).toISOString(),
    );
    const times = asc.map((m) => new Date(m.created_at).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    }
  });

  it('appends the live tail when memory is ahead of the wire file', async () => {
    liveHistory = [...liveHistory, userMessage('u3-live')];
    const page = await impl.list(SESSION_ID, { page_size: 100 });
    const asc = [...page.items].reverse();
    expect(
      asc.map((m) => (m.content[0] as { text?: string }).text ?? '[non-text]'),
    ).toEqual(['u1', 'a1', 'u2', 'SUM', 'a2', 'u3-live']);
  });

  it('get() resolves ids against the same full transcript', async () => {
    const page = await impl.list(SESSION_ID, { page_size: 100 });
    const asc = [...page.items].reverse();
    const fetched = await impl.get(SESSION_ID, asc[0]!.id);
    expect((fetched.content[0] as { text: string }).text).toBe('u1');
    expect(fetched.created_at).toBe(asc[0]!.created_at);
  });

  it('falls back to the live context view when the wire file is unreadable', async () => {
    await rm(path.join(dir, 'agents', 'main', 'wire.jsonl'));
    const page = await impl.list(SESSION_ID, { page_size: 100 });
    const asc = [...page.items].reverse();
    expect(asc.map((m) => (m.content[0] as { text?: string }).text)).toEqual([
      'SUM',
      'a2',
    ]);
  });

  it('re-reads the wire file after it changes (cache invalidation)', async () => {
    await impl.list(SESSION_ID, { page_size: 100 });
    const wirePath = path.join(dir, 'agents', 'main', 'wire.jsonl');
    const extra = JSON.stringify(
      appendMessage(userMessage('u3'), SESSION_CREATED_AT + 6_000),
    );
    const { readFile } = await import('node:fs/promises');
    const prev = await readFile(wirePath, 'utf8');
    await writeFile(wirePath, prev + extra + '\n', 'utf8');
    liveHistory = [...liveHistory, userMessage('u3')];
    const page = await impl.list(SESSION_ID, { page_size: 100 });
    const asc = [...page.items].reverse();
    expect(
      asc.map((m) => (m.content[0] as { text?: string }).text ?? '[non-text]'),
    ).toEqual(['u1', 'a1', 'u2', 'SUM', 'a2', 'u3']);
  });
});
