import type { FeedbackSurveyEvent, PromptOrigin } from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountSessionRating, type SessionRatingSeed } from '#/sessionRating/engine';

const USER_ORIGIN: PromptOrigin = { kind: 'user' };
const SYSTEM_ORIGIN: PromptOrigin = { kind: 'system_trigger', name: 'background-task' };

interface Harness {
  readonly mount: ReturnType<typeof mountSessionRating>;
  readonly events: { readonly event: string; readonly properties: FeedbackSurveyEvent }[];
  turn(origin: PromptOrigin, traceId?: string): void;
}

function harness(options: { preview?: boolean; seed?: SessionRatingSeed } = {}): Harness {
  const events: Harness['events'] = [];
  let appearances = 0;
  const mount = mountSessionRating(options.seed ?? {}, {
    environment: () => ({
      currentModel: 'kimi-test',
      cumulativeTokens: 1200,
      contextTokens: 800,
      permissionMode: 'default',
      thinkingEffort: 'high',
    }),
    track: (event, properties) => events.push({ event, properties }),
    preview: options.preview ?? true,
    now: () => Date.now(),
    appearanceId: () => `appearance-${++appearances}`,
  });
  return {
    mount,
    events,
    turn: (origin, traceId) => {
      mount.observe({ kind: 'turn-started', origin });
      mount.observe({ kind: 'turn-ended', traceId });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('session rating evaluation slot', () => {
  it('opens a rating once the session idles for two seconds after a user turn', async () => {
    const { mount, events, turn } = harness({ seed: { userTurnCount: 4 } });
    turn(USER_ORIGIN, 'trace-1');
    vi.advanceTimersByTime(2000);

    await expect(mount.evaluate()).resolves.toEqual({
      phase: 'open',
      appearanceId: 'appearance-1',
      survey: 'session',
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('feedback_survey');
    expect(events[0]?.properties).toMatchObject({
      event_type: 'appeared',
      appearance_id: 'appearance-1',
      appearance_index: 1,
      current_model: 'kimi-test',
      user_turn_count: 5,
      cumulative_tokens: 1200,
      virtual_context_tokens: 800,
      permission_mode: 'default',
      thinking_effort: 'high',
      config_probability: 0.005,
      config_on_for_models: '*',
    });
  });

  it('keeps the slot for a caller that asks before the idle period ends', async () => {
    const { mount, turn } = harness();
    turn(USER_ORIGIN);
    vi.advanceTimersByTime(1000);
    await expect(mount.evaluate()).resolves.toEqual({ phase: 'closed' });

    vi.advanceTimersByTime(1000);
    await expect(mount.evaluate()).resolves.toMatchObject({ phase: 'open' });
  });

  it('accepts a caller whose idle timer fires slightly early', async () => {
    const { mount, turn } = harness();
    turn(USER_ORIGIN);
    vi.advanceTimersByTime(1800);

    await expect(mount.evaluate()).resolves.toMatchObject({ phase: 'open' });
  });

  it('drops a slot that nobody evaluated within the window', async () => {
    const { mount, events, turn } = harness();
    turn(USER_ORIGIN);
    vi.advanceTimersByTime(12_001);

    await expect(mount.evaluate()).resolves.toEqual({ phase: 'closed' });
    await expect(mount.evaluate()).resolves.toEqual({ phase: 'closed' });
    expect(events).toHaveLength(0);
  });

  it('spends the slot on the first evaluation', async () => {
    const { mount, events, turn } = harness();
    turn(USER_ORIGIN);
    vi.advanceTimersByTime(2000);

    const first = await mount.evaluate();
    const second = await mount.evaluate();

    expect(second).toEqual(first);
    expect(events).toHaveLength(1);
  });

  it('does not create a slot for turns the user did not start', async () => {
    const { mount, turn } = harness();
    turn(SYSTEM_ORIGIN);
    vi.advanceTimersByTime(2000);

    await expect(mount.evaluate()).resolves.toEqual({ phase: 'closed' });
  });

  it('restarts the idle period when a non-user turn runs during it', async () => {
    const { mount, turn } = harness();
    turn(USER_ORIGIN);
    vi.advanceTimersByTime(1500);
    mount.observe({ kind: 'turn-started', origin: SYSTEM_ORIGIN });
    vi.advanceTimersByTime(1000);
    await expect(mount.evaluate()).resolves.toEqual({ phase: 'closed' });

    mount.observe({ kind: 'turn-ended' });
    vi.advanceTimersByTime(2000);
    await expect(mount.evaluate()).resolves.toMatchObject({ phase: 'open' });
  });

  it('stays closed outside preview until the product gates land', async () => {
    const { mount, events, turn } = harness({ preview: false });
    turn(USER_ORIGIN);
    vi.advanceTimersByTime(2000);

    await expect(mount.evaluate()).resolves.toEqual({ phase: 'closed' });
    expect(events).toHaveLength(0);
  });
});

describe('session rating appearance', () => {
  async function opened(): Promise<Harness & { readonly appearanceId: string }> {
    const rating = harness();
    rating.turn(USER_ORIGIN);
    vi.advanceTimersByTime(2000);
    const view = await rating.mount.evaluate();
    if (view.phase !== 'open') throw new Error('expected an open rating');
    return { ...rating, appearanceId: view.appearanceId };
  }

  it('settles an answer after the undo window and closes after the thanks period', async () => {
    const { mount, events, appearanceId } = await opened();

    expect(mount.act({ type: 'select', appearanceId, response: 'good' })).toEqual({
      phase: 'pending',
      appearanceId,
      survey: 'session',
      response: 'good',
      settleInMs: 3000,
    });
    vi.advanceTimersByTime(1000);
    expect(mount.view()).toMatchObject({ phase: 'pending', settleInMs: 2000 });

    vi.advanceTimersByTime(2000);
    expect(mount.view()).toEqual({
      phase: 'thanks',
      appearanceId,
      survey: 'session',
      response: 'good',
      closeInMs: 5000,
    });
    expect(events.map(({ properties }) => [properties.event_type, properties.response])).toEqual([
      ['appeared', undefined],
      ['responded', 'good'],
    ]);

    vi.advanceTimersByTime(5000);
    expect(mount.view()).toEqual({ phase: 'closed' });
  });

  it('returns to the question when the answer is undone in time', async () => {
    const { mount, events, appearanceId } = await opened();
    mount.act({ type: 'select', appearanceId, response: 'bad' });
    vi.advanceTimersByTime(2000);

    expect(mount.act({ type: 'undo', appearanceId })).toEqual({
      phase: 'open',
      appearanceId,
      survey: 'session',
    });
    vi.advanceTimersByTime(5000);
    expect(mount.view()).toMatchObject({ phase: 'open' });
    expect(events).toHaveLength(1);
  });

  it('ignores actions for another appearance or the wrong phase', async () => {
    const { mount, events, appearanceId } = await opened();

    expect(mount.act({ type: 'select', appearanceId: 'stale', response: 'good' })).toMatchObject({
      phase: 'open',
    });
    expect(mount.act({ type: 'undo', appearanceId })).toMatchObject({ phase: 'open' });
    mount.act({ type: 'select', appearanceId, response: 'fine' });
    expect(mount.act({ type: 'select', appearanceId, response: 'bad' })).toMatchObject({
      phase: 'pending',
      response: 'fine',
    });
    vi.advanceTimersByTime(3000);
    expect(events.map(({ properties }) => properties.response)).toEqual([undefined, 'fine']);
  });

  it('reports a dismissal and closes', async () => {
    const { mount, events, appearanceId } = await opened();

    expect(mount.act({ type: 'dismiss', appearanceId })).toEqual({ phase: 'closed' });
    expect(events.at(-1)?.properties).toMatchObject({
      event_type: 'responded',
      response: 'dismissed',
    });
  });

  it('abandons an unanswered rating when the next turn starts', async () => {
    const { mount, events } = await opened();
    mount.observe({ kind: 'turn-started', origin: USER_ORIGIN });

    expect(mount.view()).toEqual({ phase: 'closed' });
    expect(events.at(-1)?.properties.event_type).toBe('abandoned');
  });

  it('reports a pending answer immediately when the next turn starts', async () => {
    const { mount, events, appearanceId } = await opened();
    mount.act({ type: 'select', appearanceId, response: 'good' });
    mount.observe({ kind: 'turn-started', origin: SYSTEM_ORIGIN });

    expect(mount.view()).toEqual({ phase: 'closed' });
    expect(events.at(-1)?.properties).toMatchObject({ event_type: 'responded', response: 'good' });
    vi.advanceTimersByTime(10_000);
    expect(events).toHaveLength(2);
  });

  it('freezes the appearance snapshot for every lifecycle event', async () => {
    const { mount, events, turn } = harness({ seed: { userTurnCount: 2 } });
    turn(USER_ORIGIN);
    vi.advanceTimersByTime(2000);
    const view = await mount.evaluate();
    if (view.phase !== 'open') throw new Error('expected an open rating');
    mount.act({ type: 'select', appearanceId: view.appearanceId, response: 'good' });
    mount.observe({ kind: 'turn-started', origin: USER_ORIGIN });

    expect(events.map(({ properties }) => properties.user_turn_count)).toEqual([3, 3]);
  });
});

describe('session rating mount end', () => {
  async function pendingAnswer(): Promise<Harness> {
    const rating = harness();
    rating.turn(USER_ORIGIN);
    vi.advanceTimersByTime(2000);
    const view = await rating.mount.evaluate();
    if (view.phase !== 'open') throw new Error('expected an open rating');
    rating.mount.act({ type: 'select', appearanceId: view.appearanceId, response: 'fine' });
    return rating;
  }

  it('settles the pending answer when the session unmounts', async () => {
    const { mount, events } = await pendingAnswer();
    mount.end('unmount');

    expect(events.at(-1)?.properties).toMatchObject({ event_type: 'responded', response: 'fine' });
    expect(mount.view()).toEqual({ phase: 'closed' });
  });

  it('ends silently when the process exits', async () => {
    const { mount, events } = await pendingAnswer();
    mount.end('exit');
    vi.advanceTimersByTime(10_000);

    expect(events.map(({ properties }) => properties.event_type)).toEqual(['appeared']);
  });

  it('ignores facts and evaluations after the mount ends', async () => {
    const { mount, events, turn } = harness();
    mount.end('unmount');
    turn(USER_ORIGIN);
    vi.advanceTimersByTime(2000);

    await expect(mount.evaluate()).resolves.toEqual({ phase: 'closed' });
    expect(events).toHaveLength(0);
  });
});
