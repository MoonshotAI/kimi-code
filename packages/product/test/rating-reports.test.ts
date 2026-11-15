import { describe, expect, it } from 'vitest';

import { mountSessionRating, type RatingEnvironment } from '#/session-rating/node/engine';
import type { SurveyEventProperties } from '#/session-rating/node/event-properties';
import { RATING_REPORT_RETENTION_MS, SessionRatingLedger } from '#/session-rating/node/ledger';
import { DEFAULT_SURVEY_POPUP_PAYLOAD } from '#/session-rating/common/survey-popup-config';
import type { RatingReport } from '#/session-rating/common/types';

function fixture() {
  let now = 0;
  let id = 0;
  let disabled = false;
  let cooldown: number | undefined;
  const events: { sessionId: string; properties: SurveyEventProperties }[] = [];
  const ledger = new SessionRatingLedger({ telemetryDisabled: () => disabled, now: () => now });
  const environment: RatingEnvironment = {
    sessionId: 'session-a', currentModel: 'example-model',
    model: { modelId: undefined, baseUrl: undefined },
    cumulativeTokens: 100, contextTokens: 50, permissionMode: 'manual', thinkingEffort: 'high',
    busy: false, telemetryDisabled: false, ratingDisabled: false, historyUserTurnCount: 4,
  };
  const mount = () => mountSessionRating({
    ledger,
    environment: () => environment,
    config: {
      readyForEvaluation: () => true,
      payload: () => ({
        ...DEFAULT_SURVEY_POPUP_PAYLOAD,
        probability: 1, min_time_before_feedback_ms: 0, min_user_turns_before_feedback: 0,
        min_time_between_feedback_ms: 0, min_user_turns_between_feedback: 0,
        min_time_between_global_feedback_ms: 0,
      }),
    },
    cooldown: { read: () => cooldown, write: (value) => { cooldown = value; } },
    track: (_event, properties, context) => { events.push({ ...context, properties }); },
    now: () => now, wallNow: () => now, random: () => 0,
    appearanceId: () => `appearance-${++id}`,
  });
  const first = mount();
  first.observe({ kind: 'turn-started', origin: { kind: 'user' } });
  first.observe({ kind: 'turn-ended', requestId: 'trace-a' });
  expect(first.evaluate()).toEqual({ appearanceId: 'appearance-1', survey: 'session' });
  return {
    first, mount, ledger, events,
    disable: () => { disabled = true; },
    advance: (ms: number) => { now += ms; },
    report: (report: RatingReport, sessionId = 'session-a') => ledger.report(sessionId, report),
    summary: () => events.map(({ sessionId, properties }) => [
      sessionId, properties.event_type, properties.response, properties.user_turn_count,
    ]),
  };
}

const SHOWN: RatingReport = { type: 'shown', appearanceId: 'appearance-1' };
const ANSWER: RatingReport = { type: 'respond', appearanceId: 'appearance-1', response: 'good' };
const ABANDON: RatingReport = { type: 'abandon', appearanceId: 'appearance-1' };

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length === 0) return [[]];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, other) => other !== index)).map((rest) => [item, ...rest]),
  );
}

describe('session rating report ordering', () => {
  it.each(permutations([SHOWN, SHOWN, ANSWER, ANSWER]).map((order) => [order]))(
    'records one display and answer for request order %j', (order) => {
      const h = fixture();
      for (const report of order) h.report(report);
      expect(h.summary()).toEqual([
        ['session-a', 'appeared', undefined, 5],
        ['session-a', 'responded', 'good', 5],
      ]);
      const [appeared, responded] = h.events;
      expect(responded?.properties).toEqual({
        ...appeared?.properties, event_type: 'responded', response: 'good',
      });
    },
  );

  it.each([[SHOWN, ABANDON], [ABANDON, SHOWN]])('accepts abandonment in order %j then %j', (a, b) => {
    const h = fixture();
    h.report(a);
    h.report(b);
    h.report(ANSWER);
    expect(h.summary()).toEqual([
      ['session-a', 'appeared', undefined, 5],
      ['session-a', 'abandoned', undefined, 5],
    ]);
  });

  it('does not change the first answer when conflicting reports arrive', () => {
    const h = fixture();
    h.report(ANSWER);
    h.report(ABANDON);
    h.report({ ...ANSWER, response: 'bad' });
    expect(h.summary()).toEqual([
      ['session-a', 'appeared', undefined, 5],
      ['session-a', 'responded', 'good', 5],
    ]);
  });

  it('keeps older answers after another evaluation and after unmount', () => {
    const h = fixture();
    h.first.observe({ kind: 'turn-started', origin: { kind: 'user' } });
    h.first.observe({ kind: 'turn-ended' });
    expect(h.first.evaluate()).toEqual({ appearanceId: 'appearance-2', survey: 'session' });
    h.first.end();
    h.advance(100_000);
    h.report(ANSWER);
    h.report({ type: 'respond', appearanceId: 'appearance-2', response: 'fine' });
    expect(h.summary()).toEqual([
      ['session-a', 'appeared', undefined, 5], ['session-a', 'responded', 'good', 5],
      ['session-a', 'appeared', undefined, 6], ['session-a', 'responded', 'fine', 6],
    ]);
  });

  it('binds reports to the original session, including shown', () => {
    const h = fixture();
    h.report(SHOWN, 'session-b');
    h.report(ANSWER, 'session-b');
    expect(h.events).toEqual([]);
    h.report(ANSWER);
    expect(h.summary()).toEqual([
      ['session-a', 'appeared', undefined, 5], ['session-a', 'responded', 'good', 5],
    ]);
  });

  it('uses dismissed as an answer', () => {
    const h = fixture();
    h.report({ ...ANSWER, response: 'dismissed' });
    expect(h.summary()).toEqual([
      ['session-a', 'appeared', undefined, 5], ['session-a', 'responded', 'dismissed', 5],
    ]);
  });

  it('does not invent a display or abandonment when an offer expires', () => {
    const h = fixture();
    h.advance(RATING_REPORT_RETENTION_MS);
    h.report(ANSWER);
    expect(h.events).toEqual([]);
    const second = h.mount();
    second.observe({ kind: 'turn-started', origin: { kind: 'user' } });
    second.observe({ kind: 'turn-ended' });
    expect(second.evaluate()).toEqual({ appearanceId: 'appearance-2', survey: 'session' });
    h.report({ type: 'shown', appearanceId: 'appearance-2' });
    expect(h.summary()).toEqual([['session-a', 'appeared', undefined, 5]]);
  });

  it('does not time out a displayed rating while its mount is still alive', () => {
    const h = fixture();
    h.report(SHOWN);
    h.advance(RATING_REPORT_RETENTION_MS * 2);
    h.report(ANSWER);
    expect(h.summary()).toEqual([
      ['session-a', 'appeared', undefined, 5], ['session-a', 'responded', 'good', 5],
    ]);
  });

  it('does not renew a detached appearance when the session mounts again', () => {
    const h = fixture();
    h.report(SHOWN);
    h.first.end();
    h.advance(RATING_REPORT_RETENTION_MS - 1);
    h.mount();
    h.first.end();
    h.report(SHOWN);
    h.advance(1);
    h.report(ANSWER);
    expect(h.summary()).toEqual([['session-a', 'appeared', undefined, 5]]);
  });

  it('rechecks telemetry consent when each report arrives', () => {
    const h = fixture();
    h.report(SHOWN);
    h.disable();
    h.report(ANSWER);
    expect(h.summary()).toEqual([['session-a', 'appeared', undefined, 5]]);
  });
});
