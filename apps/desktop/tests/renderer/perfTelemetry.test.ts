import { describe, expect, it } from 'vitest';

import { rendererTrackEventSchema } from '../../src/shared/track-events';

function parse(event: string, properties: unknown) {
  return rendererTrackEventSchema.safeParse({ event, properties });
}

describe('renderer perf telemetry event schemas', () => {
  describe('session_busy_longtasks', () => {
    const base = {
      session_id: 'session-1',
      longtask_count: 3,
      longtask_total_ms: 420,
      longtask_max_ms: 200,
      busy_duration_ms: 5200,
    };

    it('accepts a full payload', () => {
      expect(parse('session_busy_longtasks', base).success).toBe(true);
    });

    it('clamps oversized values instead of dropping the event', () => {
      const result = parse('session_busy_longtasks', {
        ...base,
        longtask_count: 2_000_000,
        busy_duration_ms: 100_000_000,
      });
      expect(result.data?.properties).toMatchObject({
        longtask_count: 1_000_000,
        busy_duration_ms: 86_400_000,
      });
    });

    it('rejects fractional, negative and missing values', () => {
      const { session_id: _omitted, ...withoutSession } = base;
      expect(parse('session_busy_longtasks', { ...base, longtask_total_ms: 1.5 }).success).toBe(false);
      expect(parse('session_busy_longtasks', { ...base, longtask_count: -1 }).success).toBe(false);
      expect(parse('session_busy_longtasks', withoutSession).success).toBe(false);
    });
  });

  describe('session_open_timing', () => {
    const base = {
      session_id: 'session-1',
      duration_ms: 120,
      cached: true,
    };

    it('accepts a full payload and rejects a non-boolean cached', () => {
      expect(parse('session_open_timing', base).success).toBe(true);
      expect(parse('session_open_timing', { ...base, cached: 'yes' }).success).toBe(false);
    });
  });

  describe('prompt prediction', () => {
    const base = {
      prediction_id: 'prediction-1',
      turn_id: 7,
      duration_ms: 120,
      prediction_chars: 10,
    };

    it('accepts the client funnel without prediction text', () => {
      expect(parse('prediction_shown', base).success).toBe(true);
      expect(parse('prediction_accepted', { ...base, key: 'tab' }).success).toBe(true);
      expect(parse('prediction_submitted', { ...base, edited: true }).success).toBe(true);
      expect(parse('prediction_dismissed', { ...base, reason: 'input', accepted: false }).success).toBe(true);
      expect(parse('prediction_accepted', { ...base, key: 'enter' }).success).toBe(false);
    });
  });
});
