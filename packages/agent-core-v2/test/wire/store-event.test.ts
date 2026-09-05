/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import type { ContentPart } from '#/kosong/contract/message';
import { Event2 } from '#/app/event/event2';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { IAgentStateService } from '#/agent/state/agentState';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { EventDispatcherService } from '#/state/eventDispatcherService';
import { defineState } from '#/state/state';
import { WIRE_PROTOCOL_VERSION } from '#/wire/migration/migration';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import {
  recordingWireLog,
  registerTestAgentWire,
  registerTestEventDispatcher,
  testWireScope,
  noopLogger,
} from './stubs';

const SCOPE = 'wire';
const KEY = 'store-event-test';

class NoteAdded extends Event2<{ text: string }> {
  static override readonly type = 'store-event.note.added';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = z.object({ text: z.string() });
}
interface NoteAdded extends z.infer<typeof NoteAdded.schema> {}

const noteKey = defineState('store-event.notes', (): { notes: string[] } => ({ notes: [] }))
  .replayable({ schema: z.object({ notes: z.array(z.string()) }) })
  .on(NoteAdded, (s, e) => {
    s.notes.push(e.text);
  });

class AttachAdded extends Event2<{ parts: readonly unknown[] }> {
  static override readonly type = 'store-event.attach.added';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = z.object({ parts: z.array(z.unknown()) });
}
interface AttachAdded extends z.infer<typeof AttachAdded.schema> {}

const attachKey = defineState('store-event.attach', (): { parts: unknown[] } => ({ parts: [] }))
  .replayable({
    schema: z.object({ parts: z.array(z.unknown()) }),
    blobs: {
      dehydrate: async (record, transform) => ({
        ...record,
        parts: await transform(record['parts'] as readonly unknown[]),
      }),
      rehydrate: (state) => state,
    },
  })
  .on(AttachAdded, (s, e) => {
    s.parts.push(...e.parts);
  });

let disposables: DisposableStore;
let bus: IEventBus;
let journal: WireRecord[];
let dispatcher: IEventDispatcher;
let agentState: IAgentStateService;

function setup(blob?: IAgentBlobService): void {
  const ix = disposables.add(new TestInstantiationService());
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  bus = ix.get(IEventBus);
  journal = [];
  registerTestAgentWire(ix, testWireScope(SCOPE, KEY), {
    log: recordingWireLog(journal),
    blob,
    eventBus: bus,
  });
  dispatcher = registerTestEventDispatcher(ix);
  agentState = ix.get(IAgentStateService);
  agentState.contributeState(noteKey);
  agentState.contributeState(attachKey);
}

beforeEach(() => {
  disposables = new DisposableStore();
});

afterEach(() => disposables.dispose());

describe('durable observable events', () => {
  it('appends the journal record before publishing the event to the bus', async () => {
    setup();
    const published: string[] = [];
    disposables.add(
      bus.subscribe(NoteAdded, (event) => {
        expect(journal).toEqual([
          { type: 'store-event.note.added', text: event.text, time: event.time },
        ]);
        published.push(event.text);
      }),
    );

    await dispatcher.dispatch(new NoteAdded({ text: 'hello' }));

    expect(agentState.get(noteKey).notes).toEqual(['hello']);
    expect(published).toEqual(['hello']);
    expect(journal).toEqual([
      { type: 'store-event.note.added', text: 'hello', time: expect.any(Number) },
    ]);
  });

  it('publishes the in-memory event while the journal record goes through the state blob dehydrate codec', async () => {
    const offloadCalls: unknown[][] = [];
    const blob: IAgentBlobService = {
      _serviceBrand: undefined,
      offloadParts: async (parts) => {
        offloadCalls.push([...parts]);
        return parts.map((part) => ({ type: 'blob_ref', part })) as unknown as ContentPart[];
      },
      loadParts: async (parts) => parts,
      isBlobRef: () => false,
    };
    setup(blob);
    const published: AttachAdded[] = [];
    disposables.add(bus.subscribe(AttachAdded, (event) => published.push(event)));

    await dispatcher.dispatch(new AttachAdded({ parts: [{ type: 'text', text: 'x' }] }));

    expect(published).toHaveLength(1);
    expect(published[0]!.parts).toEqual([{ type: 'text', text: 'x' }]);
    expect(agentState.get(attachKey).parts).toEqual([{ type: 'text', text: 'x' }]);

    await dispatcher.flush();
    expect(offloadCalls).toEqual([[{ type: 'text', text: 'x' }]]);
    expect(journal).toEqual([
      {
        type: 'store-event.attach.added',
        parts: [{ type: 'blob_ref', part: { type: 'text', text: 'x' } }],
        time: expect.any(Number),
      },
    ]);
  });
});

describe('restore from a corrupted journal', () => {
  it('folds the valid prefix and heals the journal on disk', async () => {
    const ix = disposables.add(new TestInstantiationService());
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    const bus = ix.get(IEventBus);
    const storage = new InMemoryStorageService();
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log = ix.get(IAppendLogStore);
    const scope = testWireScope(SCOPE, KEY);
    registerTestAgentWire(ix, scope, {
      log,
      eventBus: bus,
      storage,
      logger: noopLogger,
      telemetry: noopTelemetryService,
    });
    const dispatcher = registerTestEventDispatcher(ix);
    const agentState = ix.get(IAgentStateService);
    agentState.contributeState(noteKey);

    const metadata = JSON.stringify({
      type: 'metadata',
      protocol_version: WIRE_PROTOCOL_VERSION,
      created_at: 1,
    });
    const note = (text: string): string =>
      JSON.stringify({ type: 'store-event.note.added', text, time: 2 });
    const healed = `${metadata}\n${note('kept')}\n`;
    await storage.write(
      scope,
      AGENT_WIRE_RECORD_KEY,
      new TextEncoder().encode(`${healed}GARBAGE\n${note('dropped')}\n`),
    );

    await dispatcher.restore();

    expect(agentState.get(noteKey).notes).toEqual(['kept']);
    const repaired = await storage.read(scope, AGENT_WIRE_RECORD_KEY);
    expect(new TextDecoder().decode(repaired)).toBe(healed);
  });
});
