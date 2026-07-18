import { describe, expect, it } from 'vitest';

import { buildStreamTiming } from '#/app/model/modelImpl';

describe('buildStreamTiming', () => {
  it('returns base TTFT and stream duration only', () => {
    expect(buildStreamTiming(100, undefined, 250, 400, undefined)).toEqual({
      firstTokenLatencyMs: 150,
      streamDurationMs: 150,
    });
  });

  it('splits TTFT across request-sent boundary', () => {
    expect(buildStreamTiming(100, 180, 250, 400, undefined)).toEqual({
      firstTokenLatencyMs: 150,
      streamDurationMs: 150,
      requestBuildMs: 80,
      serverFirstTokenMs: 70,
    });
  });

  it('adds decode stats when present', () => {
    expect(
      buildStreamTiming(100, 120, 250, 400, {
        serverDecodeMs: 90,
        clientConsumeMs: 60,
      }),
    ).toEqual({
      firstTokenLatencyMs: 150,
      streamDurationMs: 150,
      requestBuildMs: 20,
      serverFirstTokenMs: 130,
      serverDecodeMs: 90,
      clientConsumeMs: 60,
    });
  });
});
