import { describe, expect, it } from 'vitest';
import type { AgentTranscriptSnapshot, TranscriptTurn } from '../src/transcript';

import { mainTranscriptToTurns } from '../src/client/mainTranscriptToTurns';

const DEPS = { sessionId: 's1' };

describe('mainTranscriptToTurns', () => {
  it('renders prompt, thinking, tools, final text and duration like the legacy pipeline', () => {
    const turns = mainTranscriptToTurns(snapshot([baseTurn()]), DEPS);

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: 'user', text: 'Inspect the renderer' });
    expect(turns[1]).toMatchObject({
      role: 'assistant',
      thinking: 'Checking files',
      text: 'Found the cause.',
      durationMs: 4000,
    });
    expect(turns[1]?.tools).toEqual([
      expect.objectContaining({ id: 'call-1', name: 'Read', status: 'ok' }),
    ]);
  });

  it('hides a goal-continuation turn’s prompt and marks the assistant turn', () => {
    const turn: TranscriptTurn = {
      ...baseTurn(),
      origin: { kind: 'other', payload: { kind: 'system_trigger', name: 'goal_continuation' } },
      prompt: undefined,
    };
    const turns = mainTranscriptToTurns(snapshot([turn]), DEPS);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ role: 'assistant', goalContinuation: true });
  });

  it('stamps the hidden goal-continuation placeholder with the earliest step time', () => {
    const turn: TranscriptTurn = {
      ...baseTurn(),
      origin: { kind: 'other', payload: { kind: 'system_trigger', name: 'goal_continuation' } },
      prompt: undefined,
      startedAt: undefined,
      endedAt: undefined,
      steps: [{
        ...baseTurn().steps[0]!,
        startedAt: '2026-07-27T00:00:01.000Z',
        endedAt: undefined,
      }],
    };
    const turns = mainTranscriptToTurns(snapshot([turn]), DEPS);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      role: 'assistant',
      goalContinuation: true,
      createdAt: '2026-07-27T00:00:01.000Z',
    });
  });

  it('renders a cron-origin turn as a cron card', () => {
    const turn: TranscriptTurn = {
      ...baseTurn(),
      origin: { kind: 'cron', taskId: 'job-1', payload: { kind: 'cron_job', jobId: 'job-1', cron: 'job-1' } },
      prompt: 'report status',
    };
    const turns = mainTranscriptToTurns(snapshot([turn]), DEPS);

    expect(turns[0]).toMatchObject({ role: 'cron', cron: expect.objectContaining({ jobId: 'job-1' }) });
  });

  it('renders a task-origin turn’s notification as a notification block', () => {
    // A background task completing while the main agent is IDLE opens a
    // task-origin turn server-side (coreEventMap: "the turn.started path owns
    // that case") — the notification must render as a card, not vanish.
    const turn: TranscriptTurn = {
      ...baseTurn(),
      origin: { kind: 'task', taskId: 'task-9', payload: { kind: 'task', taskId: 'task-9' } },
      prompt:
        '<notification category="task" type="completed" source-kind="background" source-id="task-9" severity="info">\nTitle: Explore done\n\nfound 3 files\n</notification>',
    };
    const turns = mainTranscriptToTurns(snapshot([turn]), DEPS);

    const assistant = turns.find((t) => t.role === 'assistant');
    expect(assistant?.blocks).toContainEqual(
      expect.objectContaining({
        kind: 'notification',
        notification: expect.objectContaining({ title: 'Explore done' }),
      }),
    );
  });

  it('renders a completed compaction marker as a divider turn', () => {
    const marker = {
      kind: 'marker' as const,
      markerId: 'm1',
      marker: 'compaction',
      payload: {
        phase: 'completed',
        result: { summary: 'condensed history', tokensBefore: 9000, tokensAfter: 1200 },
      },
      at: '2026-07-27T00:00:05.000Z',
    };
    const turns = mainTranscriptToTurns(snapshot([baseTurn()], [marker]), DEPS);

    const divider = turns.find((turn) => turn.role === 'compaction');
    expect(divider).toMatchObject({
      text: 'condensed history',
      compaction: { tokensBefore: 9000, tokensAfter: 1200 },
    });
  });

  it('attaches approval cards from interaction entities to the matching tool', () => {
    const input = snapshot([baseTurn()]);
    const turns = mainTranscriptToTurns(
      {
        ...input,
        interactions: [{
          interactionId: 'ap-1',
          interactionKind: 'approval',
          toolCallId: 'call-1',
          state: 'pending',
          request: {
            toolCallId: 'call-1',
            toolName: 'Read',
            action: 'read',
            display: { kind: 'path', path: 'App.vue' },
          },
        }],
      },
      DEPS,
    );

    expect(turns[1]?.approvalId).toBe('ap-1');
    expect(turns[1]?.approval).toBeDefined();
  });

  it('maps session-media attachments onto the user turn', () => {
    const turn: TranscriptTurn = {
      ...baseTurn(),
      attachmentIds: ['att-1'],
    };
    const input = snapshot([turn]);
    const turns = mainTranscriptToTurns(
      {
        ...input,
        attachments: [{
          attachmentId: 'att-1',
          mediaType: 'image/png',
          source: { kind: 'session_media', fileId: 'f_9' },
        }],
      },
      { ...DEPS, getSessionMediaUrl: (_sid, fileId) => `media://${fileId}` },
    );

    expect(turns[0]?.attachments).toEqual([
      expect.objectContaining({ kind: 'image', fileId: 'f_9' }),
    ]);
  });

  it('keeps an attachment-only prompt as a user turn', () => {
    const turn: TranscriptTurn = {
      ...baseTurn(),
      prompt: undefined,
      attachmentIds: ['att-1'],
    };
    const input = snapshot([turn]);
    const turns = mainTranscriptToTurns(
      {
        ...input,
        attachments: [{
          attachmentId: 'att-1',
          mediaType: 'image/png',
          source: { kind: 'session_media', fileId: 'f_9' },
        }],
      },
      { ...DEPS, getSessionMediaUrl: (_sid, fileId) => `media://${fileId}` },
    );

    expect(turns[0]).toMatchObject({ role: 'user' });
    expect(turns[0]?.attachments).toEqual([
      expect.objectContaining({ kind: 'image', fileId: 'f_9' }),
    ]);
  });

  it('does not backdate a turn to the agent registration when it has real stamps', () => {
    const turns = mainTranscriptToTurns(snapshot([baseTurn()]), {
      ...DEPS,
      agentCreatedAt: '2026-07-26T00:00:00.000Z',
    });

    expect(turns[0]?.createdAt).toBe('2026-07-27T00:00:00.000Z');
  });

  it('keeps a manual compaction trigger on the divider', () => {
    const markers: AgentTranscriptSnapshot['items'] = [
      {
        kind: 'marker',
        markerId: 'm0',
        marker: 'compaction',
        payload: { phase: 'started', trigger: 'manual' },
        at: '2026-07-27T00:00:04.500Z',
      },
      {
        kind: 'marker',
        markerId: 'm1',
        marker: 'compaction',
        payload: {
          phase: 'completed',
          result: { summary: 'condensed history', tokensBefore: 9000, tokensAfter: 1200 },
        },
        at: '2026-07-27T00:00:05.000Z',
      },
    ];
    const turns = mainTranscriptToTurns(snapshot([baseTurn()], markers), DEPS);

    const divider = turns.find((turn) => turn.role === 'compaction');
    expect(divider?.compaction?.trigger).toBe('manual');
  });

  it('renders a cron.fired marker as a cron card', () => {
    const marker = {
      kind: 'marker' as const,
      markerId: 'm2',
      marker: 'cron.fired',
      payload: {
        origin: {
          kind: 'cron_job',
          jobId: 'job-7',
          cron: '*/5 * * * *',
          recurring: true,
          coalescedCount: 2,
          stale: false,
        },
        prompt: 'check the deploy',
      },
      at: '2026-07-27T00:00:06.000Z',
    };
    const turns = mainTranscriptToTurns(snapshot([baseTurn()], [marker]), DEPS);

    const cronTurn = turns.find((turn) => turn.role === 'cron');
    expect(cronTurn).toMatchObject({
      text: 'check the deploy',
      createdAt: '2026-07-27T00:00:06.000Z',
      cron: { jobId: 'job-7', cron: '*/5 * * * *', recurring: true, coalescedCount: 2, stale: false },
    });
  });

  it('pairs back-to-back cron.fired markers with their turns one-to-one', () => {
    // The same job fires twice before the first injected prompt starts: the
    // entity order interleaves as marker A, marker B, turn A, turn B. Each
    // marker must yield to its OWN turn — a synthetic card for A plus both
    // turns would show 3 cards for 2 firings.
    const cronTurnOf = (turnId: string): TranscriptTurn => ({
      ...baseTurn(),
      turnId,
      origin: { kind: 'cron', payload: { kind: 'cron_job', jobId: 'job-7' } },
      prompt: '<cron-fire job="job-7">\n<prompt>\ncheck the deploy\n</prompt>\n</cron-fire>',
    });
    const markerOf = (markerId: string) => ({
      kind: 'marker' as const,
      markerId,
      marker: 'cron.fired',
      payload: {
        origin: { kind: 'cron_job', jobId: 'job-7' },
        prompt: 'check the deploy',
      },
      at: '2026-07-27T00:00:06.000Z',
    });
    const input = snapshot([], []);
    input.items = [
      markerOf('m-a'),
      markerOf('m-b'),
      cronTurnOf('turn-a'),
      cronTurnOf('turn-b'),
    ];
    const turns = mainTranscriptToTurns(input, DEPS);

    // Exactly the two real turns as cron cards — no synthetic marker card.
    expect(turns.filter((turn) => turn.role === 'cron')).toHaveLength(2);
  });

  it('keeps a synthetic card for the later firing whose turn never starts', () => {
    // marker A, marker B, turn A (turn B never starts — blocked): A yields to
    // turn A, B renders its synthetic card.
    const cronTurn: TranscriptTurn = {
      ...baseTurn(),
      turnId: 'turn-a',
      origin: { kind: 'cron', payload: { kind: 'cron_job', jobId: 'job-7' } },
      prompt: '<cron-fire job="job-7">\n<prompt>\ncheck the deploy\n</prompt>\n</cron-fire>',
    };
    const markerOf = (markerId: string) => ({
      kind: 'marker' as const,
      markerId,
      marker: 'cron.fired',
      payload: {
        origin: { kind: 'cron_job', jobId: 'job-7' },
        prompt: 'check the deploy',
      },
      at: '2026-07-27T00:00:06.000Z',
    });
    const input = snapshot([], []);
    input.items = [markerOf('m-a'), markerOf('m-b'), cronTurn];
    const turns = mainTranscriptToTurns(input, DEPS);

    expect(turns.filter((turn) => turn.role === 'cron')).toHaveLength(2);
  });

  it('skips a cron.fired marker whose firing already renders as a cron turn', () => {
    const cronTurn: TranscriptTurn = {
      ...baseTurn(),
      turnId: 'turn-cron',
      origin: { kind: 'cron', payload: { kind: 'cron_job', jobId: 'job-7' } },
      prompt: '<cron-fire job="job-7">\n<prompt>\ncheck the deploy\n</prompt>\n</cron-fire>',
    };
    const marker = {
      kind: 'marker' as const,
      markerId: 'm2',
      marker: 'cron.fired',
      payload: {
        origin: { kind: 'cron_job', jobId: 'job-7' },
        prompt: 'check the deploy',
      },
      at: '2026-07-27T00:00:06.000Z',
    };
    // The daemon emits cron.fired BEFORE steer-injecting the turn.
    const input = snapshot([], []);
    input.items = [marker, cronTurn];
    const turns = mainTranscriptToTurns(input, DEPS);

    expect(turns.filter((turn) => turn.role === 'cron')).toHaveLength(1);
  });

  it('does not pair a firing with a later firing’s longer prompt (exact inner match)', () => {
    // Same job fires twice: the first prompt ('status') was blocked and left
    // no turn, the second ('status quo') produced a real one. A substring
    // test would pair the FIRST marker with the second turn ('status' ⊂
    // 'status quo'), erasing the first firing and duplicating the second.
    const cronTurn: TranscriptTurn = {
      ...baseTurn(),
      turnId: 'turn-b',
      origin: { kind: 'cron', payload: { kind: 'cron_job', jobId: 'job-7' } },
      prompt: '<cron-fire job="job-7">\n<prompt>\nstatus quo\n</prompt>\n</cron-fire>',
    };
    const markerOf = (markerId: string, prompt: string) => ({
      kind: 'marker' as const,
      markerId,
      marker: 'cron.fired',
      payload: {
        origin: { kind: 'cron_job', jobId: 'job-7' },
        prompt,
      },
      at: '2026-07-27T00:00:06.000Z',
    });
    const input = snapshot([], []);
    input.items = [markerOf('m-a', 'status'), markerOf('m-b', 'status quo'), cronTurn];
    const turns = mainTranscriptToTurns(input, DEPS);

    // Marker A keeps its own synthetic card ('status'); marker B yields to
    // the real turn ('status quo') — one card per firing, no duplication.
    const cronCards = turns.filter((turn) => turn.role === 'cron');
    expect(cronCards).toHaveLength(2);
    expect(cronCards.map((turn) => turn.text)).toEqual(['status', 'status quo']);
  });
});

function baseTurn(): TranscriptTurn {
  return {
    kind: 'turn',
    turnId: 'turn-1',
    ordinal: 1,
    state: 'completed',
    origin: { kind: 'user', payload: { kind: 'user' } },
    prompt: 'Inspect the renderer',
    startedAt: '2026-07-27T00:00:00.000Z',
    endedAt: '2026-07-27T00:00:04.000Z',
    steps: [{
      kind: 'step',
      stepId: 'turn-1:1',
      turnId: 'turn-1',
      ordinal: 1,
      state: 'completed',
      frames: [
        { kind: 'thinking', frameId: 'f1', text: 'Checking files' },
        {
          kind: 'tool',
          frameId: 'f2',
          toolCallId: 'call-1',
          name: 'Read',
          state: 'done',
          input: { path: 'App.vue' },
          output: 'ok',
        },
        { kind: 'text', frameId: 'f3', role: 'assistant', text: 'Found the cause.' },
      ],
    }],
  };
}

function snapshot(
  turns: TranscriptTurn[],
  markers: AgentTranscriptSnapshot['items'] = [],
): AgentTranscriptSnapshot {
  return {
    items: [...turns, ...markers],
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: { activity: 'idle' },
    hasMoreOlder: false,
  };
}
