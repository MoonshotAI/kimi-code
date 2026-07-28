import { describe, expect, it } from 'vitest';
import type { AgentTranscriptSnapshot } from '@moonshot-ai/web-core/transcript';

import { auxiliaryTranscriptToTurns } from '../../src/renderer/lib/auxiliaryTranscriptToTurns';

describe('auxiliaryTranscriptToTurns', () => {
  it('renders a subagent prompt, thinking, tools, final text, and duration through ChatPane turns', () => {
    const turns = auxiliaryTranscriptToTurns(snapshot());

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

  it('uses the first step timestamp when a live turn header has no start time', () => {
    const input = snapshot();
    const source = input.items[0];
    if (source?.kind !== 'turn') throw new Error('expected turn fixture');
    const turns = auxiliaryTranscriptToTurns({
      ...input,
      items: [{
        ...source,
        state: 'running',
        startedAt: undefined,
        endedAt: undefined,
        durationMs: undefined,
        steps: source.steps.map((step) => ({
          ...step,
          state: 'running',
          startedAt: '2026-07-27T00:00:01.000Z',
          endedAt: undefined,
        })),
      }],
      meta: { activity: 'turn' },
    });

    expect(turns[0]?.createdAt).toBe('2026-07-27T00:00:01.000Z');
    expect(turns[1]?.createdAt).toBe('2026-07-27T00:00:01.000Z');
  });

  it('leaves live timing unknown when neither the turn nor its steps have a timestamp', () => {
    const input = snapshot();
    const source = input.items[0];
    if (source?.kind !== 'turn') throw new Error('expected turn fixture');
    const turns = auxiliaryTranscriptToTurns({
      ...input,
      items: [{
        ...source,
        state: 'running',
        startedAt: undefined,
        endedAt: undefined,
        durationMs: undefined,
        steps: source.steps.map((step) => ({
          ...step,
          state: 'running',
          startedAt: undefined,
          endedAt: undefined,
        })),
      }],
      meta: { activity: 'turn' },
    });

    expect(turns[0]?.createdAt).toBeUndefined();
    expect(turns[1]?.createdAt).toBeUndefined();
    expect(turns[1]?.durationMs).toBeUndefined();
  });

  it('uses agent lifecycle timestamps for a legacy single-turn transcript', () => {
    const input = snapshot();
    const source = input.items[0];
    if (source?.kind !== 'turn') throw new Error('expected turn fixture');
    const turns = auxiliaryTranscriptToTurns(
      {
        ...input,
        items: [{
          ...source,
          startedAt: undefined,
          endedAt: undefined,
          durationMs: undefined,
          steps: source.steps.map((step) => ({
            ...step,
            startedAt: undefined,
            endedAt: undefined,
          })),
        }],
      },
      undefined,
      {
        createdAt: '2026-07-27T00:00:01.000Z',
        disposedAt: '2026-07-27T00:00:06.000Z',
      },
    );

    expect(turns[1]).toMatchObject({
      createdAt: '2026-07-27T00:00:01.000Z',
      durationMs: 5000,
    });
  });

  it('keeps a tool with partial output running until its frame becomes terminal', () => {
    const input = snapshot();
    const source = input.items[0];
    if (source?.kind !== 'turn') throw new Error('expected turn fixture');
    const turns = auxiliaryTranscriptToTurns({
      ...input,
      items: [{
        ...source,
        state: 'running',
        endedAt: undefined,
        durationMs: undefined,
        steps: source.steps.map((step) => ({
          ...step,
          state: 'running',
          endedAt: undefined,
          frames: step.frames.map((frame) =>
            frame.kind === 'tool'
              ? { ...frame, state: 'running', output: 'Scanned 12 files' }
              : frame,
          ),
        })),
      }],
      meta: { activity: 'turn' },
    });

    expect(turns[1]?.tools?.[0]).toMatchObject({
      id: 'call-1',
      status: 'running',
      output: ['Scanned 12 files'],
    });
  });

  it('renders a cold task notification prompt through the shared notification card path', () => {
    const input = snapshot();
    const source = input.items[0];
    if (source?.kind !== 'turn') throw new Error('expected turn fixture');
    const turns = auxiliaryTranscriptToTurns({
      ...input,
      items: [{
        ...source,
        origin: {
          kind: 'task',
          taskId: 'bash-1',
          payload: { kind: 'task', taskId: 'bash-1' },
        },
        prompt: [
          '<notification id="task:bash-1:completed" category="task" type="task.completed" source_kind="background_task" source_id="bash-1">',
          'Title: Background process completed',
          'Severity: info',
          'lint completed.',
          '</notification>',
        ].join('\n'),
        steps: [],
      }],
    });

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ role: 'assistant', text: '' });
    expect(turns[0]?.blocks).toEqual([
      expect.objectContaining({
        kind: 'notification',
        notification: expect.objectContaining({
          sourceId: 'bash-1',
          type: 'task.completed',
          title: 'Background process completed',
          body: 'lint completed.',
        }),
      }),
    ]);
  });

  it('renders a live task notification frame without exposing transport markup', () => {
    const input = snapshot();
    const source = input.items[0];
    if (source?.kind !== 'turn') throw new Error('expected turn fixture');
    const step = source.steps[0];
    if (step === undefined) throw new Error('expected step fixture');
    const turns = auxiliaryTranscriptToTurns({
      ...input,
      items: [{
        ...source,
        steps: [{
          ...step,
          frames: [
            {
              kind: 'text',
              frameId: 'notification-1',
              role: 'user',
              text: 'Background process completed\nlint completed.',
              taskId: 'bash-1',
            },
            {
              kind: 'text',
              frameId: 'answer-1',
              role: 'assistant',
              text: 'The checks passed.',
            },
          ],
        }],
      }],
      tasks: [{
        taskId: 'bash-1',
        kind: 'shell',
        state: 'completed',
        detached: true,
        description: 'Run lint',
        outputTail: '',
      }],
    });

    expect(turns).toHaveLength(2);
    expect(turns[1]?.blocks).toEqual([
      expect.objectContaining({
        kind: 'notification',
        notification: expect.objectContaining({
          sourceKind: 'background_task',
          sourceId: 'bash-1',
          type: 'task.completed',
          title: 'Background process completed',
          body: 'lint completed.',
          raw: 'Background process completed\nlint completed.',
        }),
      }),
      { kind: 'text', text: 'The checks passed.' },
    ]);
  });
});

function snapshot(): AgentTranscriptSnapshot {
  return {
    items: [{
      kind: 'turn',
      turnId: 'turn-1',
      ordinal: 1,
      state: 'completed',
      origin: { kind: 'task', taskId: 'task-1' },
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
    }],
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: { activity: 'idle' },
    hasMoreOlder: false,
  };
}
