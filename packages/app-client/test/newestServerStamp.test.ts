import { describe, expect, it } from 'vitest';
import type { AgentTranscriptSnapshot, TranscriptItem } from '@moonshot-ai/app-core/transcript';

import { newestServerStamp } from '../src/client/useKimiWebClient';

function turn(turnId: string, startedAt: string, endedAt?: string): TranscriptItem {
  return {
    kind: 'turn',
    turnId,
    ordinal: 0,
    state: endedAt === undefined ? 'running' : 'completed',
    origin: { kind: 'user' },
    startedAt,
    endedAt,
    steps: [],
  } as unknown as TranscriptItem;
}

function marker(markerId: string, at: string): TranscriptItem {
  return {
    kind: 'marker',
    markerId,
    marker: 'notice',
    payload: { level: 'info' },
    at,
  } as unknown as TranscriptItem;
}

function snapshot(items: TranscriptItem[]): AgentTranscriptSnapshot {
  return {
    items,
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: {},
  } as unknown as AgentTranscriptSnapshot;
}

describe('newestServerStamp', () => {
  it('returns the newest daemon stamp walking from the tail', () => {
    expect(
      newestServerStamp(snapshot([
        turn('t1', '2026-08-24T10:00:00.000Z', '2026-08-24T10:01:00.000Z'),
        turn('t2', '2026-08-24T10:02:00.000Z'),
      ])),
    ).toBe('2026-08-24T10:02:00.000Z');
  });

  it('prefers a marker at over older turn stamps', () => {
    expect(
      newestServerStamp(snapshot([
        turn('t1', '2026-08-24T10:00:00.000Z'),
        marker('m1', '2026-08-24T10:05:00.000Z'),
      ])),
    ).toBe('2026-08-24T10:05:00.000Z');
  });

  it('is undefined for an empty snapshot', () => {
    expect(newestServerStamp(snapshot([]))).toBeUndefined();
  });

  it("prefers a later step stamp over the turn header own stamp", () => {
    const turn = {
      kind: 'turn',
      turnId: 't1',
      ordinal: 0,
      state: 'running',
      origin: { kind: 'user' },
      startedAt: '2026-08-24T10:00:00.000Z',
      steps: [
        {
          kind: 'step',
          stepId: 't1.1',
          turnId: 't1',
          ordinal: 1,
          state: 'completed',
          startedAt: '2026-08-24T10:01:00.000Z',
          endedAt: '2026-08-24T10:02:00.000Z',
          frames: [],
        },
        {
          kind: 'step',
          stepId: 't1.2',
          turnId: 't1',
          ordinal: 2,
          state: 'running',
          startedAt: '2026-08-24T10:03:00.000Z',
          frames: [],
        },
      ],
    } as unknown as TranscriptItem;
    expect(newestServerStamp(snapshot([turn]))).toBe('2026-08-24T10:03:00.000Z');
  });
});
