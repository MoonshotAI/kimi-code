/**
 * `AgentContextMemoryService` wire contract, exercised without the full agent
 * harness (mirror of `test/goal/goal-wire.test.ts`): a `TestInstantiationService`
 * + `InMemoryStorageService` + `AppendLogStore` + `WireService` + stub
 * `IAgentBlobService`. Covers the splice Ops' NEW-reference + flat-record shape,
 * the live-only `onSpliced` hook (silent on replay), and — load-bearing — the
 * blob dehydrate-on-dispatch ↔ rehydrate-on-replay round-trip via
 * `ContextModel.blobs`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentBlobService } from '#/agent/blob';
import {
  AgentContextMemoryService,
  ContextModel,
  contextAppendMessage,
  contextApplyCompaction,
  contextClear,
  contextUndo,
  IAgentContextMemoryService,
  type ContextMessage,
} from '#/agent/contextMemory';
import type { ContentPart } from '#/app/llmProtocol';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import {
  IAgentWireService,
  WireService,
  type IWireService,
  type PersistedRecord,
} from '#/wire';

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

function summaryMessage(text: string): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'compaction_summary' },
  };
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

let disposables: DisposableStore;
let blob: StubBlobService;

interface Host {
  wire: IWireService;
  svc: IAgentContextMemoryService;
  log: IAppendLogStore;
}

function buildHost(key: string): Host {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(
    IAgentWireService,
    new SyncDescriptor(WireService, [
      { logScope: SCOPE, logKey: key },
    ]),
  );
  ix.stub(IAgentBlobService, blob);
  ix.set(IAgentContextMemoryService, new SyncDescriptor(AgentContextMemoryService));
  return {
    wire: ix.get(IAgentWireService),
    svc: ix.get(IAgentContextMemoryService),
    log: ix.get(IAppendLogStore),
  };
}

async function readRecords(log: IAppendLogStore, key = KEY): Promise<PersistedRecord[]> {
  const out: PersistedRecord[] = [];
  for await (const record of log.read<PersistedRecord>(SCOPE, key)) {
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
  it('splice/append/undo/apply_compaction/clear/append_loop_event each update getModel with a NEW reference and persist flat records', async () => {
    const host = buildHost(KEY);
    const model = () => host.wire.getModel(ContextModel) as readonly ContextMessage[];

    host.svc.splice(0, 0, [userMessage('a'), userMessage('b')]);
    expect(model()).toHaveLength(2);

    let prev = model();
    host.wire.dispatch(contextAppendMessage({ message: userMessage('c') }));
    expect(model()).not.toBe(prev);
    expect(model()).toHaveLength(3);

    prev = model();
    host.wire.dispatch(contextUndo({ count: 1 }));
    expect(model()).not.toBe(prev);
    expect(model()).toHaveLength(2);

    prev = model();
    host.wire.dispatch(contextApplyCompaction({ count: 1, summary: summaryMessage('sum') }));
    expect(model()).not.toBe(prev);
    expect(model()![0]).toMatchObject({ content: [{ type: 'text', text: 'sum' }] });

    prev = model();
    host.wire.dispatch(contextClear({}));
    expect(model()).not.toBe(prev);
    expect(model()).toHaveLength(0);

    await host.wire.flush();
    const records = await readRecords(host.log);
    expect(records.every((record) => 'payload' in record === false)).toBe(true);
    expect(records.map((record) => record.type)).toEqual([
      'context.splice',
      'context.append_message',
      'context.undo',
      'context.apply_compaction',
      'context.clear',
    ]);
  });

  it('folds v1 context.append_loop_event records into the ContextModel on replay', async () => {
    const records: PersistedRecord[] = [
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
    await replay.wire.replay(...records);

    const model = replay.wire.getModel(ContextModel) as readonly ContextMessage[];
    expect(model.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(model[1]!.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(model[1]!.partial).toBeUndefined();
    expect(model[1]!.toolCalls).toHaveLength(1);
    expect(model[1]!.toolCalls[0]!.id).toBe('call_1');
    expect(model[1]!.toolCalls[0]!.name).toBe('Bash');
    expect(model[2]!.role).toBe('tool');
    expect(model[2]!.toolCallId).toBe('call_1');
  });

  it('offloads an oversized content part on dispatch and rehydrates it byte-for-byte on replay', async () => {
    const host = buildHost(KEY);
    const big = 'A'.repeat(200);
    const dataUri = `data:image/png;base64,${big}`;

    host.svc.splice(0, 0, [imageMessage(big)]);
    await host.wire.flush();

    const live = host.wire.getModel(ContextModel) as readonly ContextMessage[];
    expect(live).toHaveLength(1);
    expect(mediaUrl(live[0]!)).toBe(dataUri);

    const records = await readRecords(host.log);
    expect(blob.offloadCalls).toBeGreaterThanOrEqual(1);
    const splice = records.find((record) => record.type === 'context.splice');
    expect(splice).toBeDefined();
    const persisted = (splice!['messages'] as readonly ContextMessage[])[0]!;
    expect(mediaUrl(persisted).startsWith(BLOBREF)).toBe(true);
    expect(mediaUrl(persisted)).not.toContain(big);

    const replay = buildHost(REPLAY_KEY);
    await replay.wire.replay(...records);
    expect(blob.loadCalls).toBeGreaterThanOrEqual(1);

    const rebuilt = replay.wire.getModel(ContextModel) as readonly ContextMessage[];
    expect(rebuilt).toEqual(live);
    expect(mediaUrl(rebuilt[0]!)).toBe(dataUri);
  });

  it('onSpliced fires on live dispatch and is silent on replay', async () => {
    const host = buildHost(KEY);
    const live: { start: number; deleteCount: number }[] = [];
    host.svc.hooks.onSpliced.register('test', async (ctx, next) => {
      live.push({ start: ctx.start, deleteCount: ctx.deleteCount });
      await next();
    });

    host.svc.splice(0, 0, [userMessage('x')]);
    host.svc.splice(0, 0, [userMessage('y')]);
    expect(live).toHaveLength(2);
    await host.wire.flush();
    const records = await readRecords(host.log);

    const replay = buildHost(REPLAY_KEY);
    const replayed: { start: number; deleteCount: number }[] = [];
    replay.svc.hooks.onSpliced.register('test', async (ctx, next) => {
      replayed.push({ start: ctx.start, deleteCount: ctx.deleteCount });
      await next();
    });
    await replay.wire.replay(...records);
    expect(replayed).toHaveLength(0);
    expect(replay.wire.getModel(ContextModel) as readonly ContextMessage[]).toHaveLength(2);
  });

});
