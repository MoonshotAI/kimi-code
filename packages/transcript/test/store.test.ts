import { describe, expect, it } from 'vitest';

import { AgentTranscript } from '#/store/agentTranscript';
import { TranscriptStore } from '#/store/transcriptStore';
import { appendAtOffset } from '#/ops/apply';
import type {
  FrameUpsertOp,
  TurnUpsertOp,
  TranscriptOperation,
} from '#/ops/operation';
import type { ThinkingFrame, ToolCallFrame } from '#/model/frame';
import type { TranscriptInteraction } from '#/model/interaction';
import type { TranscriptItem } from '#/model/item';

/** Display id for order assertions across the item union. */
function itemLabel(item: TranscriptItem): string {
  if (item.kind === 'turn') return item.turnId;
  if (item.kind === 'marker') return item.markerId;
  return item.refId;
}

const turn1: TurnUpsertOp = {
  op: 'turn.upsert',
  turn: { kind: 'turn', turnId: 't1', ordinal: 1, state: 'running', origin: { kind: 'user' }, prompt: 'hi' },
};

const doneThinking: FrameUpsertOp = {
  op: 'frame.upsert',
  turnId: 't1',
  stepId: 't1.1',
  frame: { kind: 'thinking', frameId: 't1.1.f1', text: 'ponder' } satisfies ThinkingFrame,
};

function toolFrame(state: ToolCallFrame['state'], output?: unknown): TranscriptOperation[] {
  return [
    turn1,
    {
      op: 'step.upsert',
      turnId: 't1',
      step: { kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'running' },
    },
    {
      op: 'frame.upsert',
      turnId: 't1',
      stepId: 't1.1',
      frame: {
        kind: 'tool',
        frameId: 't1.1.call_1',
        toolCallId: 'call_1',
        name: 'Read',
        state,
        input: { path: '/a' },
        output,
      } satisfies ToolCallFrame,
    },
  ];
}

describe('AgentTranscript', () => {
  it('applies turn/step/frame and keeps a self-consistent snapshot', () => {
    const tx = new AgentTranscript('main');
    tx.apply(toolFrame('running'));

    const items = tx.getItems();
    expect(items).toHaveLength(1);
    const turn = items[0];
    expect(turn?.kind).toBe('turn');
    if (turn?.kind !== 'turn') return;
    expect(turn.steps).toHaveLength(1);
    expect(turn.steps[0]?.frames.map((f) => f.kind)).toEqual(['tool']);
  });

  it('auto-vivifies missing parents so any op order stays self-consistent', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      {
        op: 'frame.upsert',
        turnId: 't9',
        stepId: 't9.2',
        frame: { kind: 'thinking', frameId: 't9.2.f1', text: 'x' },
      },
    ]);
    const turn = tx.getTurn('t9');
    expect(turn?.ordinal).toBe(9);
    expect(turn?.steps[0]?.stepId).toBe('t9.2');
  });

  it('upserts are idempotent under duplication in causal order', () => {
    const ops: TranscriptOperation[] = [
      turn1,
      {
        op: 'step.upsert',
        turnId: 't1',
        step: { kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'running' },
      },
      doneThinking,
      {
        op: 'step.upsert',
        turnId: 't1',
        step: { kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'completed' },
      },
      { op: 'turn.upsert', turn: { ...turn1.turn, state: 'completed' } },
    ];
    const a = new AgentTranscript('main');
    a.apply(ops);
    const b = new AgentTranscript('main');
    b.apply([...ops, ...ops]);
    b.apply(ops);
    expect(b.getItems()).toEqual(a.getItems());
  });

  it('appends text chunks by offset; gaps stay un-applied and signalled', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      turn1,
      {
        op: 'frame.upsert',
        turnId: 't1',
        stepId: 't1.1',
        frame: { kind: 'text', frameId: 't1.1.f1', role: 'assistant', text: '' },
      },
    ]);
    const gap = tx.apply([
      { op: 'append', target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.f1' }, offset: 5, text: 'late' },
    ]);
    expect(gap.gap).toEqual({
      target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.f1' },
      expected: 0,
      got: 5,
    });

    const ok = tx.apply([
      { op: 'append', target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.f1' }, offset: 0, text: 'hello ' },
      { op: 'append', target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.f1' }, offset: 6, text: 'world' },
    ]);
    expect(ok.gap).toBeUndefined();
    const turn = tx.getTurn('t1');
    const frame = turn?.steps[0]?.frames[0];
    expect(frame?.kind === 'text' && frame.text).toBe('hello world');

    // duplicate delivery is absorbed
    const dup = tx.apply([
      { op: 'append', target: { type: 'frame', turnId: 't1', stepId: 't1.1', frameId: 't1.1.f1' }, offset: 6, text: 'world' },
    ]);
    expect(dup.accepted).toHaveLength(0);
  });

  it('appendAtOffset matches web alignDelta semantics', () => {
    expect(appendAtOffset('abc', 3, 'd')).toEqual({ text: 'abcd', changed: true });
    expect(appendAtOffset('abc', 1, 'bc').changed).toBe(false);
    expect(appendAtOffset('abc', 1, 'bcd')).toEqual({ text: 'abcd', changed: true });
    expect(appendAtOffset('abc', 5, 'x').gap).toEqual({ expected: 3, got: 5 });
  });

  it('appendAtOffset treats a mismatched overlap as a gap, never a rewrite', () => {
    // The chunk is behind local state but is not the local suffix: rewriting
    // from the offset would silently drop local content ('llo').
    const result = appendAtOffset('hello', 2, ' world');
    expect(result.text).toBe('hello');
    expect(result.gap).toEqual({ expected: 5, got: 2 });
    // A matching overlap still trims to the novel suffix.
    expect(appendAtOffset('hello wo', 6, 'world')).toEqual({ text: 'hello world', changed: true });
  });

  it('tracks pending interactions as a derived index (entity channel)', () => {
    const tx = new AgentTranscript('main');
    const interaction = (state: TranscriptInteraction['state']): TranscriptInteraction => ({
      interactionId: 'appr-1',
      interactionKind: 'approval',
      toolCallId: 'call-1',
      state,
    });
    tx.apply([turn1, { op: 'interaction.upsert', interaction: interaction('pending') }]);
    expect(tx.listPendingInteractions()).toEqual(['appr-1']);
    tx.apply([{ op: 'interaction.upsert', interaction: interaction('approved') }]);
    expect(tx.listPendingInteractions()).toEqual([]);

    // An entity without an anchor tool call tracks pending the same way.
    const unanchored = (state: TranscriptInteraction['state']): TranscriptInteraction => ({
      interactionId: 'appr-2',
      interactionKind: 'question',
      state,
    });
    tx.apply([{ op: 'interaction.upsert', interaction: unanchored('pending') }]);
    expect(tx.listPendingInteractions()).toEqual(['appr-2']);
    tx.apply([{ op: 'interaction.upsert', interaction: unanchored('answered') }]);
    expect(tx.listPendingInteractions()).toEqual([]);
  });

  it('upserts attachment and todo entities idempotently', () => {
    const tx = new AgentTranscript('main');
    const attachment = {
      attachmentId: 'att_1',
      mediaType: 'image/png',
      source: { kind: 'url' as const, url: 'https://example.com/a.png' },
    };
    const todo = { todoId: 'todo', items: [{ title: 'x', status: 'pending' as const }] };
    const first = tx.apply([
      { op: 'attachment.upsert', attachment },
      { op: 'todo.upsert', todo },
    ]);
    expect(first.accepted).toHaveLength(2);
    // Re-applying the identical entities is a no-op (idempotent upsert).
    const second = tx.apply([
      { op: 'attachment.upsert', attachment },
      { op: 'todo.upsert', todo },
    ]);
    expect(second.accepted).toHaveLength(0);
    expect(tx.getAttachment('att_1')?.mediaType).toBe('image/png');
    expect(tx.getTodo('todo')?.items).toHaveLength(1);
    tx.apply([{ op: 'todo.upsert', todo: { ...todo, items: [] } }]);
    expect(tx.getTodo('todo')?.items).toHaveLength(0);
  });

  it('upserts prompt queue entities by id, idempotently', () => {
    const tx = new AgentTranscript('main');
    const queued = {
      promptId: 'p1',
      status: 'queued' as const,
      userMessageId: 'u1',
      createdAt: '2026-07-22T00:00:00.000Z',
    };
    expect(tx.apply([{ op: 'prompt.upsert', prompt: queued }]).accepted).toHaveLength(1);
    // Re-applying the identical entity is a no-op (idempotent upsert).
    expect(tx.apply([{ op: 'prompt.upsert', prompt: queued }]).accepted).toHaveLength(0);
    // Same id, new state: whole-entity replace.
    const running = { ...queued, status: 'running' as const, steeredAt: '2026-07-22T00:00:01.000Z' };
    expect(tx.apply([{ op: 'prompt.upsert', prompt: running }]).accepted).toHaveLength(1);
    expect(tx.getPrompt('p1')?.status).toBe('running');
    expect(tx.getPrompt('p1')?.steeredAt).toBe('2026-07-22T00:00:01.000Z');

    // Prompts are global snapshot entities: they survive a snapshot/reset
    // roundtrip (the full-refresh convergence path).
    const snapshot = tx.snapshot();
    expect(snapshot.prompts).toEqual([running]);
    const fresh = new AgentTranscript('main');
    fresh.receive([{ op: 'reset', agentId: 'main', snapshot }]);
    expect(fresh.getPrompt('p1')).toEqual(running);
    expect([...fresh.getPrompts().keys()]).toEqual(['p1']);
  });

  it('step upserts carry usage/timing and the terminal header clears retry', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      turn1,
      {
        op: 'step.upsert',
        turnId: 't1',
        step: {
          kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'running',
          retry: { failedAttempt: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 500, errorName: 'RateLimit', errorMessage: 'slow down' },
        },
      },
    ]);
    expect(tx.getTurn('t1')?.steps[0]?.retry?.errorName).toBe('RateLimit');

    // Same identity fields but new usage/timing: must not be swallowed as a
    // no-op (the equality check covers the extension fields).
    const completed = tx.apply([
      {
        op: 'step.upsert',
        turnId: 't1',
        step: {
          kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'completed',
          usage: { inputOther: 10, output: 5, inputCacheRead: 3, inputCacheCreation: 2 },
          finishReason: 'stop',
          timing: { llmFirstTokenLatencyMs: 120 },
        },
      },
    ]);
    expect(completed.accepted).toHaveLength(1);
    const step = tx.getTurn('t1')?.steps[0];
    expect(step?.usage?.output).toBe(5);
    expect(step?.timing?.llmFirstTokenLatencyMs).toBe(120);
    // step.upsert replaces the whole header: no `retry` key means cleared.
    expect(step?.retry).toBeUndefined();
  });

  it('turn upserts carry durationMs and the terminal error', () => {
    const tx = new AgentTranscript('main');
    tx.apply([turn1]);
    const failed = tx.apply([
      { op: 'turn.upsert', turn: { ...turn1.turn, state: 'failed', durationMs: 1500, error: 'boom' } },
    ]);
    expect(failed.accepted).toHaveLength(1);
    const turn = tx.getTurn('t1');
    expect(turn?.durationMs).toBe(1500);
    expect(turn?.error).toBe('boom');
  });

  it('tool frames keep streamed inputText and the newest progress update', () => {
    const tx = new AgentTranscript('main');
    tx.apply(toolFrame('running'));
    const streamed = (frame: Partial<ToolCallFrame> & Pick<ToolCallFrame, 'inputText' | 'state'>): TranscriptOperation => ({
      op: 'frame.upsert',
      turnId: 't1',
      stepId: 't1.1',
      frame: {
        kind: 'tool', frameId: 't1.1.call_1', toolCallId: 'call_1', name: 'Read',
        ...frame,
      },
    });
    // Delta accumulation: inputText grows while the frame stays running.
    expect(tx.apply([streamed({ inputText: '{"path"', state: 'running' })]).accepted).toHaveLength(1);
    tx.apply([streamed({ inputText: '{"path":"/a"}', state: 'running' })]);
    // `tool.call.started` lands with the parsed input but keeps the raw text.
    tx.apply([
      streamed({ inputText: '{"path":"/a"}', state: 'running', input: { path: '/a' } }),
      streamed({
        inputText: '{"path":"/a"}',
        state: 'running',
        input: { path: '/a' },
        progress: { kind: 'progress', percent: 50 },
      }),
    ]);
    const frame = tx.getTurn('t1')?.steps[0]?.frames.find((f) => f.kind === 'tool');
    expect(frame?.kind === 'tool' && frame.input).toEqual({ path: '/a' });
    expect(frame?.kind === 'tool' && frame.inputText).toBe('{"path":"/a"}');
    expect(frame?.kind === 'tool' && frame.progress).toEqual({ kind: 'progress', percent: 50 });
  });

  it('task upserts carry resultSummary/error/stateReason/usage', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      { op: 'task.upsert', task: { taskId: 'task1', kind: 'subagent', state: 'running', detached: false, outputTail: '' } },
    ]);
    const done = tx.apply([
      {
        op: 'task.upsert',
        task: {
          taskId: 'task1', kind: 'subagent', state: 'completed', detached: false, outputTail: '',
          resultSummary: 'scanned 12 files',
          usage: { inputOther: 100, output: 40, inputCacheRead: 10, inputCacheCreation: 5 },
        },
      },
    ]);
    expect(done.accepted).toHaveLength(1);
    const task = tx.getTask('task1');
    expect(task?.resultSummary).toBe('scanned 12 files');
    expect(task?.usage?.inputOther).toBe(100);
  });

  it('items.remove clears anchored interactions and their pending entries', () => {
    // The interaction entity anchored to a tool call inside a removed turn
    // dies with its anchor.
    const tx = new AgentTranscript('main');
    tx.apply([
      turn1,
      {
        op: 'frame.upsert',
        turnId: 't1',
        stepId: 't1.1',
        frame: {
          kind: 'tool',
          frameId: 't1.1.call-9',
          toolCallId: 'call-9',
          name: 'Bash',
          state: 'running',
        },
      },
      {
        op: 'interaction.upsert',
        interaction: {
          interactionId: 'appr-9',
          interactionKind: 'approval',
          toolCallId: 'call-9',
          state: 'pending',
        },
      },
    ]);
    expect(tx.listPendingInteractions()).toEqual(['appr-9']);
    tx.apply([{ op: 'items.remove', ids: ['t1'] }]);
    expect(tx.getItems()).toHaveLength(0);
    expect(tx.getInteraction('appr-9')).toBeUndefined();
    expect(tx.listPendingInteractions()).toEqual([]);
  });

  it('receive() equals full reset seed; snapshot windowing keeps newest turns', () => {
    const tx = new AgentTranscript('main');
    for (let n = 1; n <= 5; n += 1) {
      tx.apply([
        { op: 'marker.upsert', item: { kind: 'marker', markerId: `m${n}`, marker: 'goal' } },
        {
          op: 'turn.upsert',
          turn: { kind: 'turn', turnId: `t${n}`, ordinal: n, state: 'completed', origin: { kind: 'user' } },
        },
      ]);
    }
    const snapshot = tx.snapshot({ tailTurns: 2 });
    expect(snapshot.hasMoreOlder).toBe(true);
    expect(snapshot.items.filter((i) => i.kind === 'turn').map((i) => i.kind === 'turn' && i.turnId)).toEqual(['t4', 't5']);
    // markers between kept turns survive; the one before t4's segment does not…
    expect(snapshot.items.filter((i) => i.kind === 'marker').length).toBeGreaterThan(0);

    const fresh = new AgentTranscript('main');
    fresh.receive([{ op: 'reset', agentId: 'main', snapshot }]);
    expect(fresh.getItems()).toEqual(snapshot.items);
    expect(fresh.hasMoreOlder).toBe(true);
  });

  it('onChange emits accepted ops once per apply batch', () => {
    const tx = new AgentTranscript('main');
    const seen: string[] = [];
    tx.onChange((event) => {
      seen.push(...event.ops.map((op) => op.op));
    });
    tx.apply([turn1, turn1]); // second upsert is a no-op
    expect(seen).toEqual(['turn.upsert']);
  });

  it('task upsert + append keeps output tail globally, detached flips freely', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      { op: 'task.upsert', task: { taskId: 'task1', kind: 'shell', state: 'running', detached: false, outputTail: '' } },
      { op: 'append', target: { type: 'task', taskId: 'task1' }, offset: 0, text: 'line1\n' },
      { op: 'task.upsert', task: { taskId: 'task1', kind: 'shell', state: 'running', detached: true, outputTail: 'line1\n' } },
    ]);
    const task = tx.getTask('task1');
    expect(task?.detached).toBe(true);
    expect(task?.outputTail).toBe('line1\n');
  });

  it('meta.merge merges goal/modes shallowly', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      { op: 'meta.merge', meta: { goal: { objective: 'ship it', status: 'active' } } },
      { op: 'meta.merge', meta: { modes: { plan: { reviewPath: '/p' } } } },
    ]);
    expect(tx.getMeta().goal?.status).toBe('active');
    expect(tx.getMeta().modes?.plan?.reviewPath).toBe('/p');
  });

  it('meta.merge clears a mode badge on null and keeps absent keys', () => {
    const tx = new AgentTranscript('main');
    tx.apply([{ op: 'meta.merge', meta: { modes: { plan: {}, swarm: {} } } }]);
    tx.apply([{ op: 'meta.merge', meta: { modes: { plan: null } } }]);
    expect(tx.getMeta().modes).toEqual({ swarm: {} });
    // Clearing the last badge normalizes `modes` away entirely.
    tx.apply([{ op: 'meta.merge', meta: { modes: { swarm: null } } }]);
    expect(tx.getMeta().modes).toBeUndefined();
  });

  it('meta.merge shallow-merges the agent status key one level deep', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      { op: 'meta.merge', meta: { agent: { model: 'k2', permission: 'auto' } } },
      // Status slices arrive piecemeal: a later op carries only the fields
      // that changed, and the earlier fields must survive.
      { op: 'meta.merge', meta: { agent: { contextTokens: 1234 } } },
    ]);
    expect(tx.getMeta().agent).toEqual({ model: 'k2', permission: 'auto', contextTokens: 1234 });

    // Same-named fields are overwritten by the newer slice.
    tx.apply([
      { op: 'meta.merge', meta: { agent: { model: 'k3', phase: { kind: 'idle' } } } },
    ]);
    expect(tx.getMeta().agent).toEqual({
      model: 'k3',
      permission: 'auto',
      contextTokens: 1234,
      phase: { kind: 'idle' },
    });

    // An op without the agent key leaves it untouched.
    tx.apply([{ op: 'meta.merge', meta: { activity: 'turn' } }]);
    expect(tx.getMeta().agent?.model).toBe('k3');
    expect(tx.getMeta().activity).toBe('turn');
  });

  it('snapshot immutability: later applies do not mutate earlier reads', () => {
    const tx = new AgentTranscript('main');
    tx.apply(toolFrame('running'));
    const before = tx.getItems();
    tx.apply(toolFrame('done', 'content'));
    const beforeFrame = before[0]?.kind === 'turn' ? before[0].steps[0]?.frames[0] : undefined;
    expect(beforeFrame?.kind === 'tool' && beforeFrame.state).toBe('running');
  });

  it('places anchored standalone items before their following turn, not at the end', () => {
    const tx = new AgentTranscript('main');
    // A live turn lands first — the engine kept running while the backfill
    // was still reading history from disk.
    tx.apply([
      {
        op: 'turn.upsert',
        turn: { kind: 'turn', turnId: 't2', ordinal: 2, state: 'running', origin: { kind: 'user' } },
      },
    ]);
    // Backfill replays history: t0, a marker between t0/t1, t1, and a
    // taskref that trailed t1 (anchored past it, before the live t2).
    tx.apply([
      {
        op: 'turn.upsert',
        turn: { kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' } },
      },
      {
        op: 'marker.upsert',
        item: { kind: 'marker', markerId: 'm1', marker: 'skill' },
        beforeTurn: 1,
      },
      {
        op: 'turn.upsert',
        turn: { kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' } },
      },
      {
        op: 'taskref.upsert',
        item: { kind: 'taskref', refId: 'r1', taskId: 'bash-1' },
        beforeTurn: 2,
      },
    ]);
    expect(tx.getItems().map(itemLabel)).toEqual(['t0', 'm1', 't1', 'r1', 't2']);
  });

  it('anchors a standalone item before the very first turn; re-applies stay in place', () => {
    const tx = new AgentTranscript('main');
    tx.apply([
      {
        op: 'turn.upsert',
        turn: { kind: 'turn', turnId: 't0', ordinal: 0, state: 'completed', origin: { kind: 'user' } },
      },
      {
        op: 'marker.upsert',
        item: { kind: 'marker', markerId: 'm0', marker: 'compaction' },
        beforeTurn: 0,
      },
    ]);
    expect(tx.getItems()[0]?.kind).toBe('marker');
    // Re-applying an existing id replaces in place — no move, no duplicate.
    tx.apply([
      {
        op: 'marker.upsert',
        item: { kind: 'marker', markerId: 'm0', marker: 'compaction', payload: { v: 1 } },
        beforeTurn: 0,
      },
    ]);
    const items = tx.getItems();
    expect(items).toHaveLength(2);
    expect(items[0]?.kind).toBe('marker');
  });

  it('appends standalone items without an anchor at the end (live order)', () => {
    const tx = new AgentTranscript('main');
    tx.apply([turn1, { op: 'marker.upsert', item: { kind: 'marker', markerId: 'm9', marker: 'notice' } }]);
    const items = tx.getItems();
    expect(items.at(-1)?.kind).toBe('marker');
  });

  it('re-applies tool frames when metadata-only fields change', () => {
    const tx = new AgentTranscript('main');
    tx.apply(toolFrame('running'));
    // Same state/output but a corrected input (e.g. a live/backfill
    // reconciliation): the upsert must not be dropped as a no-op.
    const corrected: TranscriptOperation[] = [
      turn1,
      {
        op: 'step.upsert',
        turnId: 't1',
        step: { kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'running' },
      },
      {
        op: 'frame.upsert',
        turnId: 't1',
        stepId: 't1.1',
        frame: {
          kind: 'tool',
          frameId: 't1.1.call_1',
          toolCallId: 'call_1',
          name: 'Read',
          state: 'running',
          input: { path: '/b' },
        } satisfies ToolCallFrame,
      },
    ];
    tx.apply(corrected);
    const turn = tx.getTurn('t1');
    const frame = turn?.steps[0]?.frames.find((f) => f.kind === 'tool');
    expect(frame?.kind === 'tool' && frame.input).toEqual({ path: '/b' });
  });
});

describe('TranscriptStore', () => {
  it('lazily creates agent transcripts and tracks the roster', () => {
    const store = new TranscriptStore('s1');
    expect(store.getAgent('main')).toBeUndefined();
    const tx = store.ensureAgent('main', { agentId: 'main', type: 'main' });
    expect(store.getAgent('main')).toBe(tx);
    const rosters: number[] = [];
    store.onRosterChange((agents) => rosters.push(agents.length));
    store.ensureAgent('sub-1', { agentId: 'sub-1', type: 'sub', parentAgentId: 'main' });
    store.removeAgent('sub-1');
    expect(rosters).toEqual([2, 1]);
    expect(store.agents().map((a) => a.agentId)).toEqual(['main']);
  });

  it('markDisposed stamps disposedAt on the existing descriptor only', () => {
    const store = new TranscriptStore('s1');
    store.ensureAgent('main', { agentId: 'main', type: 'main' });

    // Never-announced agents must not gain a roster entry.
    store.markDisposed('ghost', '2026-07-20T00:00:00.000Z');
    expect(store.agents().map((a) => a.agentId)).toEqual(['main']);

    const rosters: Array<readonly string[]> = [];
    store.onRosterChange((agents) => rosters.push(agents.map((a) => a.agentId)));
    store.markDisposed('main', '2026-07-20T01:00:00.000Z');
    expect(rosters).toEqual([['main']]);
    expect(store.agents()[0]).toMatchObject({
      agentId: 'main',
      type: 'main',
      disposedAt: '2026-07-20T01:00:00.000Z',
    });

    // Idempotent: the first stamp wins and no roster re-emit fires.
    store.markDisposed('main', '2026-07-20T02:00:00.000Z');
    expect(store.agents()[0]?.disposedAt).toBe('2026-07-20T01:00:00.000Z');
    expect(rosters).toHaveLength(1);
  });
});
