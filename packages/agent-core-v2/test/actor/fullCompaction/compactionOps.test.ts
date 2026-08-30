import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { createHooks } from '#/hooks';
import {
  FullCompactionBegin,
  FullCompactionCancel,
  FullCompactionComplete,
} from '#/actor/fullCompaction/compactionOps';
import { AgentFullCompaction, type FullCompactionStatus } from '#/actor/fullCompaction/fullCompactionAgentRuntime';
import type { LoopControl } from '#/actor/loop/internal/loop';
import { getLoopControl, registerLoopControl } from '#/actor/loop/internal/access';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentHostService } from '#/agent/host/agentHost';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { AgentRuntimeSet } from '#/actor/agentRuntimeSet';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import {
  attachFullCompactionRuntime,
  registerTestAgentWire,
  registerTestEventDispatcher,
  restoreTestEventDispatcher,
  stubAgentScopeContext,
  testWireScope,
} from '../../wire/stubs';

const SCOPE = 'wire';
const KEY = 'full-compaction-test';

let disposables: DisposableStore;
let dispatcher: IEventDispatcher;
let runtimes: AgentRuntimeSet;
let log: IAppendLogStore;

function buildHost(key: string): {
  dispatcher: IEventDispatcher;
  runtimes: AgentRuntimeSet;
  log: IAppendLogStore;
  eventBus: IEventBus;
} {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  ix.stub(IAgentHostService, {
    _serviceBrand: undefined,
    of: () => ({
      eventBus: ix.get(IEventBus),
      telemetry: { track2: () => {} },
    }),
  } as unknown as IAgentHostService);
  const agentScope = stubAgentScopeContext(testWireScope(SCOPE, key));
  registerTestAgentWire(ix, agentScope, {
    log: ix.get(IAppendLogStore),
    eventBus: ix.get(IEventBus),
  });
  registerLoopControl(agentScope.agentContext, {
    _serviceBrand: undefined,
    hooks: createHooks(['onWillBeginStep', 'onDidFinishStep']),
    registerLoopErrorHandler: () => toDisposable(() => {}),
  } as unknown as LoopControl, () => ({ nextTurnId: 0, cancelledTurnIds: [] }));
  const dispatcher = registerTestEventDispatcher(ix, agentScope);
  const runtimes = attachFullCompactionRuntime(ix, ix.get(IEventDispatcher), agentScope.agentContext);
  return {
    dispatcher,
    runtimes,
    log: ix.get(IAppendLogStore),
    eventBus: ix.get(IEventBus),
  };
}

beforeEach(() => {
  disposables = new DisposableStore();
  const host = buildHost(KEY);
  dispatcher = host.dispatcher;
  runtimes = host.runtimes;
  log = host.log;
});

afterEach(() => disposables.dispose());

function status(): FullCompactionStatus {
  return runtimes.resolve(AgentFullCompaction).status();
}

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
    expect(status()).toBe('idle');

    void dispatcher.dispatch(new FullCompactionBegin({ agentId: 'test-agent', source: 'manual', instruction: 'keep facts' }));
    expect(status()).toBe('running');

    void dispatcher.dispatch(new FullCompactionComplete({ agentId: 'test-agent' }));
    expect(status()).toBe('idle');

    void dispatcher.dispatch(new FullCompactionBegin({ agentId: 'test-agent', source: 'auto' }));
    expect(status()).toBe('running');
    void dispatcher.dispatch(new FullCompactionCancel({ agentId: 'test-agent' }));
    expect(status()).toBe('idle');

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

  it('keeps the phase unchanged on a no-op fold (state stays quiet)', () => {
    void dispatcher.dispatch(new FullCompactionCancel({ agentId: 'test-agent' }));
    expect(status()).toBe('idle');
    void dispatcher.dispatch(new FullCompactionCancel({ agentId: 'test-agent' }));
    expect(status()).toBe('idle');

    void dispatcher.dispatch(new FullCompactionBegin({ agentId: 'test-agent', source: 'manual' }));
    expect(status()).toBe('running');
    void dispatcher.dispatch(new FullCompactionBegin({ agentId: 'test-agent', source: 'auto' }));
    expect(status()).toBe('running');
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
    expect(host.runtimes.resolve(AgentFullCompaction).status()).toBe('idle');
    expect(emissions).toEqual([]);

    const stranded = buildHost('full-compaction-stranded');
    await restoreTestEventDispatcher(
      stranded.dispatcher,
      stranded.log,
      testWireScope(SCOPE, 'full-compaction-stranded'),
      [{ type: 'full_compaction.begin', source: 'auto' }],
    );
    expect(stranded.runtimes.resolve(AgentFullCompaction).status()).toBe('running');
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

    expect(host.runtimes.resolve(AgentFullCompaction).status()).toBe('idle');
  });
});
