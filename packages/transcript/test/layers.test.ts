import { describe, expect, it } from 'vitest';

import { filterOpsForGrade, isAppendOnly, redactSnapshotForGrade } from '#/granularity/filterOps';
import { gradeFor, needsResetOnTransition } from '#/granularity/grade';
import { paginateTurns } from '#/pagination/paginate';
import { ViewRegistry } from '#/view/registry';
import { groupMessagesIntoSnapshot } from '#/history/groupTurns';
import {
  transcriptOperationSchema,
  transcriptQuerySchema,
  transcriptResponseSchema,
  transcriptGradeSpecSchema,
} from '#/wire/schema';
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

describe('granularity', () => {
  const ops: TranscriptOperation[] = [
    turnOp(1),
    stepOp,
    frameOp,
    appendOp,
    { op: 'meta.merge', meta: { activity: 'turn' } },
  ];

  it('off admits nothing', () => {
    expect(filterOpsForGrade('off', ops)).toEqual([]);
  });

  it('turn admits headers and global state only', () => {
    expect(filterOpsForGrade('turn', ops).map((op) => op.op)).toEqual(['turn.upsert', 'meta.merge']);
  });

  it('block admits step/frame upserts but no appends', () => {
    expect(filterOpsForGrade('block', ops).map((op) => op.op)).toEqual([
      'turn.upsert',
      'step.upsert',
      'frame.upsert',
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
      meta: {},
    };
    const turnGrade = redactSnapshotForGrade('turn', snapshot);
    // Global entities flow at 'turn' grade untouched.
    expect(turnGrade.interactions).toHaveLength(1);
    expect(turnGrade.attachments).toHaveLength(1);
    expect(turnGrade.todos).toHaveLength(1);
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

describe('wire schemas', () => {
  it('roundtrips every op kind', () => {
    const ops: TranscriptOperation[] = [
      { op: 'reset', agentId: 'main', snapshot: { items: [], tasks: [], interactions: [], attachments: [], todos: [], meta: {}, hasMoreOlder: true } },
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
      { op: 'meta.merge', meta: { goal: { objective: 'x', status: 'active' } } },
      { op: 'items.remove', ids: ['t1'] },
    ];
    for (const op of ops) {
      expect(transcriptOperationSchema.parse(op)).toBeDefined();
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
