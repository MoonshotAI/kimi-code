/**
 * `AgentTranscriptProjector` — core event → L2 ops mapping fixtures.
 *
 * Each test feeds event batches through the projector and applies the emitted
 * ops to a real `AgentTranscript`, asserting both the op stream (offsets,
 * flush upserts) and the converged store state.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentLifecycleService,
  IAgentLoopService,
  IEventBus,
  ISessionIndex,
  ISessionInteractionService,
  ISessionLifecycleService,
  ISessionMetadata,
  SessionInteractionService,
  type DomainEvent,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  AgentTranscript,
  TranscriptStore,
  type AgentTranscriptSnapshot,
  type AppendOp,
  type FrameUpsertOp,
  type InteractionUpsertOp,
  type TranscriptFrame,
  type TranscriptOperation,
  type TranscriptTask,
  type TranscriptTurn,
} from '@moonshot-ai/transcript';
import { describe, expect, it } from 'vitest';

import { bindSessionTranscript } from '../../src/services/transcript/coreBinding';
import { AgentTranscriptProjector } from '../../src/services/transcript/coreEventMap';
import {
  healTurnOps,
  TranscriptService,
  snapshotToOps,
  TRANSCRIPT_OPS_JOURNAL_CAPACITY,
} from '../../src/services/transcript/transcriptService';

function ev(payload: Record<string, unknown>): DomainEvent {
  return payload as unknown as DomainEvent;
}

function turnOps(turnId: string, items: ReturnType<AgentTranscript['getItems']>): TranscriptTurn {
  const turn = items.find(
    (item): item is TranscriptTurn => item.kind === 'turn' && item.turnId === turnId,
  );
  if (turn === undefined) throw new Error(`turn ${turnId} not found`);
  return turn;
}

describe('AgentTranscriptProjector', () => {
  it('projects a full turn: headers, delta appends, flush, tool frames', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const ops: TranscriptOperation[] = [];
    const feed = (event: DomainEvent): void => {
      const mapped = projector.map(event);
      ops.push(...mapped);
      tx.apply(mapped);
    };

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1, stepId: 'u1' }));
    feed(ev({ type: 'assistant.delta', turnId: 1, delta: 'Hello' }));
    feed(ev({ type: 'assistant.delta', turnId: 1, delta: ' world' }));
    feed(
      ev({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 'call_1',
        name: 'Bash',
        args: '{"command":"ls"}',
        display: { kind: 'command', command: 'ls' },
      }),
    );
    feed(ev({ type: 'tool.result', turnId: 1, toolCallId: 'call_1', output: 'file.txt' }));
    feed(ev({ type: 'turn.step.completed', turnId: 1, step: 1, stepId: 'u1' }));
    feed(ev({ type: 'turn.ended', turnId: 1, reason: 'completed' }));

    // Op-level: turn/step headers carry no render content; deltas are appends
    // with cumulative offsets; the step flush re-emits the full text.
    const appends = ops.filter((op): op is AppendOp => op.op === 'append');
    expect(appends.map((op) => [op.offset, op.text])).toEqual([
      [0, 'Hello'],
      [5, ' world'],
    ]);
    const upserts = ops.filter((op): op is FrameUpsertOp => op.op === 'frame.upsert');
    const flushUpsert = upserts.find(
      (op) => op.frame.kind === 'text' && op.frame.text === 'Hello world',
    );
    expect(flushUpsert).toBeDefined();

    // Converged store state.
    const turn = turnOps('t1', tx.getItems());
    expect(turn.state).toBe('completed');
    expect(turn.origin).toEqual({ kind: 'user', payload: { kind: 'user' } });
    expect(turn.endedAt).toBeTypeOf('string');
    expect(turn.steps).toHaveLength(1);
    const step = turn.steps[0]!;
    expect(step.state).toBe('completed');
    const text = step.frames.find((frame) => frame.kind === 'text');
    expect(text).toMatchObject({ role: 'assistant', text: 'Hello world' });
    const tool = step.frames.find((frame) => frame.kind === 'tool');
    expect(tool).toMatchObject({
      frameId: 't1.1.call_1',
      toolCallId: 'call_1',
      name: 'Bash',
      state: 'done',
      input: { command: 'ls' },
      output: 'file.txt',
      display: { kind: 'command', command: 'ls' },
    });
  });

  it('projects the live prompt from turn.started and keeps it through turn.ended', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const feed = (event: DomainEvent): void => {
      tx.apply(projector.map(event));
    };

    feed(ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' }, prompt: 'fix the bug' }));
    feed(ev({ type: 'assistant.delta', turnId: 0, delta: 'on it' }));
    feed(ev({ type: 'turn.ended', turnId: 0, reason: 'completed' }));

    const turn = turnOps('t0', tx.getItems());
    expect(turn.prompt).toBe('fix the bug');
    expect(turn.state).toBe('completed');
  });

  it('places late-attach deltas into the engine-reported active step', () => {
    const tx = new AgentTranscript('main');
    // The projector missed turn.started AND turn.step.started for step 2 —
    // without the lookup the fallback would synthesize t0.1 and stream into
    // the wrong step.
    const projector = new AgentTranscriptProjector('main', {
      stepOrdinal: (turnId) => (turnId === 't0' ? 2 : undefined),
    });

    const ops = projector.map(ev({ type: 'assistant.delta', turnId: 0, delta: 'late' }));
    tx.apply(ops);

    const turn = turnOps('t0', tx.getItems());
    expect(turn.steps.map((s) => s.stepId)).toEqual(['t0.2']);
    expect(turn.steps[0]?.frames[0]).toMatchObject({ kind: 'text', text: 'late' });
  });

  it('adopts a backfilled stream frame on mid-turn attach instead of clobbering it', () => {
    const tx = new AgentTranscript('main');
    // The backfill seeded the in-flight step's partial text before the
    // projector observed any delta.
    tx.apply([
      {
        op: 'turn.upsert',
        turn: { kind: 'turn', turnId: 't0', ordinal: 0, state: 'running', origin: { kind: 'user' } },
      },
      {
        op: 'step.upsert',
        turnId: 't0',
        step: { kind: 'step', stepId: 't0.1', turnId: 't0', ordinal: 1, state: 'running' },
      },
      {
        op: 'frame.upsert',
        turnId: 't0',
        stepId: 't0.1',
        frame: { kind: 'text', frameId: 't0.1.f1', role: 'assistant', text: 'Hello ' },
      },
    ]);
    const projector = new AgentTranscriptProjector('main', {
      stepFrames: (turnId, stepId) =>
        tx.getTurn(turnId)?.steps.find((s) => s.stepId === stepId)?.frames,
    });

    // The live stream resumes: no empty upsert, the append continues at the
    // seeded offset.
    const ops = projector.map(ev({ type: 'assistant.delta', turnId: 0, delta: 'world' }));
    tx.apply(ops);
    expect(ops.some((op) => op.op === 'frame.upsert')).toBe(false);
    const append = ops.find((op): op is AppendOp => op.op === 'append');
    expect(append && [append.offset, append.text]).toEqual([6, 'world']);
    const turn = turnOps('t0', tx.getItems());
    const text = turn.steps[0]?.frames.find((frame) => frame.kind === 'text');
    expect(text).toMatchObject({ text: 'Hello world' });

    // Later frames in the same step must not collide with the adopted id.
    const next = projector.map(ev({ type: 'thinking.delta', turnId: 0, delta: 'hmm' }));
    const created = next.find((op): op is FrameUpsertOp => op.op === 'frame.upsert');
    expect(created?.frame.frameId).toBe('t0.1.f2');
  });

  it('adopts a backfilled tool frame when the result arrives after a mid-bind attach', () => {
    const tx = new AgentTranscript('main');
    // The backfill seeded the running tool call (from the persisted assistant
    // toolCalls) before the projector observed any event.
    tx.apply([
      {
        op: 'turn.upsert',
        turn: { kind: 'turn', turnId: 't0', ordinal: 0, state: 'running', origin: { kind: 'user' } },
      },
      {
        op: 'step.upsert',
        turnId: 't0',
        step: { kind: 'step', stepId: 't0.1', turnId: 't0', ordinal: 1, state: 'running' },
      },
      {
        op: 'frame.upsert',
        turnId: 't0',
        stepId: 't0.1',
        frame: {
          kind: 'tool',
          frameId: 't0.1.call_1',
          toolCallId: 'call_1',
          name: 'Bash',
          state: 'running',
          input: { command: 'ls' },
        },
      },
    ]);
    const projector = new AgentTranscriptProjector('main', {
      toolFrame: (toolCallId) => {
        for (const item of tx.getItems()) {
          if (item.kind !== 'turn') continue;
          for (const step of item.steps) {
            for (const frame of step.frames) {
              if (frame.kind === 'tool' && frame.toolCallId === toolCallId) {
                return { turnId: item.turnId, stepId: step.stepId, frame };
              }
            }
          }
        }
        return undefined;
      },
    });

    // The projector never saw tool.call.started — without adoption the result
    // is dropped and the seeded frame stays output-less.
    const ops = projector.map(ev({ type: 'tool.result', toolCallId: 'call_1', output: 'file.txt' }));
    expect(ops).toHaveLength(1);
    tx.apply(ops);
    const turn = turnOps('t0', tx.getItems());
    const tool = turn.steps[0]?.frames.find((frame) => frame.kind === 'tool');
    expect(tool).toMatchObject({ toolCallId: 'call_1', state: 'done', output: 'file.txt' });
  });

  it('adopts a seeded parent tool frame when subagent.spawned links the child', () => {
    const tx = new AgentTranscript('main');
    // The Agent tool call started before the projector attached; the backfill
    // seeded its frame from the persisted assistant toolCalls.
    tx.apply([
      {
        op: 'turn.upsert',
        turn: { kind: 'turn', turnId: 't0', ordinal: 0, state: 'running', origin: { kind: 'user' } },
      },
      {
        op: 'step.upsert',
        turnId: 't0',
        step: { kind: 'step', stepId: 't0.1', turnId: 't0', ordinal: 1, state: 'running' },
      },
      {
        op: 'frame.upsert',
        turnId: 't0',
        stepId: 't0.1',
        frame: {
          kind: 'tool',
          frameId: 't0.1.call_agent',
          toolCallId: 'call_agent',
          name: 'Agent',
          state: 'running',
          input: { prompt: 'scan' },
        },
      },
    ]);
    const projector = new AgentTranscriptProjector('main', {
      toolFrame: (toolCallId) => {
        for (const item of tx.getItems()) {
          if (item.kind !== 'turn') continue;
          for (const step of item.steps) {
            for (const frame of step.frames) {
              if (frame.kind === 'tool' && frame.toolCallId === toolCallId) {
                return { turnId: item.turnId, stepId: step.stepId, frame };
              }
            }
          }
        }
        return undefined;
      },
    });

    const ops = projector.map(
      ev({
        type: 'subagent.spawned',
        subagentId: 'agent-1',
        subagentName: 'explore',
        parentToolCallId: 'call_agent',
        runInBackground: false,
      }),
    );
    tx.apply(ops);
    const turn = turnOps('t0', tx.getItems());
    const tool = turn.steps[0]?.frames.find((frame) => frame.kind === 'tool');
    expect(tool?.kind === 'tool' && tool.agentRefs).toEqual([{ agentId: 'agent-1', role: 'child' }]);
  });

  it('gives live markers their own namespace so they never collide with backfilled markers', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    // A historical marker from the cold rebuild already occupies `m1`.
    tx.apply([{ op: 'marker.upsert', item: { kind: 'marker', markerId: 'm1', marker: 'skill' } }]);

    const ops = projector.map(ev({ type: 'compaction.started', trigger: 'auto' }));
    tx.apply(ops);

    // Without the namespace the live marker would also be `m1`, and the
    // store's upsert would have replaced the historical one.
    const markers = tx
      .getItems()
      .filter((item): item is Extract<typeof item, { kind: 'marker' }> => item.kind === 'marker');
    expect(markers.map((m) => [m.markerId, m.marker])).toEqual([
      ['m1', 'skill'],
      ['live-m1', 'compaction'],
    ]);
  });

  it('snapshotToOps anchors standalone items so backfill keeps history order against live turns', () => {
    const snapshot: AgentTranscriptSnapshot = {
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      items: [
        {
          kind: 'turn',
          turnId: 't0',
          ordinal: 0,
          state: 'completed',
          origin: { kind: 'user' },
          prompt: 'one',
          steps: [],
        },
        { kind: 'marker', markerId: 'm1', marker: 'skill' },
        {
          kind: 'turn',
          turnId: 't1',
          ordinal: 1,
          state: 'completed',
          origin: { kind: 'user' },
          prompt: 'two',
          steps: [],
        },
        { kind: 'taskref', refId: 'r1', taskId: 'bash-1' },
      ],
      tasks: [],
      meta: {},
    };
    const ops = snapshotToOps(snapshot);
    // m1 sits before t1 in history; the trailing r1 anchors past the last
    // snapshot turn (where the engine's next live turn lands).
    expect(ops.find((op) => op.op === 'marker.upsert')).toMatchObject({ beforeTurn: 1 });
    expect(ops.find((op) => op.op === 'taskref.upsert')).toMatchObject({ beforeTurn: 2 });

    // A live turn arrived before the backfill landed; anchored items must
    // slot into their historical positions, not append past it.
    const tx = new AgentTranscript('main');
    tx.apply([
      {
        op: 'turn.upsert',
        turn: { kind: 'turn', turnId: 't2', ordinal: 2, state: 'running', origin: { kind: 'user' } },
      },
    ]);
    tx.apply(ops);
    expect(
      tx.getItems().map((item) => {
        if (item.kind === 'turn') return item.turnId;
        if (item.kind === 'marker') return item.markerId;
        return item.refId;
      }),
    ).toEqual(['t0', 'm1', 't1', 'r1', 't2']);
  });

  it('flushes open frames on turn.ended even without step completion', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const feed = (event: DomainEvent): void => void tx.apply(projector.map(event));

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    feed(ev({ type: 'thinking.delta', turnId: 1, delta: 'hmm' }));
    feed(ev({ type: 'assistant.delta', turnId: 1, delta: 'partial' }));
    feed(ev({ type: 'turn.ended', turnId: 1, reason: 'cancelled' }));

    const turn = turnOps('t1', tx.getItems());
    expect(turn.state).toBe('cancelled');
    const step = turn.steps[0]!;
    // The interrupted step is closed and both open frames carry whole text.
    expect(step.state).toBe('interrupted');
    expect(step.frames).toContainEqual(
      expect.objectContaining({ kind: 'thinking', text: 'hmm' }),
    );
    expect(step.frames).toContainEqual(
      expect.objectContaining({ kind: 'text', text: 'partial' }),
    );
  });

  it('carries usage / finishReason / the full timing breakdown on turn.step.completed', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const feed = (event: DomainEvent): void => void tx.apply(projector.map(event));

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    feed(
      ev({
        type: 'turn.step.completed',
        turnId: 1,
        step: 1,
        usage: { inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 40 },
        rawFinishReason: 'tool_calls',
        llmFirstTokenLatencyMs: 120,
        llmStreamDurationMs: 900,
        llmRequestBuildMs: 10,
        llmServerFirstTokenMs: 110,
        llmServerDecodeMs: 800,
        llmClientConsumeMs: 100,
      }),
    );

    const step = turnOps('t1', tx.getItems()).steps[0]!;
    expect(step.state).toBe('completed');
    expect(step.usage).toEqual({
      inputOther: 100,
      output: 20,
      inputCacheRead: 30,
      inputCacheCreation: 40,
    });
    expect(step.finishReason).toBe('tool_calls');
    expect(step.timing).toEqual({
      llmFirstTokenLatencyMs: 120,
      llmStreamDurationMs: 900,
      llmRequestBuildMs: 10,
      llmServerFirstTokenMs: 110,
      llmServerDecodeMs: 800,
      llmClientConsumeMs: 100,
    });

    // finishReason wins over the raw/provider fallbacks; providerFinishReason
    // is the last resort.
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 2 }));
    feed(
      ev({
        type: 'turn.step.completed',
        turnId: 1,
        step: 2,
        finishReason: 'stop',
        rawFinishReason: 'raw_stop',
        providerFinishReason: 'provider_stop',
      }),
    );
    expect(turnOps('t1', tx.getItems()).steps[1]!.finishReason).toBe('stop');
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 3 }));
    feed(
      ev({ type: 'turn.step.completed', turnId: 1, step: 3, providerFinishReason: 'length' }),
    );
    expect(turnOps('t1', tx.getItems()).steps[2]!.finishReason).toBe('length');
  });

  it('carries endReason / endMessage on turn.step.interrupted', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const feed = (event: DomainEvent): void => void tx.apply(projector.map(event));

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    feed(
      ev({
        type: 'turn.step.interrupted',
        turnId: 1,
        step: 1,
        reason: 'aborted',
        message: 'user cancelled',
      }),
    );

    const step = turnOps('t1', tx.getItems()).steps[0]!;
    expect(step.state).toBe('interrupted');
    expect(step.endReason).toBe('aborted');
    expect(step.endMessage).toBe('user cancelled');
  });

  it('sets retry on turn.step.retrying and clears it at the terminal upsert', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const feed = (event: DomainEvent): void => void tx.apply(projector.map(event));
    const step = (): TranscriptTurn['steps'][number] => turnOps('t1', tx.getItems()).steps[0]!;

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    feed(
      ev({
        type: 'turn.step.retrying',
        turnId: 1,
        step: 1,
        failedAttempt: 1,
        nextAttempt: 2,
        maxAttempts: 3,
        delayMs: 2000,
        errorName: 'ProviderRateLimitError',
        errorMessage: '429 too many requests',
        statusCode: 429,
      }),
    );

    // The step stays running with the retry detail on the header.
    expect(step().state).toBe('running');
    expect(step().retry).toEqual({
      failedAttempt: 1,
      nextAttempt: 2,
      maxAttempts: 3,
      delayMs: 2000,
      errorName: 'ProviderRateLimitError',
      errorMessage: '429 too many requests',
      statusCode: 429,
    });

    // The terminal upsert carries no retry — the whole-header replace clears it.
    feed(ev({ type: 'turn.step.completed', turnId: 1, step: 1 }));
    expect(step().state).toBe('completed');
    expect(step().retry).toBeUndefined();
  });

  it('fills durationMs / error / accumulated step usage on turn.ended', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const feed = (event: DomainEvent): void => void tx.apply(projector.map(event));

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    feed(
      ev({
        type: 'turn.step.completed',
        turnId: 1,
        step: 1,
        usage: { inputOther: 100, output: 10, inputCacheRead: 5, inputCacheCreation: 50 },
      }),
    );
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 2 }));
    feed(
      ev({
        type: 'turn.step.completed',
        turnId: 1,
        step: 2,
        usage: { inputOther: 200, output: 20, inputCacheRead: 0, inputCacheCreation: 25 },
      }),
    );
    feed(ev({ type: 'turn.ended', turnId: 1, reason: 'completed', durationMs: 4200 }));

    const turn = turnOps('t1', tx.getItems());
    expect(turn.durationMs).toBe(4200);
    // inputTokens = inputOther + inputCacheCreation, summed across the steps.
    expect(turn.usage).toEqual({ inputTokens: 375, cachedTokens: 5, outputTokens: 30 });

    // A turn whose steps reported no usage gets no usage; a failed turn
    // carries the error message.
    feed(ev({ type: 'turn.started', turnId: 2, origin: { kind: 'user' } }));
    feed(
      ev({
        type: 'turn.ended',
        turnId: 2,
        reason: 'failed',
        durationMs: 50,
        error: { code: 'internal', message: 'kaboom', retryable: false },
      }),
    );
    const failed = turnOps('t2', tx.getItems());
    expect(failed.state).toBe('failed');
    expect(failed.error).toBe('kaboom');
    expect(failed.usage).toBeUndefined();
  });

  it('accumulates tool.call.delta into inputText, kept across tool.call.started', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const feed = (event: DomainEvent): void => void tx.apply(projector.map(event));
    const toolFrame = (toolCallId: string): TranscriptFrame | undefined =>
      turnOps('t1', tx.getItems())
        .steps.flatMap((step) => step.frames)
        .find((frame) => frame.kind === 'tool' && frame.toolCallId === toolCallId);

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    // Deltas arrive before the started event: the frame is created running and
    // the raw argument text accumulates.
    feed(
      ev({
        type: 'tool.call.delta',
        turnId: 1,
        toolCallId: 'c1',
        name: 'Bash',
        argumentsPart: '{"comm',
      }),
    );
    feed(ev({ type: 'tool.call.delta', turnId: 1, toolCallId: 'c1', argumentsPart: 'and":"ls"}' }));
    expect(toolFrame('c1')).toMatchObject({
      kind: 'tool',
      frameId: 't1.1.c1',
      name: 'Bash',
      state: 'running',
      inputText: '{"command":"ls"}',
    });
    // A delta that never names the call leaves the name empty until started.
    feed(ev({ type: 'tool.call.delta', turnId: 1, toolCallId: 'c2', argumentsPart: '{}' }));
    expect(toolFrame('c2')).toMatchObject({ name: '', inputText: '{}' });

    // The started event fills in the parsed input but keeps the raw text.
    feed(
      ev({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 'c1',
        name: 'Bash',
        args: { command: 'ls' },
      }),
    );
    expect(toolFrame('c1')).toMatchObject({
      input: { command: 'ls' },
      inputText: '{"command":"ls"}',
    });
    // Deltas after started keep accumulating onto the same frame.
    feed(ev({ type: 'tool.call.delta', turnId: 1, toolCallId: 'c1', argumentsPart: '\n' }));
    expect(toolFrame('c1')).toMatchObject({ inputText: '{"command":"ls"}\n' });
    // And the terminal result keeps the accumulated text too.
    feed(ev({ type: 'tool.result', turnId: 1, toolCallId: 'c1', output: 'file.txt' }));
    expect(toolFrame('c1')).toMatchObject({ state: 'done', inputText: '{"command":"ls"}\n' });
  });

  it('overwrites tool frame progress and drops progress for unknown calls', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const feed = (event: DomainEvent): void => void tx.apply(projector.map(event));

    // Unknown call (no started/delta frame, no seeded frame to adopt): dropped.
    expect(
      projector.map(
        ev({
          type: 'tool.progress',
          turnId: 1,
          toolCallId: 'ghost',
          update: { kind: 'stdout', text: 'x' },
        }),
      ),
    ).toEqual([]);

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    feed(
      ev({ type: 'tool.call.started', turnId: 1, toolCallId: 'c1', name: 'Bash', args: {} }),
    );
    feed(
      ev({
        type: 'tool.progress',
        turnId: 1,
        toolCallId: 'c1',
        update: { kind: 'stdout', text: 'line1' },
      }),
    );
    const tool = (): TranscriptFrame | undefined =>
      turnOps('t1', tx.getItems()).steps[0]!.frames.find((frame) => frame.kind === 'tool');
    expect(tool()).toMatchObject({ progress: { kind: 'stdout', text: 'line1' } });

    // The newest update overwrites the previous one wholesale.
    feed(
      ev({
        type: 'tool.progress',
        turnId: 1,
        toolCallId: 'c1',
        update: { kind: 'progress', percent: 40 },
      }),
    );
    expect(tool()).toMatchObject({ progress: { kind: 'progress', percent: 40 } });
    expect((tool() as { progress?: Record<string, unknown> }).progress?.['text']).toBeUndefined();
  });

  it('marks tool.result errors and keeps the display payload', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const feed = (event: DomainEvent): void => void tx.apply(projector.map(event));

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    feed(
      ev({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 'c1',
        name: 'Read',
        args: { path: '/x' },
        display: { kind: 'file', path: '/x' },
      }),
    );
    feed(ev({ type: 'tool.result', turnId: 1, toolCallId: 'c1', output: 'ENOENT', isError: true }));

    const tool = turnOps('t1', tx.getItems()).steps[0]!.frames.find((f) => f.kind === 'tool');
    expect(tool).toMatchObject({
      state: 'error',
      output: 'ENOENT',
      error: 'ENOENT',
      display: { kind: 'file', path: '/x' },
    });
  });

  it('projects process tasks as shell tasks with streaming output', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const ops: TranscriptOperation[] = [];
    const feed = (event: DomainEvent): void => {
      const mapped = projector.map(event);
      ops.push(...mapped);
      tx.apply(mapped);
    };

    const started = {
      taskId: 'bash-1',
      kind: 'process',
      description: 'ls -la',
      status: 'running',
      detached: false,
      startedAt: 1_700_000_000_000,
      endedAt: null,
    };
    feed(ev({ type: 'task.started', info: started }));
    feed(ev({ type: 'shell.started', commandId: 'cmd-1', taskId: 'bash-1' }));
    feed(ev({ type: 'shell.output', commandId: 'cmd-1', update: { kind: 'stdout', text: 'a\n' } }));
    feed(ev({ type: 'shell.output', commandId: 'cmd-1', update: { kind: 'stderr', text: 'b\n' } }));
    feed(
      ev({
        type: 'task.terminated',
        info: { ...started, status: 'completed', endedAt: 1_700_000_001_000 },
      }),
    );

    // Taskref anchors the entity in the timeline; output appends are offset-keyed.
    expect(ops.some((op) => op.op === 'taskref.upsert' && op.item.taskId === 'bash-1')).toBe(true);
    const appends = ops.filter((op): op is AppendOp => op.op === 'append');
    expect(appends.map((op) => [op.offset, op.text])).toEqual([
      [0, 'a\n'],
      [2, 'b\n'],
    ]);

    const task = tx.getTask('bash-1');
    expect(task).toMatchObject({
      kind: 'shell',
      state: 'completed',
      detached: false,
      description: 'ls -la',
      outputTail: 'a\nb\n',
    });
    // Non-text updates are dropped.
    expect(
      projector.map(
        ev({ type: 'shell.output', commandId: 'cmd-1', update: { kind: 'progress', percent: 50 } }),
      ),
    ).toEqual([]);
  });

  it('fills the shell task output from late stderr chunks before completing', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');

    tx.apply(projector.map(ev({ type: 'shell.started', commandId: 'c1', taskId: 'task-1' })));
    tx.apply(
      projector.map(ev({ type: 'shell.output', commandId: 'c1', update: { kind: 'stderr', text: 'boom' } })),
    );
    tx.apply(projector.map(ev({ type: 'shell.completed', commandId: 'c1', isError: true })));

    expect(tx.getTask('task-1')).toMatchObject({ state: 'failed', outputTail: 'boom' });
  });

  it('routes shell output/completion via the event taskId when shell.started was missed', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');

    // Mid-command attach: no shell.started observed, but later events carry
    // the task id — output and terminal state must still land, and the task
    // needs its timeline taskref (exactly like onShellStarted emits).
    tx.apply(
      projector.map(
        ev({ type: 'shell.output', commandId: 'c1', taskId: 'task-1', update: { kind: 'stdout', text: 'hello' } }),
      ),
    );
    expect(tx.getTask('task-1')).toMatchObject({ kind: 'shell', state: 'running', outputTail: 'hello' });
    expect(tx.getItems()).toContainEqual(expect.objectContaining({ kind: 'taskref', taskId: 'task-1' }));

    tx.apply(projector.map(ev({ type: 'shell.completed', commandId: 'c1', taskId: 'task-1', isError: false })));
    expect(tx.getTask('task-1')).toMatchObject({ state: 'completed', outputTail: 'hello' });
  });

  it('emits a taskref when only shell.completed arrives for a command', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');

    tx.apply(projector.map(ev({ type: 'shell.completed', commandId: 'c1', taskId: 'task-1', isError: true })));

    expect(tx.getTask('task-1')).toMatchObject({ kind: 'shell', state: 'failed' });
    expect(tx.getItems()).toContainEqual(expect.objectContaining({ kind: 'taskref', taskId: 'task-1' }));
  });

  it('projects no-taskId shell failures under a synthetic per-command task id', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');

    // The command failed before its foreground task was registered (Bash
    // validation/spawn error): every shell.* event arrives taskId-less. The
    // stderr and the terminal state must still land, under a synthetic id.
    tx.apply(
      projector.map(ev({ type: 'shell.output', commandId: 'c1', update: { kind: 'stderr', text: 'boom' } })),
    );
    expect(tx.getTask('shell-c1')).toMatchObject({ kind: 'shell', state: 'running', outputTail: 'boom' });

    tx.apply(projector.map(ev({ type: 'shell.completed', commandId: 'c1', isError: true })));
    expect(tx.getTask('shell-c1')).toMatchObject({ state: 'failed', outputTail: 'boom' });
    expect(tx.getItems()).toContainEqual(expect.objectContaining({ kind: 'taskref', taskId: 'shell-c1' }));
  });

  it('marks a foreground shell task terminal on shell.completed', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');

    tx.apply(projector.map(ev({ type: 'shell.started', commandId: 'c1', taskId: 'task-1' })));
    expect(tx.getTask('task-1')?.state).toBe('running');

    tx.apply(projector.map(ev({ type: 'shell.completed', commandId: 'c1', isError: false })));
    expect(tx.getTask('task-1')).toMatchObject({ kind: 'shell', state: 'completed' });
    expect(tx.getTask('task-1')?.endedAt).toBeTypeOf('string');

    tx.apply(projector.map(ev({ type: 'shell.started', commandId: 'c2', taskId: 'task-2' })));
    tx.apply(projector.map(ev({ type: 'shell.completed', commandId: 'c2', isError: true })));
    expect(tx.getTask('task-2')?.state).toBe('failed');
  });

  it('ignores task.notified (it re-surfaces as an origin:task turn)', () => {
    const projector = new AgentTranscriptProjector('main');
    expect(projector.map(ev({ type: 'task.notified', taskId: 't' }))).toEqual([]);
  });

  it('links spawned subagents to the spawning tool frame (member for swarm)', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const feed = (event: DomainEvent): void => void tx.apply(projector.map(event));

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    feed(
      ev({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 'call_swarm',
        name: 'AgentSwarm',
        args: {},
      }),
    );
    feed(
      ev({
        type: 'subagent.spawned',
        subagentId: 'agent-0',
        subagentName: 'worker',
        parentToolCallId: 'call_swarm',
        description: 'scan the repo',
        swarmIndex: 0,
        runInBackground: false,
      }),
    );
    feed(ev({ type: 'subagent.completed', subagentId: 'agent-0', resultSummary: 'done' }));

    const tool = turnOps('t1', tx.getItems()).steps[0]!.frames.find((f) => f.kind === 'tool');
    expect(tool).toMatchObject({
      agentRefs: [{ agentId: 'agent-0', role: 'member' }],
    });
    const task = tx.getTask('agent-0');
    expect(task).toMatchObject({
      kind: 'subagent',
      state: 'completed',
      agentId: 'agent-0',
      description: 'scan the repo',
      detached: false,
    });
  });

  it('projects goal updates into meta.goal plus an inline marker', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const snapshot = {
      goalId: 'g1',
      objective: 'ship it',
      status: 'active',
      completionCriterion: 'tests green',
      turnsUsed: 3,
      tokensUsed: 1234,
      wallClockMs: 5000,
      budget: { tokenBudget: 50000 },
    };
    const ops = projector.map(ev({ type: 'goal.updated', snapshot, change: { kind: 'lifecycle' } }));
    tx.apply(ops);

    expect(tx.getMeta().goal).toEqual({
      objective: 'ship it',
      status: 'active',
      completionCriterion: 'tests green',
      budgetUsed: 1234,
      budgetLimit: 50000,
    });
    const marker = tx.getItems().find((item) => item.kind === 'marker');
    expect(marker).toMatchObject({ marker: 'goal', payload: { snapshot } });

    // Cleared goal: only the marker lands (meta.merge cannot express clearing).
    const clearedOps = projector.map(ev({ type: 'goal.updated', snapshot: null }));
    expect(clearedOps.every((op) => op.op === 'marker.upsert')).toBe(true);
  });

  it('mirrors plan / swarm mode slices into meta.modes (only when provided)', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');

    tx.apply(projector.map(ev({ type: 'agent.status.updated', planMode: true })));
    tx.apply(projector.map(ev({ type: 'agent.status.updated', swarmMode: true })));
    expect(tx.getMeta().modes).toEqual({ plan: {}, swarm: {} });

    // Mode exit clears the badge (`null` deletes the key in the reducer).
    tx.apply(projector.map(ev({ type: 'agent.status.updated', planMode: false })));
    expect(tx.getMeta().modes).toEqual({ swarm: {} });
    tx.apply(projector.map(ev({ type: 'agent.status.updated', swarmMode: false })));
    expect(tx.getMeta().modes).toBeUndefined();
  });

  it('mirrors status slices into meta.agent (shallow-merged across slices)', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const feed = (event: DomainEvent): void => void tx.apply(projector.map(event));

    // A usage-only slice projects into meta.agent (never into modes).
    const usageOnly = projector.map(ev({ type: 'agent.status.updated', usage: {} }));
    expect(usageOnly).toEqual([{ op: 'meta.merge', meta: { agent: { usage: {} } } }]);

    feed(ev({ type: 'agent.status.updated', model: 'k2', thinkingEffort: 'high' }));
    feed(
      ev({
        type: 'agent.status.updated',
        usage: {
          total: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
        },
      }),
    );
    feed(
      ev({
        type: 'agent.status.updated',
        contextTokens: 1000,
        maxContextTokens: 200000,
        contextUsage: 0.5,
      }),
    );
    feed(ev({ type: 'agent.status.updated', permission: 'yolo' }));

    // Every arrived slice accumulates on meta.agent.
    expect(tx.getMeta().agent).toEqual({
      model: 'k2',
      thinkingEffort: 'high',
      usage: { total: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 } },
      contextTokens: 1000,
      maxContextTokens: 200000,
      contextUsage: 0.5,
      permission: 'yolo',
    });

    // A later slice overwrites only the fields it carries.
    feed(ev({ type: 'agent.status.updated', model: 'k3' }));
    expect(tx.getMeta().agent).toMatchObject({ model: 'k3', thinkingEffort: 'high' });
  });

  it('maps agent.activity.updated into meta.agent.phase', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const feed = (event: DomainEvent): void => void tx.apply(projector.map(event));
    const turn = (overrides: Record<string, unknown>): Record<string, unknown> => ({
      turnId: 1,
      origin: { kind: 'user' },
      phase: 'running',
      step: 1,
      ending: false,
      pendingApprovals: [],
      activeToolCalls: [],
      since: 1000,
      ...overrides,
    });

    feed(ev({ type: 'agent.activity.updated', lifecycle: 'ready', turn: turn({}), background: [] }));
    expect(tx.getMeta().agent?.phase).toEqual({
      kind: 'running',
      turnId: 1,
      step: 1,
      stepId: '',
      since: 1000,
    });

    feed(
      ev({
        type: 'agent.activity.updated',
        lifecycle: 'ready',
        turn: turn({ phase: 'streaming', stream: 'assistant' }),
        background: [],
      }),
    );
    expect(tx.getMeta().agent?.phase).toMatchObject({ kind: 'streaming', stream: 'assistant' });

    // A pending approval keeps the awaiting_approval phase (v1 semantics).
    feed(
      ev({
        type: 'agent.activity.updated',
        lifecycle: 'ready',
        turn: turn({ pendingApprovals: [{ approvalId: 'ap1', toolCallId: 'c1', since: 1500 }] }),
        background: [],
      }),
    );
    expect(tx.getMeta().agent?.phase).toEqual({
      kind: 'awaiting_approval',
      turnId: 1,
      step: 1,
      approval: { approvalId: 'ap1', toolCallId: 'c1' },
      since: 1500,
    });

    // No active turn + a last outcome → the ended phase; no outcome → idle.
    feed(
      ev({
        type: 'agent.activity.updated',
        lifecycle: 'ready',
        lastTurn: { turnId: 1, reason: 'completed', durationMs: 100, at: 2000 },
        background: [],
      }),
    );
    expect(tx.getMeta().agent?.phase).toEqual({
      kind: 'ended',
      turnId: 1,
      reason: 'completed',
      durationMs: 100,
      at: 2000,
    });
    feed(ev({ type: 'agent.activity.updated', lifecycle: 'ready', background: [] }));
    expect(tx.getMeta().agent?.phase).toEqual({ kind: 'idle' });

    // Disposing/disposed have no v1 phase concept: nothing is emitted.
    expect(
      projector.map(ev({ type: 'agent.activity.updated', lifecycle: 'disposed', background: [] })),
    ).toEqual([]);
  });

  it('projects plan.revision as a marker and refines the active plan badge', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');

    const revision = {
      type: 'plan.revision',
      id: 'plan-1',
      version: 1,
      path: 'agents/main/plan/plan-1/v1.md',
      sha256: 'deadbeef',
      bytes: 128,
    };

    // Plan mode inactive: only the timeline marker lands (no badge).
    tx.apply(projector.map(ev(revision)));
    expect(tx.getMeta().modes).toBeUndefined();

    // Active: a further revision refines the badge with its reference.
    tx.apply(projector.map(ev({ type: 'agent.status.updated', planMode: true })));
    expect(tx.getMeta().modes).toEqual({ plan: {} });
    tx.apply(
      projector.map(ev({ ...revision, version: 2, path: 'agents/main/plan/plan-1/v2.md' })),
    );
    expect(tx.getMeta().modes).toEqual({
      plan: { reviewPath: 'agents/main/plan/plan-1/v2.md', version: 2 },
    });

    // Both revisions stay in the timeline (live marker namespace), payload =
    // the reference fields.
    const markers = tx
      .getItems()
      .filter((item) => item.kind === 'marker' && item.marker === 'plan.revision');
    expect(markers.map((item) => item.kind === 'marker' && item.markerId)).toEqual([
      'live-m1',
      'live-m2',
    ]);
    expect(markers[1]).toMatchObject({
      payload: {
        id: 'plan-1',
        version: 2,
        path: 'agents/main/plan/plan-1/v2.md',
        sha256: 'deadbeef',
        bytes: 128,
      },
    });

    // Plan-mode exit clears the badge; the revision markers stay.
    tx.apply(projector.map(ev({ type: 'agent.status.updated', planMode: false })));
    expect(tx.getMeta().modes).toBeUndefined();
    expect(
      tx.getItems().filter((item) => item.kind === 'marker' && item.marker === 'plan.revision'),
    ).toHaveLength(2);
  });

  it('projects skill / plugin-command / cron / compaction / hook / undo markers', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const feed = (event: DomainEvent): void => void tx.apply(projector.map(event));

    feed(ev({ type: 'skill.activated', activationId: 'a1', skillName: 'gen-docs', trigger: 'user-slash' }));
    feed(
      ev({
        type: 'plugin_command.activated',
        activationId: 'a2',
        pluginId: 'p',
        commandName: 'c',
        trigger: 'user-slash',
      }),
    );
    feed(ev({ type: 'cron.fired', origin: { kind: 'cron_job', jobId: 'j1' }, prompt: 'ping' }));
    feed(ev({ type: 'compaction.started', trigger: 'auto' }));
    feed(ev({ type: 'compaction.completed', result: { kept: 3 } }));
    // `hook.result` carries an optional turnId — absent here, payload verbatim.
    feed(ev({ type: 'hook.result', hookEvent: 'SessionStart', content: 'hook says hi' }));
    feed(
      ev({
        type: 'hook.result',
        turnId: 3,
        hookEvent: 'UserPromptSubmit',
        content: 'blocked by hook',
        blocked: true,
      }),
    );
    feed(ev({ type: 'context.spliced', start: 1, deleteCount: 2, messages: [] }));

    const markers = tx
      .getItems()
      .filter((item): item is Extract<typeof item, { kind: 'marker' }> => item.kind === 'marker');
    expect(markers.map((m) => m.marker)).toEqual([
      'skill',
      'skill',
      'cron.fired',
      'compaction',
      'compaction',
      'hook',
      'hook',
      'undo',
    ]);
    expect(markers[1]!.payload).toMatchObject({ variant: 'plugin_command' });
    expect(markers[3]!.payload).toMatchObject({ phase: 'started' });
    expect(markers[4]!.payload).toMatchObject({ phase: 'completed' });
    expect(markers[5]!.payload).toEqual({ hookEvent: 'SessionStart', content: 'hook says hi' });
    expect(markers[6]!.payload).toEqual({
      turnId: 3,
      hookEvent: 'UserPromptSubmit',
      content: 'blocked by hook',
      blocked: true,
    });
    expect(markers[7]!.payload).toMatchObject({ start: 1, deleteCount: 2 });
  });

  it('projects error / warning events as notice markers outside any step', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');

    tx.apply(
      projector.map(ev({ type: 'error', code: 'mcp.failed', message: 'boom', retryable: false })),
    );
    tx.apply(projector.map(ev({ type: 'warning', message: 'AGENTS.md oversized' })));

    const markers = tx
      .getItems()
      .filter((item): item is Extract<typeof item, { kind: 'marker' }> => item.kind === 'marker');
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({
      marker: 'notice',
      payload: { level: 'error', message: 'boom', event: { code: 'mcp.failed' } },
    });
    expect(markers[1]).toMatchObject({
      marker: 'notice',
      payload: { level: 'warning', message: 'AGENTS.md oversized' },
    });
  });

  it('emits interactions as global entities only (no inline frame), back-links on resolve', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const feed = (event: DomainEvent): void => void tx.apply(projector.map(event));

    feed(ev({ type: 'turn.started', turnId: 2, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 2, step: 1 }));
    feed(
      ev({
        type: 'tool.call.started',
        turnId: 2,
        toolCallId: 'call_9',
        name: 'Bash',
        args: {},
      }),
    );

    const request = {
      toolCallId: 'call_9',
      toolName: 'Bash',
      action: 'run',
      display: { kind: 'command', command: 'rm -rf /tmp/x' },
    };
    tx.apply(
      projector.mapInteractionRequested({
        id: 'apr-1',
        kind: 'approval',
        payload: request,
        origin: { agentId: 'main', turnId: 2 },
      }),
    );

    // Interactions are entity-only: the step carries just the tool frame, no
    // inline interaction frame.
    expect(turnOps('t2', tx.getItems()).steps[0]!.frames.map((f) => f.kind)).toEqual(['tool']);
    // The global entity, anchored by toolCallId.
    expect(tx.getInteraction('apr-1')).toMatchObject({
      interactionId: 'apr-1',
      interactionKind: 'approval',
      toolCallId: 'call_9',
      state: 'pending',
      request,
    });
    expect(tx.listPendingInteractions()).toEqual(['apr-1']);

    tx.apply(projector.mapInteractionResolved('apr-1', { decision: 'approved', scope: 'session' }));

    const tool = turnOps('t2', tx.getItems()).steps[0]!.frames.find((f) => f.kind === 'tool');
    expect(tool).toMatchObject({ approvalId: 'apr-1' });
    // Resolve also leaves the step frames untouched (entity-only).
    expect(turnOps('t2', tx.getItems()).steps[0]!.frames.map((f) => f.kind)).toEqual(['tool']);
    expect(tx.getInteraction('apr-1')).toMatchObject({
      state: 'approved',
      response: { decision: 'approved', scope: 'session' },
    });
    expect(tx.listPendingInteractions()).toEqual([]);
  });

  it('surfaces a mid-turn task notification as a user input frame linked to the task', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const feed = (event: DomainEvent): void => void tx.apply(projector.map(event));

    const notified = (): DomainEvent =>
      ev({
        type: 'task.notified',
        notificationType: 'task.completed',
        title: 'Background process completed',
        body: 'pnpm test — 42 passed',
        severity: 'info',
        sourceKind: 'background_task',
        sourceId: 'task_1',
      });

    // Idle (no open step): the notification opens a task-origin turn instead —
    // no inline frame.
    tx.apply(projector.map(notified()));
    expect(tx.getItems()).toHaveLength(0);

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));
    tx.apply(projector.map(notified()));

    const frames = turnOps('t1', tx.getItems()).steps[0]!.frames;
    const frame = frames.find((f) => f.kind === 'text' && f.role === 'user');
    expect(frame).toMatchObject({ kind: 'text', role: 'user', taskId: 'task_1' });
    expect(frame?.kind === 'text' && frame.text).toContain('Background process completed');
  });

  it('replaces the global todo document on a confirmed TodoList write', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const feed = (event: DomainEvent): void => void tx.apply(projector.map(event));

    feed(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    feed(ev({ type: 'turn.step.started', turnId: 1, step: 1 }));

    // A read (no `todos` arg) writes nothing.
    feed(ev({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_read', name: 'TodoList', args: {} }));
    feed(ev({ type: 'tool.result', toolCallId: 'call_read', output: '2 todos' }));
    expect(tx.getTodo('todo')).toBeUndefined();

    feed(
      ev({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 'call_write',
        name: 'TodoList',
        args: { todos: [{ title: 'write tests', status: 'in_progress' }, { title: 'ship', status: 'pending' }] },
      }),
    );
    const writeFrame = turnOps('t1', tx.getItems()).steps[0]!.frames.find(
      (f) => f.kind === 'tool' && f.toolCallId === 'call_write',
    );
    expect(writeFrame?.kind === 'tool' && writeFrame.todoId).toBe('todo');

    feed(ev({ type: 'tool.result', toolCallId: 'call_write', output: 'updated' }));
    expect(tx.getTodo('todo')?.items).toEqual([
      { title: 'write tests', status: 'in_progress' },
      { title: 'ship', status: 'pending' },
    ]);

    // A failed write must not clobber the document.
    feed(
      ev({
        type: 'tool.call.started',
        turnId: 1,
        toolCallId: 'call_fail',
        name: 'TodoList',
        args: { todos: [] },
      }),
    );
    feed(ev({ type: 'tool.result', toolCallId: 'call_fail', output: 'boom', isError: true }));
    expect(tx.getTodo('todo')?.items).toHaveLength(2);
  });

  it('emits an unanchored entity when the payload has no toolCallId', () => {
    // An interaction without an anchor tool call still becomes an entity
    // (toolCallId omitted); it renders floating in consumers, never inline.
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');

    tx.apply(
      projector.mapInteractionRequested({
        id: 'q1',
        kind: 'question',
        payload: { questions: [{ question: 'Pick', options: [] }] },
        origin: { agentId: 'main', turnId: 3 },
      }),
    );
    // No turn/step/frame is materialized for the interaction.
    expect(tx.getItems()).toHaveLength(0);
    const entity = tx.getInteraction('q1');
    expect(entity).toMatchObject({ interactionKind: 'question', state: 'pending' });
    expect(entity?.toolCallId).toBeUndefined();
    expect(tx.listPendingInteractions()).toEqual(['q1']);

    // Dismissed question (null response).
    tx.apply(projector.mapInteractionResolved('q1', null));
    expect(tx.getInteraction('q1')).toMatchObject({ state: 'dismissed' });
    expect(tx.listPendingInteractions()).toEqual([]);
  });

  it('projects prompt submitted/completed/aborted/steered as global queue entities', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const feed = (event: DomainEvent): void => void tx.apply(projector.map(event));

    feed(
      ev({
        type: 'prompt.submitted',
        promptId: 'p1',
        userMessageId: 'm1',
        status: 'running',
        content: [{ type: 'text', text: 'first' }],
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    feed(
      ev({
        type: 'prompt.submitted',
        promptId: 'p2',
        userMessageId: 'm2',
        status: 'queued',
        content: [{ type: 'text', text: 'second' }],
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
    );
    expect(tx.getPrompt('p1')).toMatchObject({ status: 'running', userMessageId: 'm1' });
    expect(tx.getPrompt('p2')).toMatchObject({ status: 'queued' });

    // Steer: p2 merges into the running p1 — p1 keeps running with the merged
    // content and the steer timestamp, p2 leaves the queue as completed.
    feed(
      ev({
        type: 'prompt.steered',
        activePromptId: 'p1',
        promptIds: ['p2'],
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
        steeredAt: '2026-01-01T00:00:02.000Z',
      }),
    );
    expect(tx.getPrompt('p1')).toMatchObject({
      status: 'running',
      steeredAt: '2026-01-01T00:00:02.000Z',
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    });
    expect(tx.getPrompt('p2')).toMatchObject({
      status: 'completed',
      userMessageId: 'm2',
      steeredAt: '2026-01-01T00:00:02.000Z',
      finishedAt: '2026-01-01T00:00:02.000Z',
    });

    // Completed settles the active prompt (reason defaults to 'completed').
    feed(
      ev({
        type: 'prompt.completed',
        promptId: 'p1',
        finishedAt: '2026-01-01T00:00:10.000Z',
        reason: 'completed',
      }),
    );
    expect(tx.getPrompt('p1')).toMatchObject({
      status: 'completed',
      finishedAt: '2026-01-01T00:00:10.000Z',
      // The steered content survives the terminal upsert.
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    });

    // A terminal event for a prompt whose submitted was never seen (the v2 bus
    // does not publish it) synthesizes a minimal entity.
    feed(ev({ type: 'prompt.aborted', promptId: 'p3', abortedAt: '2026-01-01T00:00:03.000Z' }));
    expect(tx.getPrompt('p3')).toEqual({
      promptId: 'p3',
      status: 'aborted',
      createdAt: '2026-01-01T00:00:03.000Z',
      finishedAt: '2026-01-01T00:00:03.000Z',
    });
    feed(
      ev({
        type: 'prompt.completed',
        promptId: 'p4',
        finishedAt: '2026-01-01T00:00:04.000Z',
        reason: 'failed',
      }),
    );
    expect(tx.getPrompt('p4')).toEqual({
      promptId: 'p4',
      status: 'failed',
      createdAt: '2026-01-01T00:00:04.000Z',
      finishedAt: '2026-01-01T00:00:04.000Z',
    });
  });

  it('readColdSnapshot answers empty for path-hostile agent ids without touching disk', async () => {
    const service = new TranscriptService({
      homeDir: '/nonexistent-home',
      core: {
        accessor: {
          get: (token: unknown) => {
            if (token === ISessionLifecycleService) {
              return {
                onDidCloseSession: () => ({ dispose: () => undefined }),
                onDidArchiveSession: () => ({ dispose: () => undefined }),
              };
            }
            if (token === ISessionIndex) return { get: async () => ({ workspaceId: 'ws' }) };
            return undefined;
          },
        },
      } as unknown as Scope,
    });
    for (const hostile of ['../../main', '..', 'a/b', 'a\\b']) {
      const snapshot = await service.readColdSnapshot('s1', hostile);
      expect(snapshot?.items).toEqual([]);
    }
  });

  it('readColdSnapshot folds task/todo/goal/plan/interaction records into the cold snapshot', async () => {
    const home = await mkdtemp(join(tmpdir(), 'transcript-cold-facts-'));
    try {
      const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
      await mkdir(wireDir, { recursive: true });
      const records = [
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'hi' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
          time: 1000,
        },
        {
          type: 'context.append_message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'running' }],
            toolCalls: [{ type: 'function', id: 'call_1', name: 'Bash', arguments: '{"command":"ls"}' }],
          },
          time: 2000,
        },
        {
          type: 'tools.update_store',
          key: 'todo',
          value: [{ title: 'write tests', status: 'in_progress' }],
          time: 3000,
        },
        { type: 'goal.create', goalId: 'g1', objective: 'fix the bug', time: 4000 },
        { type: 'plan_mode.enter', id: 'plan-1', time: 5000 },
        {
          type: 'task.started',
          info: {
            taskId: 'task_1',
            kind: 'process',
            description: 'pnpm test',
            status: 'running',
            startedAt: 6000,
            endedAt: null,
          },
          time: 6000,
        },
        {
          type: 'task.terminated',
          info: {
            taskId: 'task_1',
            kind: 'process',
            description: 'pnpm test',
            status: 'completed',
            startedAt: 6000,
            endedAt: 9000,
          },
          outputTail: '42 passed',
          time: 9000,
        },
        {
          type: 'interaction.request',
          id: 'apr-1',
          kind: 'approval',
          toolCallId: 'call_1',
          request: { toolName: 'Bash' },
          time: 7000,
        },
        {
          type: 'interaction.resolved',
          id: 'apr-1',
          response: { decision: 'approved' },
          time: 8000,
        },
      ];
      await writeFile(join(wireDir, 'wire.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);

      const service = new TranscriptService({
        homeDir: home,
        core: {
          accessor: {
            get: (token: unknown) => {
              if (token === ISessionLifecycleService) {
                return {
                  onDidCloseSession: () => ({ dispose: () => undefined }),
                  onDidArchiveSession: () => ({ dispose: () => undefined }),
                };
              }
              if (token === ISessionIndex) return { get: async () => ({ workspaceId: 'ws' }) };
              return undefined;
            },
          },
        } as unknown as Scope,
      });
      const snapshot = await service.readColdSnapshot('s1', 'main');
      expect(snapshot).toBeDefined();

      // Entities rebuilt from the non-context records.
      expect(snapshot!.tasks).toEqual([
        {
          taskId: 'task_1',
          kind: 'shell',
          state: 'completed',
          detached: true,
          description: 'pnpm test',
          agentId: undefined,
          outputTail: '42 passed',
          startedAt: new Date(6000).toISOString(),
          endedAt: new Date(9000).toISOString(),
        },
      ]);
      expect(snapshot!.todos).toEqual([
        {
          todoId: 'todo',
          items: [{ title: 'write tests', status: 'in_progress' }],
          updatedAt: new Date(3000).toISOString(),
        },
      ]);
      expect(snapshot!.meta.goal).toMatchObject({ objective: 'fix the bug', status: 'active' });
      expect(snapshot!.meta.modes).toEqual({ plan: {} });
      expect(snapshot!.interactions).toEqual([
        {
          interactionId: 'apr-1',
          interactionKind: 'approval',
          toolCallId: 'call_1',
          state: 'approved',
          request: { toolName: 'Bash' },
          response: { decision: 'approved' },
        },
      ]);

      // The turn tree comes from the context records; markers/taskrefs from
      // the fact fold append after it in record order.
      const standalone = snapshot!.items.filter((item) => item.kind !== 'turn');
      expect(standalone).toEqual([
        expect.objectContaining({ kind: 'marker', marker: 'goal', markerId: 'm1' }),
        expect.objectContaining({ kind: 'marker', marker: 'plan.enter', markerId: 'm2' }),
        expect.objectContaining({ kind: 'taskref', refId: 'ref-task_1', taskId: 'task_1' }),
      ]);
      service.dropSession('s1');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('folds blocked turn endings into failed (engine wire contract)', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    tx.apply(projector.map(ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' } })));
    tx.apply(projector.map(ev({ type: 'turn.ended', turnId: 0, reason: 'blocked' })));
    expect(turnOps('t0', tx.getItems()).state).toBe('failed');
  });

  it('maps cron / task origins onto the turn header', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const feed = (event: DomainEvent): void => void tx.apply(projector.map(event));

    feed(
      ev({
        type: 'turn.started',
        turnId: 1,
        origin: { kind: 'cron_job', jobId: 'job-9', cron: '* * * * *' },
      }),
    );
    feed(
      ev({
        type: 'turn.started',
        turnId: 2,
        origin: { kind: 'task', taskId: 'bash-1', status: 'completed', notificationId: 'n1' },
      }),
    );

    expect(turnOps('t1', tx.getItems()).origin).toEqual({
      kind: 'cron',
      taskId: 'job-9',
      payload: { kind: 'cron_job', jobId: 'job-9', cron: '* * * * *' },
    });
    expect(turnOps('t2', tx.getItems()).origin).toEqual({
      kind: 'task',
      taskId: 'bash-1',
      payload: { kind: 'task', taskId: 'bash-1', status: 'completed', notificationId: 'n1' },
    });
  });

  it('treats subagent.started/failed/suspended within the running→failed vocabulary', () => {
    const projector = new AgentTranscriptProjector('main');
    const tx = new AgentTranscript('main');
    const feed = (event: DomainEvent): void => void tx.apply(projector.map(event));

    feed(ev({ type: 'subagent.started', subagentId: 'agent-1' }));
    expect(tx.getTask('agent-1')).toMatchObject({ kind: 'subagent', state: 'running' });
    // Suspension stays 'running' with the reason carried on the task.
    feed(ev({ type: 'subagent.suspended', subagentId: 'agent-1', reason: 'approval' }));
    expect(tx.getTask('agent-1')).toMatchObject({ state: 'running', stateReason: 'approval' });
    feed(ev({ type: 'subagent.failed', subagentId: 'agent-1', error: 'boom' }));
    expect(tx.getTask('agent-1')).toMatchObject({ state: 'failed', error: 'boom' });

    // Completion carries the result summary and the run's token usage.
    feed(
      ev({
        type: 'subagent.completed',
        subagentId: 'agent-2',
        resultSummary: 'found 3 files',
        usage: { inputOther: 10, output: 5, inputCacheRead: 2, inputCacheCreation: 1 },
      }),
    );
    expect(tx.getTask('agent-2')).toMatchObject({
      state: 'completed',
      resultSummary: 'found 3 files',
      usage: { inputOther: 10, output: 5, inputCacheRead: 2, inputCacheCreation: 1 },
    });
  });
});

describe('AgentTranscript transcript task vocabulary', () => {
  it('documents the task states used by the projector', () => {
    const states: Array<TranscriptTask['state']> = [
      'running',
      'completed',
      'failed',
      'timed_out',
      'killed',
      'lost',
    ];
    expect(states).toHaveLength(6);
  });
});

describe('bindSessionTranscript', () => {
  class FakeBus {
    private readonly handlers = new Set<(event: DomainEvent) => void>();
    subscribe(cb: (event: DomainEvent) => void): { dispose: () => void } {
      this.handlers.add(cb);
      return { dispose: () => this.handlers.delete(cb) };
    }
    emit(event: DomainEvent): void {
      for (const cb of this.handlers) cb(event);
    }
  }

  interface FakeAgentHandle {
    readonly id: string;
    readonly bus: FakeBus;
    readonly accessor: { get: (token: unknown) => unknown };
  }

  class FakeAgents {
    private readonly handles = new Map<string, FakeAgentHandle>();
    private readonly createHandlers = new Set<(handle: FakeAgentHandle) => void>();
    private readonly disposeHandlers = new Set<(agentId: string) => void>();
    list(): FakeAgentHandle[] {
      return [...this.handles.values()];
    }
    get(id: string): FakeAgentHandle | undefined {
      return this.handles.get(id);
    }
    onDidCreate(cb: (handle: FakeAgentHandle) => void): { dispose: () => void } {
      this.createHandlers.add(cb);
      return { dispose: () => this.createHandlers.delete(cb) };
    }
    onDidDispose(cb: (agentId: string) => void): { dispose: () => void } {
      this.disposeHandlers.add(cb);
      return { dispose: () => this.disposeHandlers.delete(cb) };
    }
    add(id: string, opts?: { loopStatus?: unknown }): FakeAgentHandle {
      const bus = new FakeBus();
      const handle: FakeAgentHandle = {
        id,
        bus,
        accessor: {
          get: (token: unknown) => {
            if (token === IEventBus) return bus;
            if (token === IAgentLoopService) {
              return { status: () => opts?.loopStatus ?? { state: 'idle' } };
            }
            return undefined;
          },
        },
      };
      this.handles.set(id, handle);
      for (const cb of this.createHandlers) cb(handle);
      return handle;
    }
    remove(id: string): void {
      this.handles.delete(id);
      for (const cb of this.disposeHandlers) cb(id);
    }
  }

  function fakeSession(
    interactions: SessionInteractionService,
    agents?: FakeAgents,
  ): ISessionScopeHandle {
    return {
      accessor: {
        get: (token: unknown) => {
          if (token === IAgentLifecycleService) {
            return (
              agents ?? {
                list: () => [],
                onDidCreate: () => ({ dispose: () => undefined }),
                onDidDispose: () => ({ dispose: () => undefined }),
              }
            );
          }
          if (token === ISessionInteractionService) return interactions;
          if (token === ISessionMetadata) return { read: async () => ({ agents: {} }) };
          return undefined;
        },
      },
    } as unknown as ISessionScopeHandle;
  }

  it('registers pre-bind pendings without frames and replays an early resolve at seed time', () => {
    const interactions = new SessionInteractionService();
    interactions.enqueue({
      id: 'apr-1',
      kind: 'approval',
      payload: { toolCallId: 'call_1' },
      origin: { agentId: 'main', turnId: 0 },
    });

    const store = new TranscriptStore('s1');
    const ops: TranscriptOperation[] = [];
    const binding = bindSessionTranscript(store, fakeSession(interactions), undefined, (event) =>
      ops.push(...event.ops),
    );

    // The pending is registered (so resolves route) but nothing is announced
    // before the post-backfill seed.
    expect(ops).toHaveLength(0);

    // The user answers before the seed: captured for replay, not dropped.
    interactions.respond('apr-1', { decision: 'approved' });
    expect(ops).toHaveLength(0);

    binding.seedPendingInteractions();
    const states = ops
      .filter((op): op is InteractionUpsertOp => op.op === 'interaction.upsert')
      .map((op) => op.interaction.state);
    expect(states).toEqual(['pending', 'approved']);
    binding.dispose();
  });

  it('keeps the materialized transcript and roster entry when an agent is disposed', () => {
    const agents = new FakeAgents();
    const store = new TranscriptStore('s1');
    const binding = bindSessionTranscript(
      store,
      fakeSession(new SessionInteractionService(), agents),
    );

    const sub = agents.add('sub-1');
    agents.add('main');
    sub.bus.emit(ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' }, prompt: 'scan' }));
    sub.bus.emit(ev({ type: 'turn.ended', turnId: 0, reason: 'completed' }));
    expect(store.getAgent('sub-1')?.getItems()).toHaveLength(1);

    // Disposal kills the projector but must not drop already-served history:
    // the service's backfill cache dedupes per agent, so removing the
    // transcript would rebuild an empty shell on the next read. The roster
    // entry stays and carries its end timestamp so REST / fresh-reset
    // consumers can tell the dead agent from a live one.
    agents.remove('sub-1');
    expect(store.getAgent('sub-1')?.getItems()).toHaveLength(1);
    const descriptor = store.agents().find((a) => a.agentId === 'sub-1');
    expect(descriptor).toBeDefined();
    expect(typeof descriptor?.disposedAt).toBe('string');
    expect(store.agents().find((a) => a.agentId === 'main')?.disposedAt).toBeUndefined();
    binding.dispose();
  });

  async function seedWireHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'transcript-overlay-'));
    const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
    await mkdir(wireDir, { recursive: true });
    await writeFile(
      join(wireDir, 'wire.jsonl'),
      `${JSON.stringify({
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
        time: new Date().toISOString(),
      })}\n`,
    );
    return home;
  }

  function fakeCoreWithAgents(interactions: SessionInteractionService, agents: FakeAgents): Scope {
    return {
      accessor: {
        get: (token: unknown) => {
          if (token === ISessionLifecycleService) {
            return {
              onDidCloseSession: () => ({ dispose: () => undefined }),
              onDidArchiveSession: () => ({ dispose: () => undefined }),
              get: (sid: string) => (sid === 's1' ? fakeSession(interactions, agents) : undefined),
            };
          }
          if (token === ISessionIndex) return { get: async () => ({ workspaceId: 'ws' }) };
          return undefined;
        },
      },
    } as unknown as Scope;
  }

  it('stops projecting for an agent once it is disposed', () => {
    const agents = new FakeAgents();
    const store = new TranscriptStore('s1');
    const binding = bindSessionTranscript(
      store,
      fakeSession(new SessionInteractionService(), agents),
    );

    const sub = agents.add('sub-1');
    sub.bus.emit(ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' }, prompt: 'scan' }));
    expect(store.getAgent('sub-1')?.getItems()).toHaveLength(1);

    agents.remove('sub-1');
    // The agent's subscriptions are disposed with it — late events from the
    // dying scope must not project into the store.
    sub.bus.emit(ev({ type: 'turn.ended', turnId: 0, reason: 'completed' }));
    expect(store.getAgent('sub-1')?.getItems()[0]).toMatchObject({ kind: 'turn', state: 'running' });
    binding.dispose();
  });

  it('heals a kind-mismatched frame instead of skipping it on length', () => {
    const snapshotTurn: TranscriptTurn = {
      kind: 'turn',
      turnId: 't0',
      ordinal: 0,
      state: 'completed',
      origin: { kind: 'user' },
      steps: [
        {
          kind: 'step',
          stepId: 't0.1',
          turnId: 't0',
          ordinal: 1,
          state: 'completed',
          frames: [
            { kind: 'thinking', frameId: 't0.1.f1', text: 'hmm' },
            { kind: 'text', frameId: 't0.1.f2', role: 'assistant', text: 'Hello world' },
          ],
        },
      ],
    };
    // The projector attached mid-turn and guessed f1's kind wrong (the
    // thinking stream was missed); its longer text must NOT shield the real
    // thinking frame from the heal.
    const liveTurn: TranscriptTurn = {
      kind: 'turn',
      turnId: 't0',
      ordinal: 0,
      state: 'completed',
      origin: { kind: 'user' },
      steps: [
        {
          kind: 'step',
          stepId: 't0.1',
          turnId: 't0',
          ordinal: 1,
          state: 'completed',
          frames: [{ kind: 'text', frameId: 't0.1.f1', role: 'assistant', text: 'world' }],
        },
      ],
    };

    const frames = healTurnOps(snapshotTurn, liveTurn)
      .filter((op): op is FrameUpsertOp => op.op === 'frame.upsert')
      .map((op) => op.frame);
    expect(frames).toContainEqual(expect.objectContaining({ kind: 'thinking', frameId: 't0.1.f1', text: 'hmm' }));
    expect(frames).toContainEqual(expect.objectContaining({ kind: 'text', frameId: 't0.1.f2', text: 'Hello world' }));
  });

  it('heals missing tool frames and missed results, keeps richer live ones', () => {
    const makeTurn = (frames: TranscriptTurn['steps'][number]['frames']): TranscriptTurn => ({
      kind: 'turn',
      turnId: 't0',
      ordinal: 0,
      state: 'completed',
      origin: { kind: 'user' },
      steps: [
        { kind: 'step', stepId: 't0.1', turnId: 't0', ordinal: 1, state: 'completed', frames },
      ],
    });
    const snapshotTurn = makeTurn([
      { kind: 'tool', frameId: 't0.1.call_1', toolCallId: 'call_1', name: 'Bash', state: 'done', input: { command: 'ls' }, output: 'a.txt' },
      { kind: 'tool', frameId: 't0.1.call_2', toolCallId: 'call_2', name: 'Read', state: 'done', input: {}, output: 'x' },
      { kind: 'tool', frameId: 't0.1.call_3', toolCallId: 'call_3', name: 'Bash', state: 'done', input: {}, output: 'y' },
    ]);
    const liveTurn = makeTurn([
      // Result missed in the attach race — the heal must fill it, keeping
      // the live-only display payload.
      { kind: 'tool', frameId: 't0.1.call_1', toolCallId: 'call_1', name: 'Bash', state: 'running', input: { command: 'ls' }, display: { kind: 'command', command: 'ls' } },
      // Already resolved live — the heal must not touch it.
      { kind: 'tool', frameId: 't0.1.call_2', toolCallId: 'call_2', name: 'Read', state: 'done', input: {}, output: 'live-out' },
    ]);

    const frames = healTurnOps(snapshotTurn, liveTurn)
      .filter((op): op is FrameUpsertOp => op.op === 'frame.upsert')
      .map((op) => op.frame);
    expect(frames).toHaveLength(2);
    expect(frames).toContainEqual(
      expect.objectContaining({
        frameId: 't0.1.call_1',
        state: 'done',
        output: 'a.txt',
        display: { kind: 'command', command: 'ls' },
      }),
    );
    expect(frames).toContainEqual(expect.objectContaining({ frameId: 't0.1.call_3', output: 'y' }));
  });

  it('seeds pending interactions per agent, not before that agent is backfilled', () => {
    const interactions = new SessionInteractionService();
    interactions.enqueue({ id: 'q-main', kind: 'question', payload: { toolCallId: 'call_main' }, origin: { agentId: 'main', turnId: 0 } });
    interactions.enqueue({ id: 'q-sub', kind: 'question', payload: { toolCallId: 'call_sub' }, origin: { agentId: 'sub-1', turnId: 0 } });

    const store = new TranscriptStore('s1');
    const byAgent = new Map<string, TranscriptOperation[]>();
    const binding = bindSessionTranscript(store, fakeSession(interactions), undefined, (event) => {
      byAgent.set(event.agentId, [...(byAgent.get(event.agentId) ?? []), ...event.ops]);
    });

    // A main-scoped seed announces only main-owned pendings; the subagent's
    // waits for its own backfill.
    binding.seedPendingInteractions('main');
    expect([...byAgent.keys()]).toEqual(['main']);

    binding.seedPendingInteractions('sub-1');
    expect([...byAgent.keys()].toSorted()).toEqual(['main', 'sub-1']);
    binding.dispose();
  });

  it('defers pendings created before their owning agent is seeded', () => {
    const interactions = new SessionInteractionService();
    const store = new TranscriptStore('s1');
    const byAgent = new Map<string, TranscriptOperation[]>();
    const binding = bindSessionTranscript(store, fakeSession(interactions), undefined, (event) => {
      byAgent.set(event.agentId, [...(byAgent.get(event.agentId) ?? []), ...event.ops]);
    });

    // Created live, but during the backfill window (no seed has run yet):
    // announcing now would misplace it into a synthetic step for good.
    interactions.enqueue({ id: 'q-sub', kind: 'question', payload: { toolCallId: 'call_sub' }, origin: { agentId: 'sub-1', turnId: 0 } });
    expect(byAgent.size).toBe(0);

    binding.seedPendingInteractions('main');
    expect(byAgent.size).toBe(0);

    binding.seedPendingInteractions('sub-1');
    expect([...byAgent.keys()]).toEqual(['sub-1']);
    binding.dispose();
  });

  it('announces pendings from live-created agents immediately (their projector is complete)', () => {
    const agents = new FakeAgents();
    const interactions = new SessionInteractionService();
    const store = new TranscriptStore('s1');
    const byAgent = new Map<string, TranscriptOperation[]>();
    const binding = bindSessionTranscript(store, fakeSession(interactions, agents), undefined, (event) => {
      byAgent.set(event.agentId, [...(byAgent.get(event.agentId) ?? []), ...event.ops]);
    });

    // Created AFTER binding: fully live-covered by its projector, so its
    // pendings announce without waiting for any backfill.
    agents.add('sub-1');
    interactions.enqueue({ id: 'q1', kind: 'question', payload: { toolCallId: 'call_q1' }, origin: { agentId: 'sub-1', turnId: 0 } });
    expect([...byAgent.keys()]).toEqual(['sub-1']);
    binding.dispose();
  });

  async function seedWireHomeWithTool(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'transcript-backfill-live-'));
    const wireDir = join(home, 'sessions', 'ws', 's1', 'agents', 'main');
    await mkdir(wireDir, { recursive: true });
    const records = [
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
        time: new Date().toISOString(),
      },
      {
        type: 'context.append_message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello ' }],
          toolCalls: [{ type: 'function', id: 'call_1', name: 'Bash', arguments: '{"command":"ls"}' }],
        },
        time: new Date().toISOString(),
      },
      {
        type: 'context.append_message',
        message: {
          role: 'tool',
          content: [{ type: 'text', text: 'a.txt' }],
          toolCallId: 'call_1',
          toolCalls: [],
        },
        time: new Date().toISOString(),
      },
    ];
    await writeFile(join(wireDir, 'wire.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
    return home;
  }

  it('subscribes the bus for an agent whose projector was seeded before its handle existed', () => {
    const agents = new FakeAgents();
    const interactions = new SessionInteractionService();
    interactions.enqueue({ id: 'q-sub', kind: 'question', payload: { toolCallId: 'call_sub' }, origin: { agentId: 'sub-1', turnId: 0 } });
    const store = new TranscriptStore('s1');
    const byAgent = new Map<string, TranscriptOperation[]>();
    const binding = bindSessionTranscript(store, fakeSession(interactions, agents), undefined, (event) => {
      byAgent.set(event.agentId, [...(byAgent.get(event.agentId) ?? []), ...event.ops]);
    });

    // Seeding creates the projector WITHOUT a lifecycle handle — no bus
    // subscription can exist yet. (One op: the entity upsert.)
    binding.seedPendingInteractions('sub-1');
    expect(byAgent.get('sub-1')?.map((op) => op.op)).toEqual(['interaction.upsert']);

    // The agent materializes later: it must still get its live subscription
    // (guarding on the projector's existence would drop every live event).
    const sub = agents.add('sub-1');
    sub.bus.emit(ev({ type: 'turn.started', turnId: 1, origin: { kind: 'user' } }));
    expect(byAgent.get('sub-1')!.length).toBeGreaterThan(1);
    binding.dispose();
  });

  it('overlays the in-flight turn as running after a backfill', async () => {
    const home = await seedWireHome();
    try {
      const agents = new FakeAgents();
      agents.add('main', { loopStatus: { state: 'running', activeTurnId: 0 } });
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(), agents),
      });
      const store = service.forSessionLive('s1');
      await service.whenReady('s1');
      // The cold rebuild marked the turn completed; the overlay restores the
      // in-flight state and keeps the snapshot's prompt.
      expect(store?.getAgent('main')?.getTurn('t0')).toMatchObject({
        state: 'running',
        prompt: 'hi',
      });
      service.dropSession('s1');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('merges the backfill live-first: live frame fields and longer text survive', async () => {
    const home = await seedWireHomeWithTool();
    try {
      const agents = new FakeAgents();
      agents.add('main', { loopStatus: { state: 'running', activeTurnId: 0 } });
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(), agents),
      });
      const store = service.forSessionLive('s1');
      // Live events land while the backfill is still reading from disk.
      const bus = agents.get('main')!.bus;
      bus.emit(ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' }, prompt: 'hi' }));
      bus.emit(ev({ type: 'turn.step.started', turnId: 0, step: 1 }));
      bus.emit(ev({ type: 'assistant.delta', turnId: 0, delta: 'Hello world' }));
      bus.emit(
        ev({
          type: 'tool.call.started',
          turnId: 0,
          toolCallId: 'call_1',
          name: 'Bash',
          args: { command: 'ls' },
          display: { kind: 'command', command: 'ls' },
        }),
      );
      await service.whenReady('s1');

      const turn = store?.getAgent('main')?.getTurn('t0');
      expect(turn?.state).toBe('running');
      // The longer live text must not be replaced by the staler persisted one.
      const text = turn?.steps[0]?.frames.find((f) => f.kind === 'text');
      expect(text).toMatchObject({ text: 'Hello world' });
      // The live-only display survives; the persisted outcome heals on top.
      const tool = turn?.steps[0]?.frames.find((f) => f.kind === 'tool');
      expect(tool).toMatchObject({
        state: 'done',
        output: 'a.txt',
        display: { kind: 'command', command: 'ls' },
      });
      service.dropSession('s1');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('re-asserts running when the backfill rebuilds the live turn completed', async () => {
    const home = await seedWireHome();
    try {
      const agents = new FakeAgents();
      agents.add('main', { loopStatus: { state: 'running', activeTurnId: 0 } });
      const service = new TranscriptService({
        homeDir: home,
        core: fakeCoreWithAgents(new SessionInteractionService(), agents),
      });
      const store = service.forSessionLive('s1');
      // The projector writes the live running header before the disk backfill
      // lands; the snapshot's cold 'completed' header must not win.
      agents
        .get('main')!
        .bus.emit(ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' }, prompt: 'live hi' }));
      await service.whenReady('s1');
      expect(store?.getAgent('main')?.getTurn('t0')).toMatchObject({
        state: 'running',
        prompt: 'live hi',
      });
      service.dropSession('s1');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  describe('op journal', () => {
    it('assigns consecutive per-agent seqs and serves catch-up from the journal', async () => {
      const agents = new FakeAgents();
      const main = agents.add('main');
      const service = new TranscriptService({
        homeDir: '/nonexistent-home',
        core: fakeCoreWithAgents(new SessionInteractionService(), agents),
      });
      service.forSessionLive('s1');
      await service.whenReady('s1');
      // The backfill dispatch is the first journaled batch for main; measure
      // everything relative to it.
      const base = service.getSeqWatermark('s1', 'main');

      const seen: number[] = [];
      service.onSessionOps('s1', (_event, seq) => seen.push(seq));
      main.bus.emit(ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' } }));
      main.bus.emit(ev({ type: 'turn.ended', turnId: 0, reason: 'completed' }));

      expect(seen).toEqual([base + 1, base + 2]);
      expect(service.getSeqWatermark('s1', 'main')).toBe(base + 2);

      // Complete catch-up: exactly the batches past the cursor, ascending.
      const catchup = service.getOpsSince('s1', 'main', base);
      expect(catchup?.complete).toBe(true);
      expect(catchup?.latestSeq).toBe(base + 2);
      expect(catchup?.batches.map((batch) => batch.seq)).toEqual([base + 1, base + 2]);

      // An up-to-date cursor replays nothing but is still complete.
      expect(service.getOpsSince('s1', 'main', base + 2)).toMatchObject({
        batches: [],
        latestSeq: base + 2,
        complete: true,
      });
      // A cursor ahead of the watermark belongs to a dead journal
      // incarnation — the server cannot vouch for it.
      expect(service.getOpsSince('s1', 'main', base + 3)?.complete).toBe(false);

      // Seqs are per agent: a late agent starts its own counter at 1 (no
      // backfill batch precedes its live ops).
      const sub = agents.add('sub-1');
      sub.bus.emit(ev({ type: 'turn.started', turnId: 0, origin: { kind: 'user' } }));
      expect(service.getSeqWatermark('s1', 'sub-1')).toBe(1);
      expect(service.getOpsSince('s1', 'sub-1', 0)?.batches.map((batch) => batch.seq)).toEqual([1]);

      // Unknown agent / cold session: watermark 0, no journal at all.
      expect(service.getSeqWatermark('s1', 'nope')).toBe(0);
      expect(service.getOpsSince('nope-session', 'main', 0)).toBeUndefined();
      service.dropSession('s1');
    });

    it('marks catch-up incomplete once the bounded journal evicts old batches', async () => {
      const agents = new FakeAgents();
      const main = agents.add('main');
      const service = new TranscriptService({
        homeDir: '/nonexistent-home',
        core: fakeCoreWithAgents(new SessionInteractionService(), agents),
      });
      service.forSessionLive('s1');
      await service.whenReady('s1');
      const base = service.getSeqWatermark('s1', 'main');

      for (let turnId = 1; turnId <= TRANSCRIPT_OPS_JOURNAL_CAPACITY + 1; turnId++) {
        main.bus.emit(ev({ type: 'turn.started', turnId, origin: { kind: 'user' } }));
      }
      const watermark = service.getSeqWatermark('s1', 'main');
      expect(watermark).toBe(base + TRANSCRIPT_OPS_JOURNAL_CAPACITY + 1);

      // The oldest batches evicted: a cursor at the former base is no longer
      // covered.
      const evicted = service.getOpsSince('s1', 'main', base);
      expect(evicted?.complete).toBe(false);
      expect(evicted?.latestSeq).toBe(watermark);
      expect(evicted?.batches).toHaveLength(TRANSCRIPT_OPS_JOURNAL_CAPACITY);

      // A recent cursor is still fully covered.
      const recent = service.getOpsSince('s1', 'main', watermark - 10);
      expect(recent?.complete).toBe(true);
      expect(recent?.batches.map((batch) => batch.seq)).toEqual(
        Array.from({ length: 10 }, (_, i) => watermark - 9 + i),
      );
      service.dropSession('s1');
    });
  });
});
