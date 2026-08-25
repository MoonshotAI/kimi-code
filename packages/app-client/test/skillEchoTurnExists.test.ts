import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '@moonshot-ai/app-core/transcript';

import { skillEchoMatchedIds, skillEchoTurnExists, skillMarkerExists } from '../src/client/useKimiWebClient';

function skillTurn(turnId: string, skillName: string, skillArgs?: string, wrapPayload = false): TranscriptItem {
  const origin = wrapPayload
    ? { kind: 'skill_activation', payload: { kind: 'skill_activation', skillName, skillArgs } }
    : { kind: 'skill_activation', skillName, skillArgs };
  return {
    kind: 'turn',
    turnId,
    ordinal: 0,
    state: 'completed',
    origin,
    steps: [],
  } as unknown as TranscriptItem;
}

describe('skillEchoTurnExists', () => {
  const history = [
    skillTurn('t1', 'review', 'src'),
    skillTurn('t2', 'review', 'src'),
    skillTurn('t3', 'review', 'docs'),
  ];

  it('matches a same-name-and-args skill turn when no anchor is stamped', () => {
    expect(skillEchoTurnExists(history, undefined, 'review', 'src')).toBe(true);
    expect(skillEchoTurnExists(history, undefined, 'review', 'docs')).toBe(true);
  });

  it('ignores a historical same-skill turn before the submit-time anchor', () => {
    expect(skillEchoTurnExists(history, 't2', 'review', 'src')).toBe(false);
  });

  it('matches an echo that lands after the anchor', () => {
    expect(skillEchoTurnExists(history, 't1', 'review', 'src')).toBe(true);
  });

  it('requires args to match — another client\'s different-args turn is not the echo', () => {
    expect(skillEchoTurnExists(history, 't1', 'review', 'other')).toBe(false);
  });

  it('treats a rewound anchor (undo/reset) as uncovered', () => {
    expect(skillEchoTurnExists(history, 't9', 'review', 'src')).toBe(false);
  });

  it('sees payload-wrapped skill origins too', () => {
    const items = [skillTurn('t1', 'review', 'src', true)];
    expect(skillEchoTurnExists(items, undefined, 'review', 'src')).toBe(true);
  });
});


function userTurn(turnId: string): TranscriptItem {
  return {
    kind: 'turn',
    turnId,
    ordinal: 0,
    state: 'completed',
    origin: { kind: 'user' },
    steps: [],
  } as unknown as TranscriptItem;
}

function skillMarker(markerId: string, skillName: string, skillArgs?: string): TranscriptItem {
  return {
    kind: 'marker',
    markerId,
    marker: 'skill',
    payload: {
      text: 'rendered block',
      origin: { kind: 'skill_activation', trigger: 'user-slash', skillName, skillArgs },
    },
  } as unknown as TranscriptItem;
}

describe('skillMarkerExists', () => {
  it('attributes a hook-blocked skill via its persisted marker after the anchor', () => {
    const items = [userTurn('t1'), skillMarker('m1', 'review', 'src')];
    expect(skillMarkerExists(items, 't1', 'review', 'src')).toBe(true);
  });

  it('ignores a marker from an earlier same-skill activation before the anchor', () => {
    const items = [skillMarker('m1', 'review', 'src'), userTurn('t1')];
    expect(skillMarkerExists(items, 't1', 'review', 'src')).toBe(false);
  });

  it('requires name and args to match', () => {
    const items = [userTurn('t1'), skillMarker('m1', 'review', 'docs')];
    expect(skillMarkerExists(items, 't1', 'review', 'src')).toBe(false);
  });

  it('treats a rewound anchor as unblocked history (no attribution)', () => {
    const items = [skillMarker('m1', 'review', 'src')];
    expect(skillMarkerExists(items, 't9', 'review', 'src')).toBe(false);
  });

  it('requires the marker to postdate the submit-time prompt watermark', () => {
    // An identical re-activation shares the anchor turn: the OLD marker must
    // not retire the NEW uncertain bubble before its request was ever seen.
    const stamped = (markerId: string, at: string): TranscriptItem =>
      ({
        kind: 'marker',
        markerId,
        marker: 'skill',
        payload: {
          origin: { kind: 'skill_activation', skillName: 'review', skillArgs: 'src' },
        },
        at,
      }) as unknown as TranscriptItem;
    const floor = '2026-08-24T10:00:00.000Z';
    // Old marker at/before the watermark: belongs to the previous activation.
    expect(
      skillMarkerExists([stamped('m1', '2026-08-24T09:59:00.000Z')], undefined, 'review', 'src', floor),
    ).toBe(false);
    expect(
      skillMarkerExists([stamped('m1', floor)], undefined, 'review', 'src', floor),
    ).toBe(false);
    // A marker strictly newer than the watermark is THIS activation's.
    expect(
      skillMarkerExists([stamped('m1', '2026-08-24T10:00:01.000Z')], undefined, 'review', 'src', floor),
    ).toBe(true);
    // An unstamped marker can't prove its era — never let it retire a floored
    // bubble.
    expect(skillMarkerExists([skillMarker('m1', 'review', 'src')], undefined, 'review', 'src', floor)).toBe(
      false,
    );
  });
});

describe('skillEchoMatchedIds', () => {
  const bubble = (id: string) => ({
    id,
    anchorTurnId: undefined as string | undefined,
    promptFloor: undefined as string | undefined,
    skillName: 'review',
    skillArgs: 'src',
  });

  it('pairs identical skill bubbles with distinct echo entities in order', () => {
    const items = [skillTurn('t1', 'review', 'src'), skillTurn('t2', 'review', 'src')];
    const matched = skillEchoMatchedIds([bubble('m1'), bubble('m2')], items);
    expect(matched).toEqual(
      new Map([
        ['m1', 't1'],
        ['m2', 't2'],
      ]),
    );
  });

  it('retires only the first bubble when just one echo entity exists', () => {
    const items = [skillTurn('t1', 'review', 'src')];
    const matched = skillEchoMatchedIds([bubble('m1'), bubble('m2')], items);
    expect(matched).toEqual(new Map([['m1', 't1']]));
  });

  it('never re-consumes an echo entity a previous frame already bound', () => {
    const items = [skillTurn('t1', 'review', 'src')];
    const frame1 = skillEchoMatchedIds([bubble('m1'), bubble('m2')], items);
    expect(frame1).toEqual(new Map([['m1', 't1']]));
    const frame2 = skillEchoMatchedIds([bubble('m2')], items, new Set(frame1.values()));
    expect(frame2.size).toBe(0);
  });

  it('pairs a blocked activation’s marker, floored like skillMarkerExists', () => {
    const marker = {
      kind: 'marker',
      markerId: 'mk1',
      marker: 'skill',
      payload: { origin: { kind: 'skill_activation', skillName: 'review', skillArgs: 'src' } },
      at: '2026-08-24T10:00:01.000Z',
    } as unknown as TranscriptItem;
    const floor = '2026-08-24T10:00:00.000Z';
    const matched = skillEchoMatchedIds(
      [{ ...bubble('m1'), promptFloor: floor }],
      [marker],
    );
    expect(matched).toEqual(new Map([['m1', 'mk1']]));
    // The same marker before the floor belongs to the previous activation.
    const old = { ...marker, at: '2026-08-24T09:59:00.000Z' } as TranscriptItem;
    expect(skillEchoMatchedIds([{ ...bubble('m1'), promptFloor: floor }], [old]).size).toBe(0);
  });

  it('skips a bubble whose anchor turn was rewound', () => {
    const items = [skillTurn('t1', 'review', 'src')];
    const matched = skillEchoMatchedIds(
      [{ ...bubble('m1'), anchorTurnId: 't-gone' }],
      items,
    );
    expect(matched.size).toBe(0);
  });
});
