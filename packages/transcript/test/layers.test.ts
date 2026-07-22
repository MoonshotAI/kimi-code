import { describe, expect, it } from 'vitest';

import { filterOpsForGrade, isAppendOnly, redactSnapshotForGrade } from '#/granularity/filterOps';
import { gradeFor, needsResetOnTransition } from '#/granularity/grade';
import { paginateTurns } from '#/pagination/paginate';
import { ViewRegistry } from '#/view/registry';
import { groupMessagesIntoSnapshot } from '#/history/groupTurns';
import { foldWireRecordFacts, type HistoryWireRecord } from '#/history/foldFacts';
import {
  transcriptOperationSchema,
  transcriptQuerySchema,
  transcriptResponseSchema,
  transcriptGradeSpecSchema,
} from '#/contract/schema';
import type { TranscriptItem } from '#/model/item';
import type { AgentTranscriptSnapshot, TranscriptOperation } from '#/ops/operation';

const idLabel = (i: TranscriptItem): string =>
  i.kind === 'turn' ? i.turnId : i.kind === 'marker' ? i.markerId : i.refId;

const turnOp = (n: number): TranscriptOperation => ({
  op: 'turn.upsert',
  turn: { kind: 'turn', turnId: `t${n}`, ordinal: n, state: 'running', origin: { kind: 'user' } },
});

const stepOp: TranscriptOperation = {
  op: 'step.upsert',
  turnId: 't1',
  step: { kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'running' },
};

const frameOp: TranscriptOperation = {
  op: 'frame.upsert',
  turnId: 't1',
  stepId: 't1.1',
  frame: { kind: 'text', frameId: 't1.1.f1', role: 'assistant', text: 'full' },
};

const appendOp: TranscriptOperation = {
  op: 'append',
  target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.f1' },
  offset: 0,
  text: 'chunk',
};

const promptOp: TranscriptOperation = {
  op: 'prompt.upsert',
  prompt: { promptId: 'p1', status: 'queued', createdAt: '2026-07-22T00:00:00.000Z' },
};

describe('granularity', () => {
  const ops: TranscriptOperation[] = [
    turnOp(1),
    stepOp,
    frameOp,
    appendOp,
    promptOp,
    { op: 'meta.merge', meta: { activity: 'turn' } },
  ];

  it('off admits nothing', () => {
    expect(filterOpsForGrade('off', ops)).toEqual([]);
  });

  it('turn admits headers and global state only', () => {
    // prompt.upsert is a global entity like interaction.upsert: coarse
    // subscribers see queue state too.
    expect(filterOpsForGrade('turn', ops).map((op) => op.op)).toEqual([
      'turn.upsert',
      'prompt.upsert',
      'meta.merge',
    ]);
  });

  it('block admits step/frame upserts but no appends', () => {
    expect(filterOpsForGrade('block', ops).map((op) => op.op)).toEqual([
      'turn.upsert',
      'step.upsert',
      'frame.upsert',
      'prompt.upsert',
      'meta.merge',
    ]);
  });

  it('delta admits everything', () => {
    expect(filterOpsForGrade('delta', ops)).toHaveLength(ops.length);
  });

  it('gradeFor resolves agent override over wildcard default', () => {
    const spec = { '*': 'turn', main: 'delta' } as const;
    expect(gradeFor(spec, 'main')).toBe('delta');
    expect(gradeFor(spec, 'sub-1')).toBe('turn');
    expect(gradeFor(undefined, 'main')).toBe('off');
  });

  it('upgrade needs reset, downgrade does not', () => {
    expect(needsResetOnTransition('turn', 'delta')).toBe(true);
    expect(needsResetOnTransition('delta', 'turn')).toBe(false);
  });

  it('append-only batches are volatile-safe', () => {
    expect(isAppendOnly([appendOp])).toBe(true);
    expect(isAppendOnly([appendOp, frameOp])).toBe(false);
  });

  it('redactSnapshotForGrade strips step detail below block, keeps it at block+', () => {
    const snapshot: AgentTranscriptSnapshot = {
      items: [
        {
          kind: 'turn',
          turnId: 't1',
          ordinal: 1,
          state: 'completed',
          origin: { kind: 'user' },
          prompt: 'hi',
          steps: [
            {
              kind: 'step',
              stepId: 't1.1',
              turnId: 't1',
              ordinal: 1,
              state: 'completed',
              frames: [{ kind: 'text', frameId: 't1.1.f1', role: 'assistant', text: 'body' }],
            },
          ],
        },
        { kind: 'marker', markerId: 'm1', marker: 'skill' },
      ],
      tasks: [],
      interactions: [
        {
          interactionId: 'appr-1',
          interactionKind: 'approval' as const,
          toolCallId: 'c1',
          state: 'pending' as const,
        },
      ],
      attachments: [
        { attachmentId: 'att_1', mediaType: 'image/png', source: { kind: 'url' as const, url: 'https://example.com/a.png' } },
      ],
      todos: [{ todoId: 'todo', items: [{ title: 'write tests', status: 'in_progress' as const }] }],
      prompts: [{ promptId: 'p1', status: 'running' as const, createdAt: '2026-07-22T00:00:00.000Z' }],
      meta: {},
    };
    const turnGrade = redactSnapshotForGrade('turn', snapshot);
    // Global entities flow at 'turn' grade untouched.
    expect(turnGrade.interactions).toHaveLength(1);
    expect(turnGrade.attachments).toHaveLength(1);
    expect(turnGrade.todos).toHaveLength(1);
    expect(turnGrade.prompts).toHaveLength(1);
    const turn = turnGrade.items[0];
    expect(turn?.kind === 'turn' && turn.steps).toEqual([]);
    expect(turn?.kind === 'turn' && turn.prompt).toBe('hi');
    expect(turnGrade.items[1]?.kind).toBe('marker');
    expect(redactSnapshotForGrade('block', snapshot)).toBe(snapshot);
    expect(redactSnapshotForGrade('delta', snapshot)).toBe(snapshot);
  });
});

describe('paginateTurns', () => {
  const items: TranscriptItem[] = [
    { kind: 'marker', markerId: 'm0', marker: 'goal' },
    ...[1, 2, 3, 4, 5].flatMap((n): TranscriptItem[] => [
      {
        kind: 'turn',
        turnId: `t${n}`,
        ordinal: n,
        state: 'completed',
        origin: { kind: 'user' },
        steps: [],
      },
      { kind: 'marker', markerId: `m${n}`, marker: 'skill' },
    ]),
  ];

  it('default page is the newest N turns with trailing segment items', () => {
    const page = paginateTurns(items, { pageSize: 2 });
    expect(page.items.map(idLabel)).toEqual(['t4', 'm4', 't5', 'm5']);
    expect(page.hasMore).toBe(true);
  });

  it('before_turn pages toward older turns; head marker rides the oldest segment', () => {
    const page = paginateTurns(items, { beforeTurn: 't4', pageSize: 2 });
    expect(page.items.map(idLabel)).toEqual(['t2', 'm2', 't3', 'm3']);
    expect(page.hasMore).toBe(true);

    const oldest = paginateTurns(items, { beforeTurn: 't2', pageSize: 5 });
    expect(oldest.items[0]).toEqual({ kind: 'marker', markerId: 'm0', marker: 'goal' });
    expect(oldest.hasMore).toBe(false);
  });

  it('after_turn pages toward newer turns without the head unit', () => {
    const page = paginateTurns(items, { afterTurn: 't3', pageSize: 2 });
    expect(page.items.map(idLabel)).toEqual(['t4', 'm4', 't5', 'm5']);
    expect(page.hasMore).toBe(false);
  });

  it('keeps head non-turn items with the newest page when turns exactly fill it', () => {
    // Head unit + exactly pageSize turns: the unit is not a turn slot — the
    // newest page carries it and reports nothing older (a segment-counted
    // page would drop it and hallucinate an older marker-only page).
    const page = paginateTurns(items, { pageSize: 5 });
    expect(page.items[0]).toEqual({ kind: 'marker', markerId: 'm0', marker: 'goal' });
    expect(page.items.map(idLabel)).toEqual(['m0', 't1', 'm1', 't2', 'm2', 't3', 'm3', 't4', 'm4', 't5', 'm5']);
    expect(page.hasMore).toBe(false);
  });

  it('returns a marker-only timeline as one page with nothing older', () => {
    const only = paginateTurns([{ kind: 'marker', markerId: 'm0', marker: 'goal' }], { pageSize: 3 });
    expect(only.items.map(idLabel)).toEqual(['m0']);
    expect(only.hasMore).toBe(false);
  });
});

describe('ViewRegistry', () => {
  it('dispatches on view ?? name, origin.kind and marker keys', () => {
    const registry = new ViewRegistry<string>({ fallbackTool: 'generic' });
    registry.registerTool('read', 'readRenderer');
    registry.registerTool('swarm', 'swarmRenderer');
    registry.registerInput('cron', 'cronInput');
    registry.registerMarker('goal', 'goalMarker');

    expect(
      registry.resolveTool({ kind: 'tool', frameId: 'f', toolCallId: 'c1', name: 'Read', state: 'done' }),
    ).toBe('readRenderer');
    expect(
      registry.resolveTool({ kind: 'tool', frameId: 'f', toolCallId: 'c2', name: 'AgentSwarm', view: 'swarm', state: 'running' }),
    ).toBe('swarmRenderer');
    expect(
      registry.resolveTool({ kind: 'tool', frameId: 'f', toolCallId: 'c3', name: 'Bash', state: 'running' }),
    ).toBe('generic');
    expect(registry.resolveInput({ kind: 'cron' })).toBe('cronInput');
    expect(registry.resolveInput({ kind: 'user' })).toBeUndefined();
    expect(registry.resolveMarker('goal')).toBe('goalMarker');
  });
});

describe('contract schemas', () => {
  it('roundtrips every op kind', () => {
    const ops: TranscriptOperation[] = [
      { op: 'reset', agentId: 'main', snapshot: { items: [], tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {}, hasMoreOlder: true } },
      turnOp(1),
      stepOp,
      frameOp,
      appendOp,
      { op: 'marker.upsert', item: { kind: 'marker', markerId: 'm1', marker: 'goal' } },
      { op: 'taskref.upsert', item: { kind: 'taskref', refId: 'r1', taskId: 'task1' } },
      { op: 'task.upsert', task: { taskId: 'task1', kind: 'shell', state: 'running', detached: false, outputTail: '' } },
      {
        op: 'interaction.upsert',
        interaction: { interactionId: 'appr-1', interactionKind: 'approval', toolCallId: 'c1', state: 'pending' },
      },
      {
        op: 'attachment.upsert',
        attachment: { attachmentId: 'att_1', mediaType: 'image/png', source: { kind: 'file', fileId: 'f1' } },
      },
      { op: 'todo.upsert', todo: { todoId: 'todo', items: [{ title: 'x', status: 'done' }] } },
      promptOp,
      { op: 'meta.merge', meta: { goal: { objective: 'x', status: 'active' } } },
      { op: 'items.remove', ids: ['t1'] },
    ];
    for (const op of ops) {
      expect(transcriptOperationSchema.parse(op)).toBeDefined();
    }
  });

  it('roundtrips ops carrying the extended wire detail', () => {
    // Every field the projection fills beyond the original model: step
    // usage/finishReason/timing/retry/endReason/endMessage, turn
    // durationMs/error, tool inputText/progress, task
    // resultSummary/error/stateReason/usage, meta.agent, snapshot prompts.
    const usage = { inputOther: 10, output: 5, inputCacheRead: 3, inputCacheCreation: 2 };
    const ops: TranscriptOperation[] = [
      {
        op: 'reset',
        agentId: 'main',
        snapshot: {
          items: [],
          tasks: [],
          interactions: [],
          attachments: [],
          todos: [],
          prompts: [
            {
              promptId: 'p1',
              status: 'completed',
              userMessageId: 'u1',
              content: [{ type: 'text', text: 'hi' }],
              createdAt: '2026-07-22T00:00:00.000Z',
              finishedAt: '2026-07-22T00:01:00.000Z',
              steeredAt: '2026-07-22T00:00:30.000Z',
            },
          ],
          meta: {
            agent: {
              model: 'k2',
              thinkingEffort: 'high',
              usage: { byModel: { k2: usage }, currentTurn: usage, total: usage },
              contextTokens: 1234,
              maxContextTokens: 128000,
              contextUsage: 0.01,
              permission: 'auto',
              phase: { kind: 'retrying', turnId: 1, step: 1, stepId: 't1.1', failedAttempt: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 500, since: 1000 },
            },
          },
        },
      },
      {
        op: 'turn.upsert',
        turn: {
          kind: 'turn', turnId: 't1', ordinal: 1, state: 'failed', origin: { kind: 'user' },
          usage: { inputTokens: 12, outputTokens: 5, cachedTokens: 3 },
          durationMs: 1500,
          error: 'boom',
        },
      },
      {
        op: 'step.upsert',
        turnId: 't1',
        step: {
          kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'interrupted',
          usage,
          finishReason: 'stop',
          timing: {
            llmFirstTokenLatencyMs: 120,
            llmStreamDurationMs: 900,
            llmRequestBuildMs: 5,
            llmServerFirstTokenMs: 110,
            llmServerDecodeMs: 700,
            llmClientConsumeMs: 950,
          },
          retry: { failedAttempt: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 500, errorName: 'RateLimit', errorMessage: 'slow down', statusCode: 429 },
          endReason: 'aborted',
          endMessage: 'user pressed escape',
        },
      },
      {
        op: 'frame.upsert',
        turnId: 't1',
        stepId: 't1.1',
        frame: {
          kind: 'tool', frameId: 't1.1.c1', toolCallId: 'c1', name: 'Bash', state: 'running',
          inputText: '{"command":"ls',
          progress: { kind: 'progress', text: 'half', percent: 50, customKind: 'bar', customData: { x: 1 } },
        },
      },
      {
        op: 'task.upsert',
        task: {
          taskId: 'task1', kind: 'subagent', state: 'completed', detached: false, outputTail: '',
          resultSummary: 'scanned 12 files',
          error: 'partial failure',
          stateReason: 'waiting for input',
          usage,
        },
      },
      {
        op: 'meta.merge',
        meta: { agent: { model: 'k2', phase: { kind: 'ended', turnId: 1, reason: 'completed', durationMs: 1500, at: 2000 } } },
      },
    ];
    for (const op of ops) {
      expect(transcriptOperationSchema.parse(op)).toEqual(op);
    }
  });

  it('rejects mutually exclusive cursors and bad grades', () => {
    expect(() => transcriptGradeSpecSchema.parse({ '*': 'stream' })).toThrow();
    const ok = transcriptResponseSchema.safeParse({
      agent_id: 'main',
      items: [],
      has_more: false,
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      meta: {},
      agents: [{ agentId: 'main', type: 'main' }],
      pending_interactions: [],
    });
    expect(ok.success).toBe(true);
  });

  it('rejects path-hostile agent ids in the transcript query', () => {
    const base = { agent_id: 'main', before_turn: undefined, after_turn: undefined, page_size: undefined };
    expect(transcriptQuerySchema.safeParse({ ...base, agent_id: 'sub-1' }).success).toBe(true);
    expect(transcriptQuerySchema.safeParse({ ...base, agent_id: '01HF7YAT31J7SMRT1QXGJWKR8D' }).success).toBe(true);
    for (const hostile of ['../main', '..\\main', '..', 'a/b', 'a\\b', '.', 'a\0b', 'x'.repeat(200)]) {
      expect(transcriptQuerySchema.safeParse({ ...base, agent_id: hostile }).success).toBe(false);
    }
  });
});

describe('groupMessagesIntoSnapshot (cold path)', () => {
  it('groups flat messages into turns with folded tool results', () => {
    const snapshot = groupMessagesIntoSnapshot([
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [], origin: { kind: 'user' } },
      {
        role: 'assistant',
        content: [{ type: 'think', think: 'hmm' }, { type: 'text', text: 'checking' }],
        toolCalls: [{ id: 'c1', name: 'Read', arguments: '{"path":"/a"}' }],
      },
      { role: 'tool', content: [{ type: 'text', text: 'file body' }], toolCallId: 'c1', toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        toolCalls: [],
      },
      { role: 'user', content: [{ type: 'text', text: 'next' }], toolCalls: [], origin: { kind: 'user' } },
      {
        role: 'user',
        content: [{ type: 'text', text: 'summary of old' }],
        toolCalls: [],
        origin: { kind: 'compaction_summary' },
      },
      { role: 'user', content: [{ type: 'text', text: 'after' }], toolCalls: [], origin: { kind: 'user' } },
    ]);

    const kinds = snapshot.items.map((i) => i.kind);
    expect(kinds).toEqual(['turn', 'turn', 'marker', 'turn']);
    const firstTurn = snapshot.items[0];
    if (firstTurn?.kind !== 'turn') throw new Error('expected turn');
    expect(firstTurn.prompt).toBe('hello');
    expect(firstTurn.steps).toHaveLength(2);
    const tool = firstTurn.steps[0]?.frames.find((f) => f.kind === 'tool');
    expect(tool?.kind === 'tool' && tool.output).toBe('file body');
    expect(tool?.kind === 'tool' && tool.input).toEqual({ path: '/a' });
    const marker = snapshot.items[2];
    expect(marker?.kind === 'marker' && marker.marker).toBe('compaction');
  });

  it('maps media parts on the opening user message to attachment entities, dropping base64 bytes', () => {
    const snapshot = groupMessagesIntoSnapshot([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this? [Image #1]' },
          { type: 'image', source: { kind: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
          { type: 'image', source: { kind: 'url', url: 'https://example.com/pic.png' } },
          { type: 'file', file_id: 'file_9', name: 'notes.txt', media_type: 'text/plain', size: 128 },
        ],
        toolCalls: [],
        origin: { kind: 'user' },
      },
      { role: 'assistant', content: [{ type: 'text', text: 'a screenshot' }], toolCalls: [] },
    ]);

    expect(snapshot.attachments).toHaveLength(3);
    expect(snapshot.attachments[0]).toMatchObject({
      attachmentId: 'att_1',
      mediaType: 'image/png',
      source: undefined, // base64 bytes never ship
    });
    expect(snapshot.attachments[1]).toMatchObject({
      attachmentId: 'att_2',
      source: { kind: 'url', url: 'https://example.com/pic.png' },
    });
    expect(snapshot.attachments[2]).toMatchObject({
      attachmentId: 'att_3',
      mediaType: 'text/plain',
      name: 'notes.txt',
      source: { kind: 'file', fileId: 'file_9' },
    });
    const firstTurn = snapshot.items[0];
    if (firstTurn?.kind !== 'turn') throw new Error('expected turn');
    expect(firstTurn.attachmentIds).toEqual(['att_1', 'att_2', 'att_3']);
  });

  it('keeps cold tool calls running until a result is persisted', () => {
    const pending = groupMessagesIntoSnapshot([
      { role: 'user', content: [{ type: 'text', text: 'run it' }], toolCalls: [], origin: { kind: 'user' } },
      { role: 'assistant', content: [], toolCalls: [{ id: 'c1', name: 'Bash', arguments: '{}' }] },
    ]);
    const pendingTurn = pending.items[0];
    if (pendingTurn?.kind !== 'turn') throw new Error('expected turn');
    const pendingTool = pendingTurn.steps[0]?.frames.find((f) => f.kind === 'tool');
    // No tool message yet: in-flight / approval-gated, not done.
    expect(pendingTool?.kind === 'tool' && pendingTool.state).toBe('running');

    const done = groupMessagesIntoSnapshot([
      { role: 'user', content: [{ type: 'text', text: 'run it' }], toolCalls: [], origin: { kind: 'user' } },
      { role: 'assistant', content: [], toolCalls: [{ id: 'c1', name: 'Bash', arguments: '{}' }] },
      { role: 'tool', content: [{ type: 'text', text: 'done.txt' }], toolCallId: 'c1', toolCalls: [] },
    ]);
    const doneTurn = done.items[0];
    if (doneTurn?.kind !== 'turn') throw new Error('expected turn');
    const doneTool = doneTurn.steps[0]?.frames.find((f) => f.kind === 'tool');
    expect(doneTool?.kind === 'tool' && doneTool.state).toBe('done');
    expect(doneTool?.kind === 'tool' && doneTool.output).toBe('done.txt');
  });

  it('opens a turn for subagent run prompts recorded as system triggers', () => {
    const snapshot = groupMessagesIntoSnapshot([
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [], origin: { kind: 'user' } },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }], toolCalls: [] },
      {
        role: 'user',
        content: [{ type: 'text', text: 'scan the repo' }],
        toolCalls: [],
        origin: { kind: 'system_trigger', name: 'subagent' } as { kind: string },
      },
      { role: 'assistant', content: [{ type: 'text', text: 'scanning' }], toolCalls: [] },
    ]);

    // A subagent's run prompt launches its own engine turn — the response
    // must not fold into the previous turn. The run prompt itself is internal
    // steering text: the boundary lands promptless.
    expect(snapshot.items.map((item) => item.kind)).toEqual(['turn', 'turn']);
    const subTurn = snapshot.items[1];
    if (subTurn?.kind !== 'turn') throw new Error('expected turn');
    expect(subTurn.ordinal).toBe(1);
    expect(subTurn.origin.kind).toBe('other');
    expect(subTurn.prompt).toBeUndefined();
    expect(subTurn.steps).toHaveLength(1);
  });

  it('starts a new turn for user-slash skill activations, keeps other triggers as markers only', () => {
    const snapshot = groupMessagesIntoSnapshot([
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [], origin: { kind: 'user' } },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }], toolCalls: [] },
      {
        role: 'user',
        content: [{ type: 'text', text: 'skill body' }],
        toolCalls: [],
        origin: { kind: 'skill_activation', trigger: 'user-slash', skillName: 'gen-docs' } as {
          kind: string;
        },
      },
      { role: 'assistant', content: [{ type: 'text', text: 'docs done' }], toolCalls: [] },
      {
        role: 'user',
        content: [{ type: 'text', text: 'nested skill body' }],
        toolCalls: [],
        origin: { kind: 'skill_activation', trigger: 'model-tool', skillName: 'x' } as {
          kind: string;
        },
      },
      { role: 'assistant', content: [{ type: 'text', text: 'still same turn' }], toolCalls: [] },
    ]);

    // A user-slash activation is a real prompt (engine `isRealUserPrompt`):
    // marker AND its own turn — the response must not fold into the previous
    // turn. A model-tool activation is mid-turn context: marker only.
    expect(snapshot.items.map((item) => item.kind)).toEqual(['turn', 'marker', 'turn', 'marker']);
    const slashTurn = snapshot.items[2];
    if (slashTurn?.kind !== 'turn') throw new Error('expected turn');
    expect(slashTurn.ordinal).toBe(1);
    expect(slashTurn.origin.kind).toBe('other');
    expect(slashTurn.prompt).toBe('skill body');
    expect(slashTurn.steps).toHaveLength(2);
  });

  it('starts a promptless turn for turn-opening system triggers (goal continuation)', () => {
    const snapshot = groupMessagesIntoSnapshot([
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [], origin: { kind: 'user' } },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }], toolCalls: [] },
      {
        role: 'user',
        content: [{ type: 'text', text: 'continue the goal' }],
        toolCalls: [],
        origin: { kind: 'system_trigger', name: 'goal_continuation' } as { kind: string },
      },
      { role: 'assistant', content: [{ type: 'text', text: 'continued' }], toolCalls: [] },
      {
        role: 'user',
        content: [{ type: 'text', text: 'mode reminder' }],
        toolCalls: [],
        origin: { kind: 'injection', variant: 'permission_mode' } as { kind: string },
      },
      { role: 'assistant', content: [{ type: 'text', text: 'still same turn' }], toolCalls: [] },
    ]);

    // The continuation opened a real engine turn: the grouping must advance
    // (0-based ordinals stay aligned with the engine) instead of folding the
    // continuation output into the visible user turn. A mid-turn injection
    // still folds away without splitting the turn.
    expect(snapshot.items.map((item) => item.kind)).toEqual(['turn', 'turn']);
    const [first, second] = snapshot.items;
    if (first?.kind !== 'turn' || second?.kind !== 'turn') throw new Error('expected turns');
    expect(first.ordinal).toBe(0);
    expect(first.steps.map((step) => step.frames.map((frame) => frame.kind))).toEqual([['text']]);
    expect(second.ordinal).toBe(1);
    expect(second.origin.kind).toBe('other');
    expect(second.prompt).toBeUndefined();
    expect(second.steps).toHaveLength(2);
  });

  it('hides injected user messages and maps cron origins', () => {
    const snapshot = groupMessagesIntoSnapshot([
      {
        role: 'user',
        content: [{ type: 'text', text: 'secret context' }],
        toolCalls: [],
        origin: { kind: 'injection' },
      },
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [], origin: { kind: 'user' } },
      {
        role: 'user',
        content: [{ type: 'text', text: 'run report' }],
        toolCalls: [],
        origin: { kind: 'cron_job', jobId: 'job1' } as { kind: string },
      },
    ]);
    expect(snapshot.items).toHaveLength(2);
    const cronTurn = snapshot.items[1];
    expect(cronTurn?.kind === 'turn' && cronTurn.origin.kind).toBe('cron');
  });

  it('maps legacy background_task origins to task turns, preserving the taskId', () => {
    const snapshot = groupMessagesIntoSnapshot([
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [], origin: { kind: 'user' } },
      {
        role: 'user',
        content: [{ type: 'text', text: 'task done' }],
        toolCalls: [],
        origin: { kind: 'background_task', taskId: 'b83rhswvs' } as { kind: string },
      },
    ]);
    const taskTurn = snapshot.items[1];
    if (taskTurn?.kind !== 'turn') throw new Error('expected turn');
    expect(taskTurn.origin).toMatchObject({ kind: 'task', taskId: 'b83rhswvs' });
  });
});

describe('foldWireRecordFacts (cold facts)', () => {
  const baseWithMarker = (): AgentTranscriptSnapshot =>
    groupMessagesIntoSnapshot([
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [], origin: { kind: 'user' } },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }], toolCalls: [] },
      {
        role: 'user',
        content: [{ type: 'text', text: 'summary of old' }],
        toolCalls: [],
        origin: { kind: 'compaction_summary' },
      },
    ]);

  it('returns the base snapshot unchanged when no fact records exist (old sessions)', () => {
    const base = baseWithMarker();
    const folded = foldWireRecordFacts(
      [
        { type: 'metadata', protocol_version: '1.5', created_at: 1 },
        { type: 'context.append_message', message: { role: 'user' }, time: 1 },
      ],
      base,
    );
    expect(folded).toEqual(base);
    // Nothing appended: the base items array is reused as-is.
    expect(folded.items).toBe(base.items);
  });

  it('folds todo records into the global todo document, last write wins', () => {
    const base = baseWithMarker();
    const folded = foldWireRecordFacts(
      [
        { type: 'tools.update_store', key: 'todo', value: [{ title: 'old', status: 'pending' }], time: 1000 },
        { type: 'tools.update_store', key: 'other', value: [{ title: 'ignored', status: 'done' }], time: 2000 },
        {
          type: 'tools.update_store',
          key: 'todo',
          value: [
            { title: 'write tests', status: 'in_progress' },
            { title: 'ship', status: 'pending' },
            { title: 'malformed' },
          ],
          time: 3000,
        },
      ],
      base,
    );
    expect(folded.todos).toEqual([
      {
        todoId: 'todo',
        items: [
          { title: 'write tests', status: 'in_progress' },
          { title: 'ship', status: 'pending' },
        ],
        updatedAt: new Date(3000).toISOString(),
      },
    ]);
    // Facts append no items for todos.
    expect(folded.items).toBe(base.items);
  });

  it('folds goal create/update/clear into meta.goal with markers, last write wins', () => {
    const base = baseWithMarker();
    // The base carries one compaction marker (`m1`) — folded markers must
    // continue the numbering instead of colliding.
    expect(base.items.some((item) => item.kind === 'marker' && item.markerId === 'm1')).toBe(true);

    const folded = foldWireRecordFacts(
      [
        {
          type: 'goal.create',
          goalId: 'g1',
          objective: 'fix the bug',
          completionCriterion: 'tests pass',
          time: 1000,
        },
        { type: 'goal.update', status: 'blocked', reason: 'stuck', tokensUsed: 1200, time: 2000 },
        { type: 'goal.update', budgetLimits: { tokenBudget: 50000 }, time: 3000 },
      ],
      base,
    );
    expect(folded.meta.goal).toEqual({
      objective: 'fix the bug',
      status: 'blocked',
      completionCriterion: 'tests pass',
      budgetUsed: 1200,
      budgetLimit: 50000,
    });
    const goalMarkers = folded.items.filter(
      (item) => item.kind === 'marker' && item.marker === 'goal',
    );
    expect(goalMarkers.map((item) => item.kind === 'marker' && item.markerId)).toEqual([
      'm2',
      'm3',
      'm4',
    ]);
    expect(goalMarkers[0]).toMatchObject({ at: new Date(1000).toISOString() });
    // Markers append after the base items, in record order.
    expect(folded.items.slice(0, base.items.length)).toEqual(base.items);

    const cleared = foldWireRecordFacts(
      [
        { type: 'goal.create', goalId: 'g1', objective: 'fix the bug', time: 1000 },
        { type: 'goal.clear', time: 2000 },
      ],
      base,
    );
    expect(cleared.meta.goal).toBeUndefined();
  });

  it('folds plan/swarm mode records into meta.modes with enter/exit markers', () => {
    const base = baseWithMarker();
    const folded = foldWireRecordFacts(
      [
        { type: 'plan_mode.enter', id: 'plan-1', time: 1000 },
        { type: 'swarm_mode.enter', trigger: { kind: 'task' }, time: 2000 },
        { type: 'plan_mode.exit', id: 'plan-1', time: 3000 },
      ],
      base,
    );
    // Plan exited, swarm still active; cold badges are the bare `{}` the live
    // path projects (no persisted review path / trigger detail).
    expect(folded.meta.modes).toEqual({ swarm: {} });
    const markers = folded.items
      .filter((item) => item.kind === 'marker')
      .map((item) => item.kind === 'marker' && item.marker);
    expect(markers).toEqual(['compaction', 'plan.enter', 'swarm.enter', 'plan.exit']);

    const cancelled = foldWireRecordFacts(
      [
        { type: 'plan_mode.enter', id: 'plan-1', time: 1000 },
        { type: 'plan_mode.cancel', time: 2000 },
        { type: 'swarm_mode.enter', trigger: { kind: 'tool' }, time: 3000 },
        { type: 'swarm_mode.exit', time: 4000 },
      ],
      base,
    );
    expect(cancelled.meta.modes).toEqual({});

    const stillPlanning = foldWireRecordFacts(
      [{ type: 'plan_mode.enter', id: 'plan-1', time: 1000 }],
      base,
    );
    expect(stillPlanning.meta.modes).toEqual({ plan: {} });
  });

  it('folds plan.revision records into the plan badge and a timeline marker', () => {
    const base = baseWithMarker();
    const revision = {
      type: 'plan.revision',
      id: 'plan-1',
      version: 2,
      path: 'agents/main/plan/plan-1/v2.md',
      sha256: 'deadbeef',
      bytes: 512,
      time: 2000,
    };
    const folded = foldWireRecordFacts(
      [{ type: 'plan_mode.enter', id: 'plan-1', time: 1000 }, revision],
      base,
    );
    // Still active: the badge carries the revision reference.
    expect(folded.meta.modes).toEqual({
      plan: { reviewPath: 'agents/main/plan/plan-1/v2.md', version: 2 },
    });
    const revisionMarkers = folded.items.filter(
      (item) => item.kind === 'marker' && item.marker === 'plan.revision',
    );
    expect(revisionMarkers).toEqual([
      {
        kind: 'marker',
        markerId: 'm3',
        marker: 'plan.revision',
        payload: {
          id: 'plan-1',
          version: 2,
          path: 'agents/main/plan/plan-1/v2.md',
          sha256: 'deadbeef',
          bytes: 512,
        },
        at: new Date(2000).toISOString(),
      },
    ]);

    // Exit clears the badge; the revision marker stays in the timeline.
    const exited = foldWireRecordFacts(
      [
        { type: 'plan_mode.enter', id: 'plan-1', time: 1000 },
        revision,
        { type: 'plan_mode.exit', id: 'plan-1', time: 3000 },
      ],
      base,
    );
    expect(exited.meta.modes?.plan).toBeUndefined();
    expect(
      exited.items.filter((item) => item.kind === 'marker' && item.marker === 'plan.revision'),
    ).toHaveLength(1);

    // A re-enter after the exit starts a bare badge again (no stale revision).
    const reentered = foldWireRecordFacts(
      [
        { type: 'plan_mode.enter', id: 'plan-1', time: 1000 },
        revision,
        { type: 'plan_mode.exit', id: 'plan-1', time: 3000 },
        { type: 'plan_mode.enter', id: 'plan-2', time: 4000 },
      ],
      base,
    );
    expect(reentered.meta.modes).toEqual({ plan: {} });
  });

  it('folds task records into task entities and timeline taskrefs', () => {
    const base = baseWithMarker();
    const folded = foldWireRecordFacts(
      [
        {
          type: 'task.started',
          info: {
            taskId: 'task_1',
            kind: 'process',
            description: 'pnpm test',
            status: 'running',
            startedAt: 1000,
            endedAt: null,
          },
          time: 1000,
        },
        {
          type: 'task.started',
          info: {
            taskId: 'task_2',
            kind: 'agent',
            description: 'scan the repo',
            status: 'running',
            detached: false,
            agentId: 'sub-1',
            startedAt: 2000,
            endedAt: null,
          },
          time: 2000,
        },
        {
          type: 'task.terminated',
          info: {
            taskId: 'task_1',
            kind: 'process',
            description: 'pnpm test',
            status: 'completed',
            startedAt: 1000,
            endedAt: 5000,
          },
          outputTail: '42 passed',
          time: 5000,
        },
      ],
      base,
    );

    expect(folded.tasks).toEqual([
      {
        taskId: 'task_1',
        kind: 'shell',
        state: 'completed',
        // Legacy records omit `detached` — treated as detached.
        detached: true,
        description: 'pnpm test',
        agentId: undefined,
        outputTail: '42 passed',
        startedAt: new Date(1000).toISOString(),
        endedAt: new Date(5000).toISOString(),
      },
      {
        taskId: 'task_2',
        kind: 'subagent',
        // Never terminated: still running, no end.
        state: 'running',
        detached: false,
        description: 'scan the repo',
        agentId: 'sub-1',
        outputTail: '',
        startedAt: new Date(2000).toISOString(),
        endedAt: undefined,
      },
    ]);
    // One taskref per started task, appended after the base items in record order.
    const refs = folded.items.filter((item) => item.kind === 'taskref');
    expect(refs).toEqual([
      { kind: 'taskref', refId: 'ref-task_1', taskId: 'task_1', at: new Date(1000).toISOString() },
      { kind: 'taskref', refId: 'ref-task_2', taskId: 'task_2', at: new Date(2000).toISOString() },
    ]);
  });

  it('maps unknown task kinds to other and survives malformed task records', () => {
    const base = baseWithMarker();
    const folded = foldWireRecordFacts(
      [
        {
          type: 'task.started',
          info: { taskId: 'task_q', kind: 'question', status: 'running', startedAt: 1000, endedAt: null },
          time: 1000,
        },
        { type: 'task.started', time: 2000 },
        { type: 'task.terminated', info: { kind: 'process' }, time: 3000 },
      ],
      base,
    );
    expect(folded.tasks).toHaveLength(1);
    expect(folded.tasks[0]).toMatchObject({ taskId: 'task_q', kind: 'other', state: 'running' });
  });

  it('folds interaction request/resolved into entities with terminal states', () => {
    const base = baseWithMarker();
    const folded = foldWireRecordFacts(
      [
        {
          type: 'interaction.request',
          id: 'apr-1',
          kind: 'approval',
          toolCallId: 'call_1',
          request: { toolName: 'Bash' },
          time: 1000,
        },
        {
          type: 'interaction.request',
          id: 'q-1',
          kind: 'question',
          request: { questions: [] },
          time: 2000,
        },
        {
          type: 'interaction.resolved',
          id: 'apr-1',
          response: { decision: 'approved', scope: 'session' },
          time: 3000,
        },
        { type: 'interaction.resolved', id: 'q-1', response: null, time: 4000 },
      ],
      base,
    );
    expect(folded.interactions).toEqual([
      {
        interactionId: 'apr-1',
        interactionKind: 'approval',
        toolCallId: 'call_1',
        state: 'approved',
        request: { toolName: 'Bash' },
        response: { decision: 'approved', scope: 'session' },
      },
      {
        interactionId: 'q-1',
        interactionKind: 'question',
        toolCallId: undefined,
        state: 'dismissed',
        request: { questions: [] },
        response: null,
      },
    ]);
  });

  it('cancels interactions still pending at the end of the scan (crash == cancelled)', () => {
    const base = baseWithMarker();
    const folded = foldWireRecordFacts(
      [
        {
          type: 'interaction.request',
          id: 'apr-9',
          kind: 'approval',
          request: { toolCallId: 'call_9', toolName: 'Write' },
          time: 1000,
        },
      ],
      base,
    );
    expect(folded.interactions).toHaveLength(1);
    expect(folded.interactions[0]).toMatchObject({
      interactionId: 'apr-9',
      state: 'cancelled',
      // The anchor is read from the request payload when the record carries
      // no top-level toolCallId (mirrors the live path).
      toolCallId: 'call_9',
    });
    // No ghost pendings, ever.
    expect(folded.interactions.every((entity) => entity.state !== 'pending')).toBe(true);
  });

  it('skips user_tool interactions like the live path', () => {
    const base = baseWithMarker();
    const folded = foldWireRecordFacts(
      [
        { type: 'interaction.request', id: 'ut-1', kind: 'user_tool', request: {}, time: 1000 },
        { type: 'interaction.resolved', id: 'ut-1', response: {}, time: 2000 },
      ] satisfies HistoryWireRecord[],
      base,
    );
    expect(folded.interactions).toEqual([]);
  });
});
