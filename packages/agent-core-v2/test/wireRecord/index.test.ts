import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_WIRE_PROTOCOL_VERSION,
  IContextMemory,
  IContextSizeService,
  IFullCompaction,
  IReplayBuilderService,
  IWireRecord,
  type ContextMessage,
  type PersistedWireRecord,
} from '#/index';
import type { ReplayRangeOptions } from '#/replayBuilder';
import {
  InMemoryWireRecordPersistence,
  createTestAgent,
  replayServices,
  wireRecordPersistenceServices,
  type TestAgentContext,
} from '../harness';

describe('AgentRecords persistence metadata', () => {
  let context: IContextMemory;
  let contextSize: IContextSizeService;
  let ctx: TestAgentContext;
  let persistence: RecordingInMemoryWireRecordPersistence;
  let records: IWireRecord;
  let replay: IReplayBuilderService;

  beforeEach(() => {
    persistence = new RecordingInMemoryWireRecordPersistence();
    ctx = createTestAgent(wireRecordPersistenceServices(persistence));
    context = ctx.get(IContextMemory);
    contextSize = ctx.get(IContextSizeService);
    records = ctx.get(IWireRecord);
    replay = ctx.get(IReplayBuilderService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('writes metadata before the first persisted record', async () => {
    records.append({
      type: 'turn.launch',
      turnId: 0,
      origin: { kind: 'user' },
    });
    await records.flush();

    expect(persistence.records).toHaveLength(2);
    expect(persistence.records[0]).toMatchObject({
      type: 'metadata',
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
    });
    expect(persistence.records[0]).not.toHaveProperty('app_version');
    expect(persistence.records[0]).not.toHaveProperty('resumed');
    expect(persistence.records[1]?.type).toBe('turn.launch');
  });

  it('does not write metadata when replaying an empty stream', async () => {
    await records.restore();
    records.append({
      type: 'turn.launch',
      turnId: 0,
      origin: { kind: 'user' },
    });
    await records.flush();

    expect(persistence.records.map((record) => record.type)).toEqual([
      'metadata',
      'turn.launch',
    ]);
  });

  it('rejects replaying a non-empty stream without metadata', async () => {
    persistence.records.push(
      {
        type: 'turn.launch',
        turnId: 0,
        origin: { kind: 'user' },
      },
    );

    await expect(records.restore()).rejects.toThrow(
      'WireRecord restore expected metadata as the first record',
    );
  });

  it('does not duplicate metadata after replaying existing records', async () => {
    persistence.records.push(
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: 'turn.launch',
        turnId: 0,
        origin: { kind: 'user' },
      },
    );

    await records.restore();
    records.append({
      type: 'turn.launch',
      turnId: 1,
      origin: { kind: 'user' },
    });
    await records.flush();

    expect(persistence.records.map((record) => record.type)).toEqual([
      'metadata',
      'turn.launch',
      'turn.launch',
    ]);
    expect(persistence.records.filter((record) => record.type === 'metadata')).toHaveLength(1);
  });

  it('does not rewrite records that already use the current wire version', async () => {
    persistence.records.push(
      {
        type: 'metadata',
        protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
        created_at: 1,
      },
      {
        type: 'turn.launch',
        turnId: 0,
        origin: { kind: 'user' },
      },
    );

    await records.restore();

    expect(persistence.rewrites).toEqual([]);
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

    await records.restore();

    expect(persistence.rewrites).toHaveLength(1);
    expect(persistence.records[0]).toMatchObject({
      type: 'metadata',
      protocol_version: AGENT_WIRE_PROTOCOL_VERSION,
    });
    const migrated = persistence.records[1] as unknown as {
      readonly messages: readonly [
        {
          readonly toolCalls: readonly Record<string, unknown>[];
        },
      ];
    };
    expect(persistence.records[1]?.type).toBe('context.splice');
    expect(migrated.messages[0].toolCalls[0]).toMatchObject({
      name: 'Bash',
      arguments: '{"command":"pwd"}',
    });
    expect(migrated.messages[0].toolCalls[0]?.['function']).toBeUndefined();
  });

  it('warns but continues when replaying records from a newer wire version', async () => {
    persistence.records.push(
      {
        type: 'metadata',
        protocol_version: '9.9',
        created_at: 1,
      },
    );

    const result = await records.restore();
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

    await expect(records.restore()).rejects.toThrow('Missing wire migration for version 0.9');
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

    await expect(ctx.runtime.restore()).resolves.toEqual({});
    expect(context.get()).toHaveLength(0);
    expect(replay.buildResult()).toEqual([
      expect.objectContaining({
        type: 'goal_updated',
        snapshot: expect.objectContaining({ goalId: 'g1', status: 'active' }),
        change: { kind: 'created' },
      }),
      expect.objectContaining({
        type: 'goal_updated',
        snapshot: expect.objectContaining({
          goalId: 'g1',
          status: 'blocked',
          terminalReason: 'needs credentials',
        }),
        change: {
          kind: 'lifecycle',
          status: 'blocked',
          reason: 'needs credentials',
          actor: 'model',
        },
      }),
    ]);
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

    await expect(ctx.runtime.restore()).resolves.toEqual({});
    expect(persistence.records.map((record) => record.type)).toEqual([
      'metadata',
      'goal.create',
      'forked',
    ]);
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

    await expect(ctx.runtime.restore()).resolves.toEqual({});
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

    await expect(ctx.runtime.restore()).resolves.toEqual({});
    expect(context.get()).toHaveLength(0);
  });

  it('preconstructs context size restore handlers during runtime activation', async () => {
    await records.restore([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      {
        type: 'context.splice',
        start: 0,
        deleteCount: 0,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'restored prompt' }],
            toolCalls: [],
          },
        ],
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
    expect(contextSize.getStatus()).toEqual({
      contextTokens: 42,
      contextTokensWithPending: 42,
    });
  });
});

describe('agent replay range build', () => {
  it('returns the complete replay when no range is requested', async () => {
    const firstMessage = userMessage('first');
    const afterClearMessage = userMessage('after-clear');
    const records: PersistedWireRecord[] = [
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'context.splice', start: 0, deleteCount: 0, messages: [firstMessage] },
      { type: 'context.splice', start: 0, deleteCount: 1, messages: [] },
      { type: 'context.splice', start: 0, deleteCount: 0, messages: [afterClearMessage] },
    ];

    await expect(buildReplay(records)).resolves.toEqual([
      expect.objectContaining({ type: 'message', message: firstMessage }),
      expect.objectContaining({ type: 'message', message: afterClearMessage }),
    ]);
  });

  it('applies start and count to replay records instead of wire records', async () => {
    const message = userMessage('hello');
    const persistence = new RecordingInMemoryWireRecordPersistence([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      {
        type: 'usage.record',
        model: 'mock-model',
        usage: { inputOther: 1, inputCacheRead: 0, inputCacheCreation: 0, output: 1 },
      },
      {
        type: 'config.update',
        cwd: process.cwd(),
        thinkingLevel: 'off',
      },
      {
        type: 'usage.record',
        model: 'mock-model',
        usage: { inputOther: 2, inputCacheRead: 0, inputCacheCreation: 0, output: 1 },
      },
      { type: 'permission.set_mode', mode: 'yolo' },
      { type: 'context.splice', start: 0, deleteCount: 0, messages: [message] },
    ]);

    const replay = await buildReplayFromPersistence(persistence, { start: 1, count: 2 });

    expect(replay).toEqual([
      expect.objectContaining({ type: 'permission_updated', mode: 'yolo' }),
      expect.objectContaining({ type: 'message', message }),
    ]);
    expect(persistence.rewrites).toEqual([]);
  });

  it('returns the last count replay records when start is omitted', async () => {
    const firstMessage = userMessage('first');
    const secondMessage = userMessage('second');
    const thirdMessage = userMessage('third');
    const records: PersistedWireRecord[] = [
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'context.splice', start: 0, deleteCount: 0, messages: [firstMessage] },
      { type: 'permission.set_mode', mode: 'auto' },
      { type: 'context.splice', start: 1, deleteCount: 0, messages: [secondMessage] },
      { type: 'context.splice', start: 2, deleteCount: 0, messages: [thirdMessage] },
    ];

    await expect(buildReplay(records, { count: 2 })).resolves.toEqual([
      expect.objectContaining({ type: 'message', message: secondMessage }),
      expect.objectContaining({ type: 'message', message: thirdMessage }),
    ]);
    await expect(buildReplay(records, { count: 10 })).resolves.toEqual([
      expect.objectContaining({ type: 'message', message: firstMessage }),
      expect.objectContaining({ type: 'permission_updated', mode: 'auto' }),
      expect.objectContaining({ type: 'message', message: secondMessage }),
      expect.objectContaining({ type: 'message', message: thirdMessage }),
    ]);
  });

  it('continues reading all segments before returning the last count replay records', async () => {
    const beforeClearMessages = Array.from({ length: 50 }, (_item, index) =>
      userMessage(`before-clear-${String(index)}`),
    );
    const afterClearMessages = Array.from({ length: 50 }, (_item, index) =>
      userMessage(`after-clear-${String(index)}`),
    );
    const records: PersistedWireRecord[] = [
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      ...beforeClearMessages.map((message, index) => ({
        type: 'context.splice' as const,
        start: index,
        deleteCount: 0,
        messages: [message],
      })),
      { type: 'context.splice', start: 0, deleteCount: 50, messages: [] },
      ...afterClearMessages.map((message, index) => ({
        type: 'context.splice' as const,
        start: index,
        deleteCount: 0,
        messages: [message],
      })),
    ];

    const replay = await buildReplay(records, { count: 10 });

    expect(replay).toHaveLength(10);
    expect(replay).toEqual(
      afterClearMessages.slice(-10).map((message) =>
        expect.objectContaining({ type: 'message', message }),
      ),
    );
  });

  it('continues reading after count so canonical compaction splices can patch captured replay cards', async () => {
    const records: PersistedWireRecord[] = [
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'full_compaction.begin', source: 'manual', instruction: 'keep facts' },
      {
        type: 'context.splice',
        start: 0,
        deleteCount: 0,
        messages: [compactionSummaryMessage('Compacted summary.')],
      },
      { type: 'permission.set_mode', mode: 'auto' },
    ];

    await expect(buildReplay(records, { start: 0, count: 1 })).resolves.toEqual([
      expect.objectContaining({
        type: 'compaction',
        instruction: 'keep facts',
        result: {
          summary: 'Compacted summary.',
          compactedCount: 0,
          tokensBefore: expect.any(Number),
          tokensAfter: expect.any(Number),
        },
      }),
    ]);
  });

  it('projects canonical compaction summary splices as replay cards', async () => {
    const before = userMessage('before compaction');
    const replay = await buildReplay([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'context.splice', start: 0, deleteCount: 0, messages: [before] },
      { type: 'full_compaction.begin', source: 'manual', instruction: 'keep facts' },
      {
        type: 'context.splice',
        start: 0,
        deleteCount: 1,
        messages: [compactionSummaryMessage('Compacted summary.')],
      },
    ]);

    expect(replay).toEqual([
      expect.objectContaining({ type: 'message', message: before }),
      expect.objectContaining({
        type: 'compaction',
        instruction: 'keep facts',
        result: {
          summary: 'Compacted summary.',
          compactedCount: 1,
          tokensBefore: expect.any(Number),
          tokensAfter: expect.any(Number),
        },
      }),
    ]);
  });

  it('projects restored cancelled compactions as replay cards', async () => {
    await expect(buildReplay([
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'full_compaction.begin', source: 'manual', instruction: 'keep facts' },
      { type: 'full_compaction.cancel' },
    ])).resolves.toEqual([
      expect.objectContaining({
        type: 'compaction',
        instruction: 'keep facts',
        result: 'cancelled',
      }),
    ]);
  });

  it('does not rewrite migrated wire records while projecting', async () => {
    const persistence = new RecordingInMemoryWireRecordPersistence([
      { type: 'metadata', protocol_version: '1.0', created_at: 1 },
      { type: 'permission.set_mode', mode: 'auto' },
    ]);

    await expect(buildReplayFromPersistence(persistence, { start: 0, count: 1 })).resolves.toEqual([
      expect.objectContaining({ type: 'permission_updated', mode: 'auto' }),
    ]);
    expect(persistence.rewrites).toEqual([]);
  });

  it('keeps the start offset correct when undo removes more messages than count', async () => {
    const firstMessage = userMessage('first');
    const removedBeforeStart = userMessage('removed-before-start');
    const removedAtStart = userMessage('removed-at-start');
    const removedAfterStart = userMessage('removed-after-start');
    const nextMessage = userMessage('next');
    const expectedMessage = userMessage('expected');
    const records: PersistedWireRecord[] = [
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'context.splice', start: 0, deleteCount: 0, messages: [firstMessage] },
      { type: 'context.splice', start: 1, deleteCount: 0, messages: [removedBeforeStart] },
      { type: 'context.splice', start: 2, deleteCount: 0, messages: [removedAtStart] },
      { type: 'context.splice', start: 3, deleteCount: 0, messages: [removedAfterStart] },
      { type: 'context.splice', start: 1, deleteCount: 3, messages: [] },
      { type: 'context.splice', start: 1, deleteCount: 0, messages: [nextMessage] },
      { type: 'context.splice', start: 2, deleteCount: 0, messages: [expectedMessage] },
    ];

    await expect(buildReplay(records, { start: 2, count: 1 })).resolves.toEqual([
      expect.objectContaining({ type: 'message', message: expectedMessage }),
    ]);
  });

  it('clamps results at undo boundaries', async () => {
    const firstMessage = userMessage('first');
    const secondMessage = userMessage('second');
    const afterClearMessage = userMessage('after-clear');
    const records: PersistedWireRecord[] = [
      { type: 'metadata', protocol_version: AGENT_WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'context.splice', start: 0, deleteCount: 0, messages: [firstMessage] },
      { type: 'context.splice', start: 1, deleteCount: 0, messages: [secondMessage] },
      { type: 'context.splice', start: 0, deleteCount: 2, messages: [] },
      { type: 'context.splice', start: 0, deleteCount: 0, messages: [afterClearMessage] },
    ];

    await expect(buildReplay(records, { start: 0, count: 10 })).resolves.toEqual([
      expect.objectContaining({ type: 'message', message: firstMessage }),
      expect.objectContaining({ type: 'message', message: secondMessage }),
    ]);
    await expect(buildReplay(records, { start: 2, count: 10 })).resolves.toEqual([
      expect.objectContaining({ type: 'message', message: afterClearMessage }),
    ]);
  });
});

class RecordingInMemoryWireRecordPersistence extends InMemoryWireRecordPersistence {
  readonly rewrites: PersistedWireRecord[][] = [];

  override rewrite(records: readonly PersistedWireRecord[]): void {
    this.rewrites.push([...records]);
    super.rewrite(records);
  }
}

async function buildReplay(
  records: readonly PersistedWireRecord[],
  range?: ReplayRangeOptions,
) {
  return buildReplayFromPersistence(
    new InMemoryWireRecordPersistence(records),
    range,
  );
}

async function buildReplayFromPersistence(
  persistence: InMemoryWireRecordPersistence,
  range?: ReplayRangeOptions,
) {
  const ctx = createTestAgent(
    wireRecordPersistenceServices(persistence),
    replayServices(range === undefined ? {} : { range }),
  );
  const fullCompaction = ctx.get(IFullCompaction);
  const replay = ctx.get(IReplayBuilderService);
  try {
    const isCompacting = fullCompaction.isCompacting;
    if (isCompacting) throw new Error('Unexpected active compaction before restore');
    await ctx.runtime.restore(undefined, { rewriteMigratedRecords: false });
    return replay.buildResult();
  } finally {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
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
