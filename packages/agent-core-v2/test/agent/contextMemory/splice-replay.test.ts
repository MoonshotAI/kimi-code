import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { AgentContextMemoryService } from '#/agent/contextMemory/contextMemoryService';
import {
  ContextAppendLoopEvent,
  ContextAppendMessage,
  ContextApplyCompaction,
  ContextClear,
  ContextSpliced,
  ContextUndo,
} from '#/agent/contextMemory/contextEvents';
import { contextMemoryKey } from '#/agent/contextMemory/contextOps';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import type { ContentPart } from '#/kosong/contract/message';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { DeepReadonly } from '#/state/state';
import { IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import {
  registerTestAgentWire,
  registerTestEventDispatcher,
  restoreTestEventDispatcher,
  testWireScope,
} from '../../wire/stubs';

const SCOPE = 'wire';
const KEY = 'ctx-live';
const REPLAY_KEY = 'ctx-replay';
const BLOBREF = 'blobref:';
const DATA_URI_RE = /^data:([^;]+);base64,(.+)$/;
const OFFLOAD_THRESHOLD = 64;

function asMedia(value: unknown): { url: string } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  return typeof obj['url'] === 'string' ? (obj as { url: string }) : undefined;
}

class StubBlobService implements IAgentBlobService {
  declare readonly _serviceBrand: undefined;
  readonly store = new Map<string, string>();
  offloadCalls = 0;
  loadCalls = 0;
  private seq = 0;

  isBlobRef(url: string): boolean {
    return url.startsWith(BLOBREF);
  }

  async offloadParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]> {
    let changed = false;
    const out = parts.map((part) => {
      const next = this.offloadPart(part);
      if (next !== part) changed = true;
      return next;
    });
    return changed ? out : parts;
  }

  async loadParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]> {
    let changed = false;
    const out = parts.map((part) => {
      const next = this.rehydratePart(part);
      if (next !== part) changed = true;
      return next;
    });
    return changed ? out : parts;
  }

  private offloadPart(part: ContentPart): ContentPart {
    const obj = part as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      const media = asMedia(value);
      if (media === undefined) continue;
      const match = DATA_URI_RE.exec(media.url);
      if (match === null) continue;
      const payload = match[2]!;
      if (payload.length < OFFLOAD_THRESHOLD) continue;
      const sha = `sha${this.seq++}`;
      this.store.set(sha, payload);
      this.offloadCalls++;
      return { ...obj, [key]: { ...media, url: `${BLOBREF}${match[1]};${sha}` } } as unknown as ContentPart;
    }
    return part;
  }

  private rehydratePart(part: ContentPart): ContentPart {
    const obj = part as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      const media = asMedia(value);
      if (media === undefined || !this.isBlobRef(media.url)) continue;
      const rest = media.url.slice(BLOBREF.length);
      const semi = rest.indexOf(';');
      const mime = rest.slice(0, semi);
      const sha = rest.slice(semi + 1);
      const payload = this.store.get(sha);
      if (payload === undefined) continue;
      this.loadCalls++;
      return { ...obj, [key]: { ...media, url: `data:${mime};base64,${payload}` } } as unknown as ContentPart;
    }
    return part;
  }
}

function userMessage(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

function imageMessage(payload: string): ContextMessage {
  const part = {
    type: 'image',
    source: { url: `data:image/png;base64,${payload}` },
  } as unknown as ContentPart;
  return { role: 'user', content: [part], toolCalls: [] };
}

function mediaUrl(message: DeepReadonly<ContextMessage>): string {
  const part = message.content[0] as unknown as { source: { url: string } };
  return part.source.url;
}

function textOf(message: DeepReadonly<ContextMessage>): string {
  const part = message.content[0] as unknown as { text?: unknown };
  if (typeof part.text !== 'string') throw new Error('expected text content');
  return part.text;
}

let disposables: DisposableStore;
let blob: StubBlobService;

interface Host {
  wire: IWireService;
  dispatcher: IEventDispatcher;
  agentState: IAgentStateService;
  svc: IAgentContextMemoryService;
  log: IAppendLogStore;
  eventBus: IEventBus;
}

const noopTokenCounting: IAgentTokenCountingService = {
  _serviceBrand: undefined,
  strategy: 'measured+estimated',
  get: () => ({ size: 0, measured: 0, estimated: 0 }),
  measured: () => {},
  latestMeasured: () => 0,
  statusSize: () => 0,
  requestSize: () => 0,
  estimateText: () => 0,
  estimateMessage: () => 0,
  estimateMessages: () => 0,
  estimateTools: () => 0,
};

function buildHost(key: string): Host {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.stub(IAgentBlobService, blob);
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  ix.set(IAgentTokenCountingService, noopTokenCounting);
  ix.set(IAgentContextMemoryService, new SyncDescriptor(AgentContextMemoryService));
  const wire = registerTestAgentWire(ix, testWireScope(SCOPE, key), {
    log: ix.get(IAppendLogStore),
    blob,
    eventBus: ix.get(IEventBus),
  });
  const dispatcher = registerTestEventDispatcher(ix);
  return {
    wire,
    dispatcher,
    agentState: ix.get(IAgentStateService),
    svc: ix.get(IAgentContextMemoryService),
    log: ix.get(IAppendLogStore),
    eventBus: ix.get(IEventBus),
  };
}

async function readRecords(log: IAppendLogStore, key = KEY): Promise<WireRecord[]> {
  const out: WireRecord[] = [];
  for await (const record of log.read<WireRecord>(testWireScope(SCOPE, key), AGENT_WIRE_RECORD_KEY)) {
    out.push(record);
  }
  return out;
}

beforeEach(() => {
  disposables = new DisposableStore();
  blob = new StubBlobService();
});

afterEach(() => disposables.dispose());

describe('AgentContextMemoryService (wire-backed)', () => {
  it('splice/append/undo/apply_compaction/clear/append_loop_event each update getState with a NEW reference and persist flat records', async () => {
    const host = buildHost(KEY);
    const model = () => host.agentState.get(contextMemoryKey);

    await host.dispatcher.dispatch(new ContextAppendMessage({ message: userMessage('a') }));
    await host.dispatcher.dispatch(new ContextAppendMessage({ message: userMessage('b') }));
    expect(model()).toHaveLength(2);

    let prev = model();
    await host.dispatcher.dispatch(new ContextAppendMessage({ message: userMessage('c') }));
    expect(model()).not.toBe(prev);
    expect(model()).toHaveLength(3);

    prev = model();
    await host.dispatcher.dispatch(new ContextUndo({ count: 1 }));
    expect(model()).not.toBe(prev);
    expect(model()).toHaveLength(2);

    prev = model();
    await host.dispatcher.dispatch(
      new ContextApplyCompaction({ summary: 'sum', compactedCount: 1, tokensBefore: 0, tokensAfter: 0 }),
    );
    expect(model()).not.toBe(prev);
    expect(model()).toHaveLength(2);
    expect(model()![0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'sum' }],
      origin: { kind: 'compaction_summary' },
    });

    prev = model();
    await host.dispatcher.dispatch(new ContextClear({}));
    expect(model()).not.toBe(prev);
    expect(model()).toHaveLength(0);

    await host.dispatcher.flush();
    const records = await readRecords(host.log);
    expect(records.every((record) => 'payload' in record === false)).toBe(true);
    expect(records.map((record) => record.type)).toEqual([
      'context.append_message',
      'context.append_message',
      'context.append_message',
      'context.undo',
      'context.apply_compaction',
      'context.clear',
    ]);
  });

  it('folds v1 context.append_loop_event records into the contextMemoryKey on replay', async () => {
    const records: WireRecord[] = [
      { type: 'context.append_message', message: userMessage('q') },
      { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 's1', turnId: '0', step: 1 } },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          uuid: 'p1',
          turnId: '0',
          step: 1,
          stepUuid: 's1',
          part: { type: 'text', text: 'hello' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'c1',
          turnId: '0',
          step: 1,
          stepUuid: 's1',
          toolCallId: 'call_1',
          name: 'Bash',
          args: { command: 'echo hi' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          parentUuid: 'c1',
          toolCallId: 'call_1',
          result: { output: 'hi' },
        },
      },
      { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 's1', turnId: '0', step: 1 } },
    ];

    const replay = buildHost(REPLAY_KEY);
    await restoreTestEventDispatcher(
      replay.dispatcher,
      replay.log,
      testWireScope(SCOPE, REPLAY_KEY),
      records,
    );

    const model = replay.agentState.get(contextMemoryKey);
    expect(model.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(model[1]!.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(model[1]!.partial).toBeUndefined();
    expect(model[1]!.toolCalls).toHaveLength(1);
    expect(model[1]!.toolCalls[0]!.id).toBe('call_1');
    expect(model[1]!.toolCalls[0]!.name).toBe('Bash');
    expect(model[2]!.role).toBe('tool');
    expect(model[2]!.toolCallId).toBe('call_1');
  });

  it('replays v1 context.apply_compaction records with contextSummary as the model summary', async () => {
    const records: WireRecord[] = [
      { type: 'context.append_message', message: userMessage('old') },
      { type: 'context.append_message', message: userMessage('tail') },
      {
        type: 'context.apply_compaction',
        summary: 'human-facing summary',
        contextSummary: 'model-facing summary',
        compactedCount: 1,
        tokensBefore: 100,
        tokensAfter: 20,
      },
    ];

    const replay = buildHost(REPLAY_KEY);
    await restoreTestEventDispatcher(
      replay.dispatcher,
      replay.log,
      testWireScope(SCOPE, REPLAY_KEY),
      records,
    );

    const model = replay.agentState.get(contextMemoryKey);
    expect(model.map(textOf)).toEqual(['model-facing summary', 'tail']);
    expect(model[0]).toMatchObject({
      role: 'user',
      origin: { kind: 'compaction_summary' },
    });
  });

  it('replays new context.apply_compaction records with kept user messages before contextSummary', async () => {
    const records: WireRecord[] = [
      { type: 'context.append_message', message: userMessage('old user') },
      {
        type: 'context.append_message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'old assistant' }],
          toolCalls: [],
        },
      },
      { type: 'context.append_message', message: userMessage('recent user') },
      {
        type: 'context.apply_compaction',
        summary: 'raw summary',
        contextSummary: 'model-facing summary',
        compactedCount: 3,
        tokensBefore: 100,
        tokensAfter: 20,
        keptUserMessageCount: 2,
      },
    ];

    const replay = buildHost(REPLAY_KEY);
    await restoreTestEventDispatcher(
      replay.dispatcher,
      replay.log,
      testWireScope(SCOPE, REPLAY_KEY),
      records,
    );

    const model = replay.agentState.get(contextMemoryKey);
    expect(model.map((message) => message.role)).toEqual(['user', 'user', 'user']);
    expect(model.map(textOf)).toEqual(['old user', 'recent user', 'model-facing summary']);
    expect(model[2]).toMatchObject({
      origin: { kind: 'compaction_summary' },
    });
  });

  it('replays pre-contextSummary kept-user records without adding a new prefix', async () => {
    const records: WireRecord[] = [
      { type: 'context.append_message', message: userMessage('old user') },
      { type: 'context.append_message', message: userMessage('recent user') },
      {
        type: 'context.apply_compaction',
        summary: 'OLD SUMMARY',
        compactedCount: 2,
        tokensBefore: 100,
        tokensAfter: 20,
        keptUserMessageCount: 2,
      },
    ];

    const replay = buildHost(REPLAY_KEY);
    await restoreTestEventDispatcher(
      replay.dispatcher,
      replay.log,
      testWireScope(SCOPE, REPLAY_KEY),
      records,
    );

    const model = replay.agentState.get(contextMemoryKey);
    expect(model.map(textOf)).toEqual(['old user', 'recent user', 'OLD SUMMARY']);
    expect(model[2]).toMatchObject({
      role: 'user',
      origin: { kind: 'compaction_summary' },
    });
  });

  it('replays legacy v2 context.apply_compaction records with count and summary message', async () => {
    const legacySummary: ContextMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'legacy summary message' }],
      toolCalls: [],
      origin: { kind: 'compaction_summary' },
    };
    const records: WireRecord[] = [
      { type: 'context.append_message', message: userMessage('old') },
      { type: 'context.append_message', message: userMessage('tail') },
      {
        type: 'context.apply_compaction',
        count: 1,
        summary: legacySummary,
      },
    ];

    const replay = buildHost(REPLAY_KEY);
    await restoreTestEventDispatcher(
      replay.dispatcher,
      replay.log,
      testWireScope(SCOPE, REPLAY_KEY),
      records,
    );

    const model = replay.agentState.get(contextMemoryKey);
    expect(model).toHaveLength(2);
    expect(model[0]).toEqual(legacySummary);
    expect(textOf(model[1]!)).toBe('tail');
  });

  it('offloads an oversized content part on dispatch and rehydrates it byte-for-byte on replay', async () => {
    const host = buildHost(KEY);
    const big = 'A'.repeat(200);
    const dataUri = `data:image/png;base64,${big}`;

    await host.dispatcher.dispatch(new ContextAppendMessage({ message: imageMessage(big) }));
    await host.dispatcher.flush();

    const live = host.agentState.get(contextMemoryKey);
    expect(live).toHaveLength(1);
    expect(mediaUrl(live[0]!)).toBe(dataUri);

    const records = await readRecords(host.log);
    expect(blob.offloadCalls).toBeGreaterThanOrEqual(1);
    const appended = records.find((record) => record.type === 'context.append_message');
    expect(appended).toBeDefined();
    const persisted = appended!['message'] as ContextMessage;
    expect(mediaUrl(persisted).startsWith(BLOBREF)).toBe(true);
    expect(mediaUrl(persisted)).not.toContain(big);

    const replay = buildHost(REPLAY_KEY);
    await restoreTestEventDispatcher(
      replay.dispatcher,
      replay.log,
      testWireScope(SCOPE, REPLAY_KEY),
      records,
    );
    expect(blob.loadCalls).toBeGreaterThanOrEqual(1);

    const rebuilt = replay.agentState.get(contextMemoryKey);
    expect(rebuilt).toEqual(live);
    expect(mediaUrl(rebuilt[0]!)).toBe(dataUri);
  });

  it('settles an open step when blob rehydration replaces the folded context state', async () => {
    const host = buildHost(KEY);
    const big = 'A'.repeat(200);

    await host.dispatcher.dispatch(new ContextAppendMessage({ message: imageMessage(big) }));
    await host.dispatcher.dispatch(
      new ContextAppendLoopEvent({ event: { type: 'step.begin', uuid: 'interrupted' } }),
    );
    await host.dispatcher.flush();
    const records = await readRecords(host.log);

    const replay = buildHost(REPLAY_KEY);
    await restoreTestEventDispatcher(
      replay.dispatcher,
      replay.log,
      testWireScope(SCOPE, REPLAY_KEY),
      records,
    );
    expect(blob.loadCalls).toBeGreaterThanOrEqual(1);

    await replay.dispatcher.dispatch(new ContextAppendMessage({ message: userMessage('retry') }));
    await replay.dispatcher.dispatch(
      new ContextAppendLoopEvent({ event: { type: 'step.begin', uuid: 'recovered' } }),
    );
    await replay.dispatcher.dispatch(
      new ContextAppendLoopEvent({
        event: {
          type: 'content.part',
          stepUuid: 'recovered',
          part: { type: 'text', text: 'answer' },
        },
      }),
    );
    await replay.dispatcher.dispatch(
      new ContextAppendLoopEvent({ event: { type: 'step.end', uuid: 'recovered' } }),
    );

    const rebuilt = replay.agentState.get(contextMemoryKey);
    expect(rebuilt.map((message) => message.role)).toEqual(['user', 'user', 'assistant']);
    expect(textOf(rebuilt[1]!)).toBe('retry');
    expect(textOf(rebuilt[2]!)).toBe('answer');
    expect(rebuilt.some((message) => message.partial === true)).toBe(false);
  });

  it('publishes context.spliced on live dispatch and is silent on replay', async () => {
    const host = buildHost(KEY);
    const live: { start: number; deleteCount: number }[] = [];
    disposables.add(host.eventBus.subscribe(ContextSpliced, (event) => {
      live.push({ start: event.start, deleteCount: event.deleteCount });
    }));

    host.svc.append(userMessage('x'));
    host.svc.append(userMessage('y'));
    expect(live).toHaveLength(2);
    await host.dispatcher.flush();
    const records = await readRecords(host.log);

    const replay = buildHost(REPLAY_KEY);
    const replayed: { start: number; deleteCount: number }[] = [];
    disposables.add(replay.eventBus.subscribe(ContextSpliced, (event) => {
      replayed.push({ start: event.start, deleteCount: event.deleteCount });
    }));
    await restoreTestEventDispatcher(
      replay.dispatcher,
      replay.log,
      testWireScope(SCOPE, REPLAY_KEY),
      records,
    );
    expect(replayed).toHaveLength(0);
    expect(replay.agentState.get(contextMemoryKey)).toHaveLength(2);
  });

});
