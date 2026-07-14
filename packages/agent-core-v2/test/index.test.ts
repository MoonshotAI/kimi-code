import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_WIRE_PROTOCOL_VERSION,
  IAgentContextMemoryService,
  IAgentContextSizeService,
  IAgentGoalService,
  type ContextMessage,
  type PersistedWireRecord,
} from '#/index';
import {
  InMemoryWireRecordPersistence,
  createTestAgent,
  testAgent,
  type TestAgentContext,
} from './harness';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { setRuntimePhase } from '#/agent/runtime/runtimeOps';
import { contextAppendMessage } from '#/agent/contextMemory/contextOps';
import { wireMetadata } from '#/agent/wireRecord/metadataOps';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { todoSet, TodoModel } from '#/session/todo/todoOps';
import { OP_REGISTRY } from '#/wire/op';
import { IAgentWireService } from '#/wire/tokens';
import type { PersistedRecord } from '#/wire/wireService';
import { WireService } from '#/wire/wireServiceImpl';

const V1_RECORD_TYPES: ReadonlySet<string> = new Set([
  'metadata',
  'forked',
  'turn.prompt',
  'turn.steer',
  'turn.cancel',
  'config.update',
  'permission.set_mode',
  'permission.record_approval_result',
  'full_compaction.begin',
  'full_compaction.cancel',
  'full_compaction.complete',
  'micro_compaction.apply',
  'plan_mode.enter',
  'plan_mode.cancel',
  'plan_mode.exit',
  'swarm_mode.enter',
  'swarm_mode.exit',
  'tools.register_user_tool',
  'tools.unregister_user_tool',
  'tools.set_active_tools',
  'tools.update_store',
  'usage.record',
  'context.append_message',
  'context.append_loop_event',
  'context.clear',
  'context.apply_compaction',
  'context.undo',
  'goal.create',
  'goal.update',
  'goal.clear',
  'llm.tools_snapshot',
  'llm.request',
  'mcp.tools_discovered',
]);

describe('v1 wire vocabulary', () => {
  const SCOPE = 'wire';
  const KEY = 'v1-vocabulary-test';

  let disposables: DisposableStore;
  let wire: WireService;
  let log: IAppendLogStore;

  beforeEach(() => {
    disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IAgentWireService, new SyncDescriptor(WireService, [{ logScope: SCOPE, logKey: KEY }]));
    wire = ix.get(IAgentWireService) as WireService;
    log = ix.get(IAppendLogStore);
  });

  afterEach(() => disposables.dispose());

  async function readRecords(): Promise<PersistedRecord[]> {
    await wire.flush();
    const out: PersistedRecord[] = [];
    for await (const record of log.read<PersistedRecord>(SCOPE, KEY)) {
      out.push(record);
    }
    return out;
  }

  it('every persisted op type is a v1 record type', () => {
    for (const [type, descriptor] of OP_REGISTRY) {
      if (descriptor.persist === false) continue;
      expect(V1_RECORD_TYPES.has(type), `op "${type}" persists a non-v1 record type`).toBe(true);
    }
  });

  it('stamps persisted records with time, except the metadata envelope', async () => {
    wire.dispatch(wireMetadata({ protocol_version: '1.4', created_at: 123 }));
    wire.dispatch(todoSet({ key: 'todo', value: [{ title: 'x', status: 'pending' }] }));

    const records = await readRecords();
    expect(records).toEqual([
      { type: 'metadata', protocol_version: '1.4', created_at: 123 },
      {
        type: 'tools.update_store',
        key: 'todo',
        value: [{ title: 'x', status: 'pending' }],
        time: expect.any(Number),
      },
    ]);
  });

  it('never persists nor emits persist:false ops, but still applies them', async () => {
    const emissions: PersistedRecord[] = [];
    disposables.add(wire.onEmission((e) => emissions.push(e.record)));

    wire.dispatch(
      setRuntimePhase({
        phase: { kind: 'running', turnId: 0, step: 1, stepId: 's-1', since: Date.now() },
      }),
    );

    expect(await readRecords()).toEqual([]);
    expect(emissions).toEqual([]);
  });

  it('round-trips the todo list through the persisted tools.update_store record', async () => {
    wire.dispatch(
      todoSet({ key: 'todo', value: [{ title: 'restore me', status: 'in_progress' }] }),
    );
    const records = await readRecords();

    const store = new DisposableStore();
    disposables.add(store);
    const ix2 = store.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(
      IAgentWireService,
      new SyncDescriptor(WireService, [{ logScope: SCOPE, logKey: 'todo-roundtrip' }]),
    );
    const fresh = ix2.get(IAgentWireService);

    await fresh.replay(...records);

    expect(fresh.getModel(TodoModel)).toEqual([{ title: 'restore me', status: 'in_progress' }]);
  });
});

describe('AgentRecords persistence metadata', () => {
  let context: IAgentContextMemoryService;
  let contextSize: IAgentContextSizeService;
  let ctx: TestAgentContext;
  let expectResumeMatches: boolean;
  let persistence: RecordingInMemoryWireRecordPersistence;

  beforeEach(() => {
    expectResumeMatches = true;
    persistence = new RecordingInMemoryWireRecordPersistence();
    ctx = createTestAgent({ persistence, autoConfigure: false });
    context = ctx.get(IAgentContextMemoryService);
    contextSize = ctx.get(IAgentContextSizeService);
  });

  afterEach(async () => {
    try {
      if (expectResumeMatches) {
        await ctx.expectResumeMatches();
      }
    } finally {
      await ctx.dispose();
    }
  });

  it('rejects replaying a non-empty stream without metadata', async () => {
    persistence.records.push(
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'orphaned prompt' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
    );

    expectResumeMatches = false;
    await expect(ctx.restorePersisted()).rejects.toThrow(
      'WireRecord restore expected metadata as the first record',
    );
  });

  it('restores existing metadata records without rewriting them', async () => {
    persistence.records.push(
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'restored' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      },
    );

    await ctx.restorePersisted();

    expect(persistence.rewrites).toEqual([]);
    expect(persistence.records.filter((record) => record.type === 'metadata')).toHaveLength(1);
  });

  it('rewrites migrated records to the current wire version after replay', async () => {
    persistence.records.push(
      {
        type: 'metadata',
        protocol_version: '1.0',
        created_at: 1,
      },
      {
        type: 'context.append_message',
        message: {
          role: 'assistant',
          content: [],
          toolCalls: [
            {
              type: 'function',
              id: 'call_legacy_bash',
              function: {
                name: 'Bash',
                arguments: '{"command":"pwd"}',
              },
            },
          ],
        },
      } as unknown as PersistedWireRecord,
    );

    await ctx.restorePersisted();

    expect(persistence.rewrites).toHaveLength(1);
    expect(persistence.records[0]).toMatchObject({
      type: 'metadata',
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
    });
    const migrated = persistence.records[1] as unknown as {
      readonly message: {
        readonly toolCalls: readonly Record<string, unknown>[];
      };
    };
    expect(persistence.records[1]?.type).toBe('context.append_message');
    expect(migrated.message.toolCalls[0]).toMatchObject({
      name: 'Bash',
      arguments: '{"command":"pwd"}',
    });
    expect(migrated.message.toolCalls[0]?.['function']).toBeUndefined();
  });

  it('warns but continues when replaying records from a newer wire version', async () => {
    persistence.records.push(
      {
        type: 'metadata',
        protocol_version: '9.9',
        created_at: 1,
      },
    );

    const result = await ctx.restorePersisted();
    expect(result.warning).toContain('9.9');
    expect(result.warning).toContain(AGENT_WIRE_PROTOCOL_VERSION);
  });

  it('rejects replaying records without a registered migration path', async () => {
    persistence.records.push(
      {
        type: 'metadata',
        protocol_version: '0.9',
        created_at: 1,
      },
    );

    expectResumeMatches = false;
    await expect(ctx.restorePersisted()).rejects.toThrow('Missing wire migration for version 0.9');
  });

  it('restores goal.* records during replay', async () => {
    persistence.records.push(
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      {
        type: 'goal.create',
        goalId: 'g1',
        objective: 'do work',
        completionCriterion: 'tests pass',
      },
      { type: 'goal.update', budgetLimits: { turnBudget: 20 } },
      { type: 'goal.update', tokensUsed: 5, wallClockMs: 0 },
      { type: 'goal.update', turnsUsed: 1 },
      { type: 'goal.update', status: 'blocked', reason: 'needs credentials', actor: 'model' },
    );

    await expect(ctx.restorePersisted()).resolves.toEqual({});
    expect(context.get()).toHaveLength(0);
    expect(ctx.get(IAgentGoalService).getGoal().goal).toMatchObject({
      goalId: 'g1',
      objective: 'do work',
      completionCriterion: 'tests pass',
      status: 'blocked',
      turnsUsed: 1,
      tokensUsed: 5,
      terminalReason: 'needs credentials',
    });
  });

  it('restores forked records as fork boundaries that clear copied goals', async () => {
    persistence.records.push(
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      {
        type: 'goal.create',
        goalId: 'source-goal',
        objective: 'source work',
      },
      { type: 'forked', time: 2 },
    );

    await expect(ctx.restorePersisted()).resolves.toEqual({});
    expect(persistence.records.slice(0, 3).map((record) => record.type)).toEqual([
      'metadata',
      'goal.create',
      'forked',
    ]);
    expect(ctx.get(IAgentGoalService).getGoal().goal).toBeNull();
    const reminder = context.get().at(-1);
    expect(reminder?.origin).toEqual({ kind: 'system_trigger', name: 'goal_fork_cleared' });
    expect(JSON.stringify(reminder?.content)).toContain('This fork does not have a current goal.');
  });

  it('keeps goals created after the forked boundary', async () => {
    persistence.records.push(
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      {
        type: 'goal.create',
        goalId: 'source-goal',
        objective: 'source work',
      },
      { type: 'forked', time: 2 },
      {
        type: 'goal.create',
        goalId: 'fork-goal',
        objective: 'fork work',
      },
    );

    await expect(ctx.restorePersisted()).resolves.toEqual({});
    expect(ctx.get(IAgentGoalService).getGoal().goal).toMatchObject({
      goalId: 'fork-goal',
      objective: 'fork work',
    });
    expect(context.get().at(-1)?.origin).toEqual({
      kind: 'system_trigger',
      name: 'goal_fork_cleared',
    });
  });

  it('does not add a fork-cleared reminder when a forked record has no copied goal', async () => {
    persistence.records.push(
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'forked', time: 2 },
    );

    await expect(ctx.restorePersisted()).resolves.toEqual({});
    expect(context.get()).toHaveLength(0);
  });

  it('preconstructs context size restore handlers during runtime activation', async () => {
    await ctx.restore([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'restored prompt' }],
          toolCalls: [],
        },
      },
      {
        type: 'context_size.measured',
        length: 1,
        tokens: 42,
      },
      {
        type: 'usage.record',
        model: 'restored-model',
        usageScope: 'turn',
        usage: {
          inputOther: 40,
          output: 2,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
      },
    ]);

    expect(context.get()).toHaveLength(1);
    expect(contextSize.get()).toEqual({
      size: 42,
      measured: 42,
      estimated: 0,
    });
  });
});

describe('IAgentWireRecordService.records()', () => {
  it('returns restored records in order, excluding metadata', async () => {
    const persistence = new InMemoryWireRecordPersistence([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'context.append_message', message: userMessage('restored') },
    ]);
    const records = createTestAgent({ persistence, autoConfigure: false }).wireRecord;
    await records.restore();

    const snapshot = records.getRecords();
    const types = snapshot
      .map((record) => record.type)
      .filter((type) => type !== 'config.update');
    expect(types).toEqual(['context.append_message']);
    const lengthBefore = records.getRecords().length;
    (snapshot as unknown as PersistedWireRecord[]).pop();
    expect(records.getRecords()).toHaveLength(lengthBefore);
  });

  it('appends live-dispatched records after the restored journal', async () => {
    const persistence = new InMemoryWireRecordPersistence([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'context.append_message', message: userMessage('restored') },
    ]);
    const ctx = createTestAgent({ persistence, autoConfigure: false });
    await ctx.wireRecord.restore();
    const restoredLength = ctx.wireRecord.getRecords().length;

    ctx.get(IAgentWireService).dispatch(contextAppendMessage({ message: userMessage('live') }));

    const after = ctx.wireRecord.getRecords();
    expect(after).toHaveLength(restoredLength + 1);
    const last = after[after.length - 1] as { type: string; message?: ContextMessage };
    expect(last.type).toBe('context.append_message');
    expect(last.message?.content[0]).toEqual({ type: 'text', text: 'live' });
  });
});

describe.skip('agent replay range build', () => {
});

class RecordingInMemoryWireRecordPersistence extends InMemoryWireRecordPersistence {
  readonly rewrites: PersistedWireRecord[][] = [];

  override rewrite(records: readonly PersistedWireRecord[]): void {
    this.rewrites.push([...records]);
    super.rewrite(records);
  }
}


function userMessage(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}

function compactionSummaryMessage(text: string): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'compaction_summary' },
  };
}
