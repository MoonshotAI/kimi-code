import { describe, expect, it } from 'vitest';
import type { TranscriptPrompt } from '@moonshot-ai/app-core/transcript';

import { anchorServerFloor, promptEchoExists, promptEchoFloor, uncertainEchoMatchedIds } from '../src/client/useKimiWebClient';

function prompt(
  promptId: string,
  status: TranscriptPrompt['status'],
  createdAt: string,
  text = 'same text',
): TranscriptPrompt {
  return {
    promptId,
    status,
    createdAt,
    content: [{ type: 'text', text }],
  } as unknown as TranscriptPrompt;
}

describe('promptEchoExists', () => {
  const submitAt = '2026-08-24T10:00:00.000Z';

  it('matches a non-queued same-text prompt created at/after the floor', () => {
    const prompts = [prompt('p1', 'running', '2026-08-24T10:00:01.000Z')];
    expect(promptEchoExists(prompts, 'same text', submitAt)).toBe(true);
  });

  it('ignores a historical same-text prompt from an earlier send', () => {
    const prompts = [prompt('p0', 'completed', '2026-08-24T09:59:00.000Z')];
    expect(promptEchoExists(prompts, 'same text', submitAt)).toBe(false);
  });

  it('applies no time filter without an anchor floor', () => {
    const prompts = [prompt('p0', 'completed', '2026-08-24T09:59:00.000Z')];
    expect(promptEchoExists(prompts, 'same text', undefined)).toBe(true);
  });

  it('derives the floor from the anchor turn in the daemon time domain', () => {
    const anchor = {
      kind: 'turn',
      turnId: 't-anchor',
      ordinal: 0,
      state: 'completed',
      origin: { kind: 'user' },
      startedAt: '2026-08-24T09:00:00.000Z',
      steps: [],
    } as unknown as Parameters<typeof anchorServerFloor>[0][number];
    expect(anchorServerFloor([anchor], 't-anchor')).toBe('2026-08-24T09:00:00.000Z');
    expect(anchorServerFloor([anchor], 't-missing')).toBeUndefined();
    expect(anchorServerFloor([anchor], undefined)).toBeUndefined();
  });

  it('ignores queued prompts — the echo counts once it actually starts', () => {
    const prompts = [prompt('p1', 'queued', '2026-08-24T10:00:01.000Z')];
    expect(promptEchoExists(prompts, 'same text', submitAt)).toBe(false);
  });

  it('requires the text to match', () => {
    const prompts = [prompt('p1', 'running', '2026-08-24T10:00:01.000Z', 'other')];
    expect(promptEchoExists(prompts, 'same text', submitAt)).toBe(false);
  });

  it('excludes the anchor prompt itself under an exclusive floor', () => {
    // The prompt anchor IS history (the newest prompt at submit time): a
    // same-stamp prompt must not match, only a strictly newer one may.
    const prompts = [
      prompt('p0', 'blocked', '2026-08-24T10:00:00.000Z'),
      prompt('p1', 'running', '2026-08-24T10:00:00.500Z'),
    ];
    expect(promptEchoExists(prompts, 'same text', submitAt, true)).toBe(true);
    expect(promptEchoExists([prompts[0]!], 'same text', submitAt, true)).toBe(false);
  });
});

describe('uncertainEchoMatchedIds', () => {
  it('pairs two identical uncertain bubbles with distinct prompts in order', () => {
    // A lost response re-sent immediately: two bubbles share text AND anchor.
    // An existence check would let ONE prompt entity cover both — retiring
    // the second while its own request may never have been observed.
    const bubbles = [
      { id: 'm1', text: 'same text', floor: undefined },
      { id: 'm2', text: 'same text', floor: undefined },
    ];
    // Only ONE echo so far (the second request is still in flight): only the
    // FIRST bubble may retire.
    const one = [prompt('p1', 'running', '2026-08-24T10:00:01.000Z')];
    expect(uncertainEchoMatchedIds(bubbles, one)).toEqual(new Map([['m1', 'p1']]));
    // Both echoes observed: both retire, first-to-first, second-to-second.
    const two = [
      prompt('p1', 'completed', '2026-08-24T10:00:01.000Z'),
      prompt('p2', 'running', '2026-08-24T10:00:02.000Z'),
    ];
    expect(uncertainEchoMatchedIds(bubbles, two)).toEqual(
      new Map([
        ['m1', 'p1'],
        ['m2', 'p2'],
      ]),
    );
  });

  it('pairs attachment-only bubbles (empty text) one-to-one too', () => {
    const bubbles = [
      { id: 'm1', text: '', floor: undefined },
      { id: 'm2', text: '', floor: undefined },
    ];
    const one = [prompt('p1', 'running', '2026-08-24T10:00:01.000Z', '')];
    expect(uncertainEchoMatchedIds(bubbles, one)).toEqual(new Map([['m1', 'p1']]));
  });

  it('respects each bubble’s own floor', () => {
    const floor = { at: '2026-08-24T10:00:00.000Z', exclusive: true };
    const bubbles = [
      { id: 'm1', text: 'same text', floor: floor as { at: string; exclusive: boolean } | undefined },
      { id: 'm2', text: 'same text', floor: undefined },
    ];
    // The only prompt is INSIDE m2's window but BEFORE m1's exclusive floor:
    // m1 stays, m2 retires.
    const prompts = [prompt('p1', 'running', '2026-08-24T09:59:30.000Z')];
    expect(uncertainEchoMatchedIds(bubbles, prompts)).toEqual(new Map([['m2', 'p1']]));
  });

  it('never re-consumes a prompt a previous frame already bound', () => {
    // Frame 1: prompt P retires bubble m1 and P's consumption is recorded.
    // Frame 2 (m1 gone): without the recorded consumption, P would now pair
    // with m2 — retiring the second send whose own request was never seen.
    const one = [prompt('p1', 'running', '2026-08-24T10:00:01.000Z')];
    const frame1 = uncertainEchoMatchedIds(
      [
        { id: 'm1', text: 'same text', floor: undefined },
        { id: 'm2', text: 'same text', floor: undefined },
      ],
      one,
    );
    expect(frame1).toEqual(new Map([['m1', 'p1']]));
    const consumed = new Set(frame1.values());
    const frame2 = uncertainEchoMatchedIds(
      [{ id: 'm2', text: 'same text', floor: undefined }],
      one,
      consumed,
    );
    expect(frame2.size).toBe(0);
  });
});

describe('promptEchoFloor', () => {
  const anchor = {
    kind: 'turn',
    turnId: 't-anchor',
    ordinal: 0,
    state: 'completed',
    origin: { kind: 'user' },
    startedAt: '2026-08-24T09:00:00.000Z',
    steps: [],
  } as unknown as Parameters<typeof anchorServerFloor>[0][number];

  it('prefers the prompt stamp (exclusive) when it is the newer anchor', () => {
    // A prompt created INSIDE the tail turn (e.g. a steer) postdates the
    // turn's startedAt — the inclusive turn floor would pass that same-turn
    // same-text prompt as this send's echo.
    const floor = promptEchoFloor([anchor], {
      'kimiWeb.anchorTurnId': 't-anchor',
      'kimiWeb.anchorPromptCreatedAt': '2026-08-24T09:30:00.000Z',
    });
    expect(floor).toEqual({ at: '2026-08-24T09:30:00.000Z', exclusive: true });
  });

  it('keeps the turn floor (inclusive) when the newest prompt predates it', () => {
    const floor = promptEchoFloor([anchor], {
      'kimiWeb.anchorTurnId': 't-anchor',
      'kimiWeb.anchorPromptCreatedAt': '2026-08-24T08:30:00.000Z',
    });
    expect(floor).toEqual({ at: '2026-08-24T09:00:00.000Z', exclusive: false });
  });

  it('falls back to the submit-time prompt stamp (exclusive) without a turn', () => {
    // A session with only blocked/aborted prompts has no turn to anchor on —
    // the prompt stamp still bounds the echo search to this send.
    const floor = promptEchoFloor([], {
      'kimiWeb.anchorPromptCreatedAt': '2026-08-24T09:30:00.000Z',
    });
    expect(floor).toEqual({ at: '2026-08-24T09:30:00.000Z', exclusive: true });
  });

  it('also falls back when the anchor turn is outside the loaded window', () => {
    const floor = promptEchoFloor([anchor], {
      'kimiWeb.anchorTurnId': 't-evicted',
      'kimiWeb.anchorPromptCreatedAt': '2026-08-24T09:30:00.000Z',
    });
    expect(floor).toEqual({ at: '2026-08-24T09:30:00.000Z', exclusive: true });
  });

  it('stays unbounded only for a session with no history at all', () => {
    expect(promptEchoFloor([], undefined)).toBeUndefined();
    expect(promptEchoFloor([], {})).toBeUndefined();
  });
});
