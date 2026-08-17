/**
 * `AgentContextMemoryService` wire contract, exercised without the full agent
 * harness (mirror of `test/goal/goal-wire.test.ts`): a `TestInstantiationService`
 * + `InMemoryStorageService` + `AppendLogStore` + `WireService` + stub
 * `IAgentBlobService`. Covers the context Ops' NEW-reference + flat-record
 * shape, the live-only `context.spliced` event (silent on replay), and —
 * load-bearing — the blob dehydrate-on-dispatch ↔ rehydrate-on-replay
 * round-trip via `ContextModel.blobs`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { AgentContextMemoryService } from '#/agent/contextMemory/contextMemoryService';
import { swarmExit } from '#/features/swarm/swarmOps';
import {
  ContextModel,
  contextAppendMessage,
  contextApplyCompaction,
  contextClear,
  contextUndo,
} from '#/agent/contextMemory/contextOps';
import { EMPTY_FOLD, type ContextMessage } from '#/agent/contextMemory/types';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import type { ContentPart } from '#/kosong/contract/message';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { registerTestAgentWire, restoreTestAgentWire, testWireScope } from '../../wire/stubs';

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

function mediaUrl(message: ContextMessage): string {
  const part = message.content[0] as unknown as { source: { url: string } };
  return part.source.url;
}

function textOf(message: ContextMessage): string {
  const part = message.content[0] as unknown as { text?: unknown };
  if (typeof part.text !== 'string') throw new Error('expected text content');
  return part.text;
}

let disposables: DisposableStore;
let blob: StubBlobService;

interface Host {
  wire: IWireService;
  svc: IAgentContextMemoryService;
  log: IAppendLogStore;
  eventBus: IEventBus;
}

function buildHost(key: string): Host {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.stub(IAgentBlobService, blob);
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  ix.set(IAgentContextMemoryService, new SyncDescriptor(AgentContextMemoryService));
  const wire = registerTestAgentWire(ix, testWireScope(SCOPE, key), {
    log: ix.get(IAppendLogStore),
    blob,
    eventBus: ix.get(IEventBus),
  });
  return {
    wire,
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

describe('AgentContextMemoryService (wire-backed)', () => {
  beforeEach(() => {
    disposables = new DisposableStore();
    blob = new StubBlobService();
  });

  afterEach(() => disposables.dispose());

  describe('wire model and replay', () => {
    it('splice/append/undo/apply_compaction/clear/append_loop_event each update getModel with a NEW reference and persist flat records', async () => {
    const host = buildHost(KEY);
    const model = () => host.wire.getModel(ContextModel).messages as readonly ContextMessage[];

    host.wire.dispatch(
      contextAppendMessage({ message: userMessage('a') }),
      contextAppendMessage({ message: userMessage('b') }),
    );
    expect(model()).toHaveLength(2);

    let prev = model();
    host.wire.dispatch(contextAppendMessage({ message: userMessage('c') }));
    expect(model()).not.toBe(prev);
    expect(model()).toHaveLength(3);

    prev = model();
    host.wire.dispatch(contextUndo({ count: 1 }));
    expect(model()).not.toBe(prev);
    expect(model()).toHaveLength(2);
    expect(host.wire.getModel(ContextModel).fold).toEqual(EMPTY_FOLD);

    prev = model();
    host.wire.dispatch(
      contextApplyCompaction({ summary: 'sum', compactedCount: 1, tokensBefore: 0, tokensAfter: 0 }),
    );
    expect(model()).not.toBe(prev);
    // Append-only: the log keeps the pre-compaction messages and gains a
    // summary marker carrying the record fields as `CompactionMeta`.
    expect(model()).toHaveLength(3);
    expect(model()![2]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'sum' }],
      origin: { kind: 'compaction_summary' },
      compaction: { compactedCount: 1, tokensBefore: 0, tokensAfter: 0 },
    });
    expect(host.wire.getModel(ContextModel).fold).toEqual(EMPTY_FOLD);
    // The model-visible window derives to the legacy `[summary, …tail]` layout.
    expect(host.svc.get().map(textOf)).toEqual(['sum', 'b']);
    expect(host.svc.get()[0]!.compaction).toBeUndefined();

    prev = model();
    host.wire.dispatch(contextClear({}));
    expect(model()).not.toBe(prev);
    expect(model()).toHaveLength(0);
    expect(host.wire.getModel(ContextModel).fold).toEqual(EMPTY_FOLD);

    await host.wire.flush();
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

  it('folds v1 context.append_loop_event records into the ContextModel on replay', async () => {
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
    await restoreTestAgentWire(
      replay.wire,
      replay.log,
      testWireScope(SCOPE, REPLAY_KEY),
      records,
    );

    const model = replay.wire.getModel(ContextModel).messages as readonly ContextMessage[];
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
    await restoreTestAgentWire(
      replay.wire,
      replay.log,
      testWireScope(SCOPE, REPLAY_KEY),
      records,
    );

    const log = replay.wire.getModel(ContextModel).messages as readonly ContextMessage[];
    expect(log.map(textOf)).toEqual(['old', 'tail', 'model-facing summary']);
    expect(log[2]).toMatchObject({
      role: 'user',
      origin: { kind: 'compaction_summary' },
    });

    const visible = replay.svc.get();
    expect(visible.map(textOf)).toEqual(['model-facing summary', 'tail']);
    expect(visible[0]).toMatchObject({
      role: 'user',
      origin: { kind: 'compaction_summary' },
    });
    expect(visible[0]!.compaction).toBeUndefined();
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
    await restoreTestAgentWire(
      replay.wire,
      replay.log,
      testWireScope(SCOPE, REPLAY_KEY),
      records,
    );

    const log = replay.wire.getModel(ContextModel).messages as readonly ContextMessage[];
    expect(log.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'user']);

    const visible = replay.svc.get();
    expect(visible.map((message) => message.role)).toEqual(['user', 'user', 'user']);
    expect(visible.map(textOf)).toEqual(['old user', 'recent user', 'model-facing summary']);
    expect(visible[2]).toMatchObject({
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
    await restoreTestAgentWire(
      replay.wire,
      replay.log,
      testWireScope(SCOPE, REPLAY_KEY),
      records,
    );

    const model = replay.wire.getModel(ContextModel).messages as readonly ContextMessage[];
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
    await restoreTestAgentWire(
      replay.wire,
      replay.log,
      testWireScope(SCOPE, REPLAY_KEY),
      records,
    );

    const log = replay.wire.getModel(ContextModel).messages as readonly ContextMessage[];
    expect(log).toHaveLength(3);
    // The verbatim legacy summary message becomes the marker, meta attached.
    expect(log[2]).toMatchObject({
      origin: { kind: 'compaction_summary' },
      compaction: { compactedCount: 1, legacyTail: true },
    });

    const visible = replay.svc.get();
    expect(visible).toHaveLength(2);
    expect(visible[0]).toEqual(legacySummary);
    expect(textOf(visible[1]!)).toBe('tail');
  });
  });

  describe('blob rehydration', () => {
  it('offloads an oversized content part on dispatch and rehydrates it byte-for-byte on replay', async () => {
    const host = buildHost(KEY);
    const big = 'A'.repeat(200);
    const dataUri = `data:image/png;base64,${big}`;

    host.wire.dispatch(contextAppendMessage({ message: imageMessage(big) }));
    await host.wire.flush();

    const live = host.wire.getModel(ContextModel).messages as readonly ContextMessage[];
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
    await restoreTestAgentWire(
      replay.wire,
      replay.log,
      testWireScope(SCOPE, REPLAY_KEY),
      records,
    );
    expect(blob.loadCalls).toBeGreaterThanOrEqual(1);

    const rebuilt = replay.wire.getModel(ContextModel).messages as readonly ContextMessage[];
    expect(rebuilt).toEqual(live);
    expect(mediaUrl(rebuilt[0]!)).toBe(dataUri);
  });

  it('rehydrates only messages surviving the compaction marker on replay', async () => {
    const userMedia: ContextMessage = {
      role: 'user',
      content: [
        { type: 'image', source: { url: `${BLOBREF}image/png;shaKept` } } as unknown as ContentPart,
      ],
      toolCalls: [],
    };
    const toolMedia: ContextMessage = {
      role: 'tool',
      content: [
        { type: 'image', source: { url: `${BLOBREF}image/png;shaHidden` } } as unknown as ContentPart,
      ],
      toolCalls: [],
      toolCallId: 'call_1',
    };
    blob.store.set('shaKept', 'KEPT');
    blob.store.set('shaHidden', 'HIDDEN');
    const records: WireRecord[] = [
      { type: 'context.append_message', message: userMedia },
      { type: 'context.append_message', message: toolMedia },
      {
        type: 'context.apply_compaction',
        summary: 's',
        contextSummary: 'S',
        compactedCount: 2,
        tokensBefore: 10,
        tokensAfter: 5,
        keptUserMessageCount: 1,
      },
    ];

    const replay = buildHost(REPLAY_KEY);
    await restoreTestAgentWire(
      replay.wire,
      replay.log,
      testWireScope(SCOPE, REPLAY_KEY),
      records,
    );

    // The kept user message (the derivation's selection pool) is rehydrated…
    const visible = replay.svc.get();
    expect(visible.map((message) => message.role)).toEqual(['user', 'user']);
    expect(mediaUrl(visible[0]!)).toBe('data:image/png;base64,KEPT');
    // …while the compacted-away tool media stays a blobref and costs no load.
    const log = replay.wire.getModel(ContextModel).messages as readonly ContextMessage[];
    expect(mediaUrl(log[1]!)).toBe(`${BLOBREF}image/png;shaHidden`);
    expect(blob.loadCalls).toBe(1);
  });

  it('rehydrates media in the legacy compaction tail that stays visible', async () => {
    const tailMedia: ContextMessage = {
      role: 'assistant',
      content: [
        { type: 'image', source: { url: `${BLOBREF}image/png;shaTail` } } as unknown as ContentPart,
      ],
      toolCalls: [],
    };
    const hiddenMedia: ContextMessage = {
      role: 'tool',
      content: [
        { type: 'image', source: { url: `${BLOBREF}image/png;shaGone` } } as unknown as ContentPart,
      ],
      toolCalls: [],
      toolCallId: 'call_1',
    };
    blob.store.set('shaTail', 'TAIL');
    blob.store.set('shaGone', 'GONE');
    // No keptUserMessageCount → legacyTail: the window keeps
    // `[summary, …messages.slice(compactedCount)]`, so the assistant media
    // message before the marker remains model-visible.
    const records: WireRecord[] = [
      { type: 'context.append_message', message: hiddenMedia },
      { type: 'context.append_message', message: tailMedia },
      {
        type: 'context.apply_compaction',
        summary: 's',
        contextSummary: 'S',
        compactedCount: 1,
        tokensBefore: 10,
        tokensAfter: 5,
      },
    ];

    const replay = buildHost(REPLAY_KEY);
    await restoreTestAgentWire(
      replay.wire,
      replay.log,
      testWireScope(SCOPE, REPLAY_KEY),
      records,
    );

    const visible = replay.svc.get();
    expect(visible.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(mediaUrl(visible[1]!)).toBe('data:image/png;base64,TAIL');
    const log = replay.wire.getModel(ContextModel).messages as readonly ContextMessage[];
    expect(mediaUrl(log[0]!)).toBe(`${BLOBREF}image/png;shaGone`);
    expect(blob.loadCalls).toBe(1);
  });
  });

  describe('live splice events and replayed prompt ownership', () => {
  it('publishes context.spliced on live dispatch and is silent on replay', async () => {
    const host = buildHost(KEY);
    const live: { start: number; deleteCount: number }[] = [];
    disposables.add(host.eventBus.subscribe('context.spliced', (event) => {
      live.push({ start: event.start, deleteCount: event.deleteCount });
    }));

    host.svc.append(userMessage('x'));
    host.svc.append(userMessage('y'));
    expect(live).toHaveLength(2);
    await host.wire.flush();
    const records = await readRecords(host.log);

    const replay = buildHost(REPLAY_KEY);
    const replayed: { start: number; deleteCount: number }[] = [];
    disposables.add(replay.eventBus.subscribe('context.spliced', (event) => {
      replayed.push({ start: event.start, deleteCount: event.deleteCount });
    }));
    await restoreTestAgentWire(
      replay.wire,
      replay.log,
      testWireScope(SCOPE, REPLAY_KEY),
      records,
    );
    expect(replayed).toHaveLength(0);
    expect(replay.wire.getModel(ContextModel).messages as readonly ContextMessage[]).toHaveLength(2);
  });

  it('pairs prompt-owned injections with their prompt by persisted id, live and on replay', async () => {
    const host = buildHost(KEY);
    const model = () => host.wire.getModel(ContextModel).messages as readonly ContextMessage[];

    const reminder: ContextMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'caption' }],
      toolCalls: [],
      origin: { kind: 'injection', variant: 'image_compression', ownerPromptId: 'prompt-1' },
    };
    const prompt: ContextMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'undo me' }],
      toolCalls: [],
      id: 'prompt-1',
      origin: { kind: 'user' },
    };
    const answer: ContextMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      toolCalls: [],
    };

    host.svc.append(reminder, prompt, answer);
    host.svc.undo(1);
    expect(model()).toHaveLength(0);

    await host.wire.flush();
    const records = await readRecords(host.log);

    const replay = buildHost(REPLAY_KEY);
    await restoreTestAgentWire(
      replay.wire,
      replay.log,
      testWireScope(SCOPE, REPLAY_KEY),
      records,
    );
    expect(replay.wire.getModel(ContextModel).messages).toHaveLength(0);
  });
  });

  describe('compaction and window derivation', () => {
  it('derives the visible window through multiple compaction markers', () => {
    const host = buildHost(KEY);

    host.svc.append(userMessage('u1'));
    host.wire.dispatch(
      contextApplyCompaction({
        summary: 's1',
        contextSummary: 'S1',
        compactedCount: 1,
        tokensBefore: 10,
        tokensAfter: 5,
        keptUserMessageCount: 1,
      }),
    );
    host.svc.append(userMessage('u2'));
    host.wire.dispatch(
      contextApplyCompaction({
        summary: 's2',
        contextSummary: 'S2',
        compactedCount: 2,
        tokensBefore: 20,
        tokensAfter: 6,
        keptUserMessageCount: 2,
      }),
    );

    const log = host.wire.getModel(ContextModel).messages as readonly ContextMessage[];
    expect(log.map(textOf)).toEqual(['u1', 'S1', 'u2', 'S2']);

    // The second derivation selects from the post-first-compaction window, so
    // the earlier summary never re-enters the visible pool.
    const visible = host.svc.get();
    expect(visible.map(textOf)).toEqual(['u1', 'u2', 'S2']);
    expect(visible.every((message) => message.compaction === undefined)).toBe(true);
  });

  it('settles an open frame before appending a compaction marker', () => {
    const host = buildHost(KEY);

    host.svc.append(userMessage('u1'));
    // An overflow-failed attempt: the step is opened with a pending tool
    // call and never ends before the compaction lands mid-fold.
    host.svc.appendLoopEvent({ type: 'step.begin', uuid: 's1' });
    host.svc.appendLoopEvent({
      type: 'tool.call',
      stepUuid: 's1',
      toolCallId: 'c1',
      name: 'Bash',
      args: {},
    });
    host.wire.dispatch(
      contextApplyCompaction({
        summary: 's',
        contextSummary: 'S',
        compactedCount: 2,
        tokensBefore: 10,
        tokensAfter: 5,
        keptUserMessageCount: 1,
      }),
    );

    const state = host.wire.getModel(ContextModel);
    const log = state.messages as readonly ContextMessage[];
    // The marker landed on a settled frame: the pending exchange is closed
    // with an interrupted tool message ahead of the marker, and no partial
    // assistant survives behind it.
    expect(log.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(log.every((message) => message.partial !== true)).toBe(true);
    expect(log[3]!.compaction).toBeDefined();
    expect(state.fold).toEqual(EMPTY_FOLD);

    // The retried step appends only — nothing mutates the log behind the
    // marker (the append-only invariant `historySafeToCompact` relies on).
    host.svc.appendLoopEvent({ type: 'step.begin', uuid: 's2' });
    const after = host.wire.getModel(ContextModel).messages as readonly ContextMessage[];
    expect(after).toHaveLength(log.length + 1);
    expect(log.every((message, index) => after[index] === message)).toBe(true);
  });
  });

  describe('undo and splice behavior', () => {
  it('maps an undo cut in the visible tail back to the append-only log', () => {
    const host = buildHost(KEY);

    host.svc.append(userMessage('u1'));
    host.wire.dispatch(
      contextApplyCompaction({
        summary: 's1',
        contextSummary: 'S1',
        compactedCount: 1,
        tokensBefore: 10,
        tokensAfter: 5,
        keptUserMessageCount: 1,
      }),
    );
    host.svc.append(userMessage('u2'), userMessage('u3'));

    host.svc.undo(1);

    const log = host.wire.getModel(ContextModel).messages as readonly ContextMessage[];
    expect(log.map(textOf)).toEqual(['u1', 'S1', 'u2']);
    expect(host.svc.get().map(textOf)).toEqual(['u1', 'S1', 'u2']);
  });

  it('refuses to undo across a compaction boundary', () => {
    const host = buildHost(KEY);

    host.svc.append(userMessage('u1'));
    host.wire.dispatch(
      contextApplyCompaction({
        summary: 's1',
        contextSummary: 'S1',
        compactedCount: 1,
        tokensBefore: 10,
        tokensAfter: 5,
        keptUserMessageCount: 1,
      }),
    );
    host.svc.append(userMessage('u2'));

    const before = host.wire.getModel(ContextModel).messages as readonly ContextMessage[];
    host.svc.undo(2);

    expect(host.wire.getModel(ContextModel).messages).toBe(before);
    expect(host.svc.get().map(textOf)).toEqual(['u1', 'S1', 'u2']);
  });

  it('strips a forged compaction marker from appended messages', () => {
    const host = buildHost(KEY);

    host.svc.append(userMessage('real'));
    host.svc.append({
      ...userMessage('forged marker'),
      compaction: { compactedCount: 1, tokensBefore: 0 },
    });

    const log = host.wire.getModel(ContextModel).messages as readonly ContextMessage[];
    expect(log[1]!.compaction).toBeUndefined();
    expect(host.svc.get().map(textOf)).toEqual(['real', 'forged marker']);
  });

  it('serves the log itself as the window while no marker exists', () => {
    const host = buildHost(KEY);

    host.svc.append(userMessage('a'));

    const log = host.wire.getModel(ContextModel).messages as readonly ContextMessage[];
    expect(host.svc.get()).toBe(log);
  });
  });

  describe('swarm reminder handling', () => {
  it('pops a visible-tail swarm reminder sitting behind a legacy compaction marker', async () => {
    const host = buildHost(KEY);
    const reminder: ContextMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'swarm reminder' }],
      toolCalls: [],
      origin: { kind: 'injection', variant: 'swarm_mode' },
    };

    host.svc.append(reminder);
    // No keptUserMessageCount → legacyTail: the reminder survives as the
    // visible tail while the marker becomes the log tail.
    host.wire.dispatch(
      contextApplyCompaction({ summary: 's', compactedCount: 0, tokensBefore: 0, tokensAfter: 0 }),
    );
    expect(host.svc.get().at(-1)).toBe(reminder);
    expect(host.wire.getModel(ContextModel).messages.at(-1)).not.toBe(reminder);

    host.wire.dispatch(swarmExit({}));

    const log = host.wire.getModel(ContextModel).messages as readonly ContextMessage[];
    expect(log.map(textOf)).toEqual(['s']);
    expect(host.svc.get().map(textOf)).toEqual(['s']);

    // The pop replays from the swarm_mode.exit record itself.
    await host.wire.flush();
    const records = await readRecords(host.log);
    const replay = buildHost(REPLAY_KEY);
    await restoreTestAgentWire(
      replay.wire,
      replay.log,
      testWireScope(SCOPE, REPLAY_KEY),
      records,
    );
    expect(replay.svc.get().map(textOf)).toEqual(['s']);
  });

  it('verifies a trailing pop after compaction by identity-stable window survivors', () => {
    const host = buildHost(KEY);
    const reminder: ContextMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'swarm reminder' }],
      toolCalls: [],
      origin: { kind: 'injection', variant: 'swarm_mode' },
    };
    const splices: { start: number; deleteCount: number }[] = [];
    disposables.add(
      host.eventBus.subscribe('context.spliced', (e) => {
        splices.push({ start: e.start, deleteCount: e.deleteCount });
      }),
    );

    host.svc.append(userMessage('u1'), userMessage('u2'));
    host.wire.dispatch(
      contextApplyCompaction({
        summary: 's',
        contextSummary: 'S',
        compactedCount: 2,
        tokensBefore: 10,
        tokensAfter: 4,
        keptUserMessageCount: 2,
      }),
    );
    host.svc.append(reminder);
    const before = host.svc.get();
    expect(before.at(-1)).toBe(reminder);

    host.wire.dispatch(swarmExit({}));

    // The pop re-derives the window from a new log, but the synthesized
    // compaction prefix keeps its identity, so the verification passes and
    // the live splice is published.
    expect(host.svc.publishTrailingRemoval(before)).toBe(true);
    expect(splices.at(-1)).toEqual({ start: before.length - 1, deleteCount: 1 });
  });
  });

  describe('live vs replay parity', () => {
  it('derives identical log and window live and on replay', async () => {
    const host = buildHost(KEY);

    host.svc.append(userMessage('u1'), userMessage('u2'));
    host.wire.dispatch(
      contextApplyCompaction({
        summary: 's1',
        contextSummary: 'S1',
        compactedCount: 2,
        tokensBefore: 10,
        tokensAfter: 4,
        keptUserMessageCount: 2,
      }),
    );
    host.svc.append(userMessage('u3'));
    await host.wire.flush();
    const records = await readRecords(host.log);

    const replay = buildHost(REPLAY_KEY);
    await restoreTestAgentWire(
      replay.wire,
      replay.log,
      testWireScope(SCOPE, REPLAY_KEY),
      records,
    );

    expect(replay.wire.getModel(ContextModel).messages).toEqual(
      host.wire.getModel(ContextModel).messages,
    );
    expect(replay.svc.get()).toEqual(host.svc.get());
  });
  });
});
