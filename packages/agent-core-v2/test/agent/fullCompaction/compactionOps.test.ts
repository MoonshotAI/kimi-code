import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import {
  fullCompactionKey,
  FullCompactionBegin,
  FullCompactionCancel,
  FullCompactionComplete,
} from '#/agent/fullCompaction/compactionOps';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import {
  registerTestAgentWire,
  registerTestEventDispatcher,
  restoreTestEventDispatcher,
  testWireScope,
} from '../../wire/stubs';

const SCOPE = 'wire';
const KEY = 'full-compaction-test';

let disposables: DisposableStore;
let dispatcher: IEventDispatcher;
let agentState: IAgentStateService;
let log: IAppendLogStore;

function buildHost(key: string): {
  dispatcher: IEventDispatcher;
  agentState: IAgentStateService;
  log: IAppendLogStore;
  eventBus: IEventBus;
} {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  registerTestAgentWire(ix, testWireScope(SCOPE, key), {
    log: ix.get(IAppendLogStore),
    eventBus: ix.get(IEventBus),
  });
  const dispatcher = registerTestEventDispatcher(ix);
  ix.get(IAgentStateService).contributeState(fullCompactionKey);
  return {
    dispatcher,
    agentState: ix.get(IAgentStateService),
    log: ix.get(IAppendLogStore),
    eventBus: ix.get(IEventBus),
  };
}

beforeEach(() => {
  disposables = new DisposableStore();
  const host = buildHost(KEY);
  dispatcher = host.dispatcher;
  agentState = host.agentState;
  log = host.log;
});

afterEach(() => disposables.dispose());

async function readRecords(key = KEY): Promise<WireRecord[]> {
  await dispatcher.flush();
  const out: WireRecord[] = [];
  for await (const record of log.read<WireRecord>(testWireScope(SCOPE, key), AGENT_WIRE_RECORD_KEY)) {
    out.push(record);
  }
  return out;
}

describe('fullCompaction ops (wire-backed)', () => {
  it('begin/complete/cancel drive the phase and persist flat records', async () => {
    expect(agentState.get(fullCompactionKey).phase).toBe('idle');

    void dispatcher.dispatch(new FullCompactionBegin({ agentId: 'test-agent', source: 'manual', instruction: 'keep facts' }));
    expect(agentState.get(fullCompactionKey).phase).toBe('running');

    void dispatcher.dispatch(new FullCompactionComplete({ agentId: 'test-agent' }));
    expect(agentState.get(fullCompactionKey).phase).toBe('idle');

    void dispatcher.dispatch(new FullCompactionBegin({ agentId: 'test-agent', source: 'auto' }));
    expect(agentState.get(fullCompactionKey).phase).toBe('running');
    void dispatcher.dispatch(new FullCompactionCancel({ agentId: 'test-agent' }));
    expect(agentState.get(fullCompactionKey).phase).toBe('idle');

    const records = await readRecords();
    expect(records.map((record) => record.type)).toEqual([
      'full_compaction.begin',
      'full_compaction.complete',
      'full_compaction.begin',
      'full_compaction.cancel',
    ]);
    expect(records.every((record) => 'payload' in record === false)).toBe(true);
    expect(records[0]).toEqual(
      expect.objectContaining({
        type: 'full_compaction.begin',
        source: 'manual',
        instruction: 'keep facts',
      }),
    );
    expect(records[1]).toEqual({
      type: 'full_compaction.complete',
      agentId: 'test-agent',
      time: expect.any(Number),
    });
  });

  it('fold keeps the same reference on a no-op (state stays quiet)', () => {
    void dispatcher.dispatch(new FullCompactionCancel({ agentId: 'test-agent' }));
    const idle = agentState.get(fullCompactionKey);
    void dispatcher.dispatch(new FullCompactionCancel({ agentId: 'test-agent' }));
    expect(agentState.get(fullCompactionKey)).toBe(idle);

    void dispatcher.dispatch(new FullCompactionBegin({ agentId: 'test-agent', source: 'manual' }));
    const running = agentState.get(fullCompactionKey);
    void dispatcher.dispatch(new FullCompactionBegin({ agentId: 'test-agent', source: 'auto' }));
    expect(agentState.get(fullCompactionKey)).toBe(running);
  });

  it('replay rebuilds the phase silently', async () => {
    void dispatcher.dispatch(new FullCompactionBegin({ agentId: 'test-agent', source: 'manual' }));
    void dispatcher.dispatch(new FullCompactionComplete({ agentId: 'test-agent' }));
    const records = await readRecords();

    const host = buildHost('full-compaction-replay');
    const emissions: string[] = [];
    host.eventBus.subscribe((e) => {
      emissions.push(e.type);
    });
    await restoreTestEventDispatcher(
      host.dispatcher,
      host.log,
      testWireScope(SCOPE, 'full-compaction-replay'),
      records,
    );
    expect(host.agentState.get(fullCompactionKey).phase).toBe('idle');
    expect(emissions).toEqual([]);

    const stranded = buildHost('full-compaction-stranded');
    await restoreTestEventDispatcher(
      stranded.dispatcher,
      stranded.log,
      testWireScope(SCOPE, 'full-compaction-stranded'),
      [{ type: 'full_compaction.begin', source: 'auto' }],
    );
    expect(stranded.agentState.get(fullCompactionKey).phase).toBe('running');
  });

  it('replays legacy complete payloads that carried accounting numbers', async () => {
    const host = buildHost('full-compaction-legacy-complete-replay');

    await restoreTestEventDispatcher(
      host.dispatcher,
      host.log,
      testWireScope(SCOPE, 'full-compaction-legacy-complete-replay'),
      [
        { type: 'full_compaction.begin', source: 'manual' },
        { type: 'full_compaction.complete', compactedCount: 1, tokensBefore: 50, tokensAfter: 10 },
      ],
    );

    expect(host.agentState.get(fullCompactionKey).phase).toBe('idle');
  });
});
