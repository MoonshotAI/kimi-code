import { describe, expect, it } from 'vitest';

import { formatStepDebugTiming } from '#/utils/usage/debug-timing';

describe('formatStepDebugTiming', () => {
  it('returns undefined when timing fields are missing', () => {
    expect(formatStepDebugTiming({})).toBeUndefined();
    expect(formatStepDebugTiming({ llmFirstTokenLatencyMs: 100 })).toBeUndefined();
    expect(formatStepDebugTiming({ llmStreamDurationMs: 200 })).toBeUndefined();
  });

  it('formats TTFT only when output tokens are zero', () => {
    const result = formatStepDebugTiming({
      llmFirstTokenLatencyMs: 250,
      llmStreamDurationMs: 3000,
      usage: { output: 0 },
    });
    expect(result).toBe('[Debug] TTFT: 250ms');
  });

  it('formats TTFT and TPS with output tokens', () => {
    const result = formatStepDebugTiming({
      llmFirstTokenLatencyMs: 800,
      llmStreamDurationMs: 5000,
      usage: { output: 200 },
    });
    expect(result).toBe('[Debug] TTFT: 800ms | TPS: 40.0 tok/s (200 tokens in 5.0s)');
  });

  it('omits TPS when the streamed window is too short to measure', () => {
    const result = formatStepDebugTiming({
      llmFirstTokenLatencyMs: 1200,
      llmStreamDurationMs: 1,
      usage: { output: 44 },
    });
    expect(result).toBe(
      '[Debug] TTFT: 1.2s | 44 tokens in 1ms (stream too short for TPS)',
    );
  });

  it('computes TPS once the streamed window reaches the reliability threshold', () => {
    const result = formatStepDebugTiming({
      llmFirstTokenLatencyMs: 200,
      llmStreamDurationMs: 50,
      usage: { output: 20 },
    });
    expect(result).toBe('[Debug] TTFT: 200ms | TPS: 400.0 tok/s (20 tokens in 50ms)');
  });

  it('formats durations under 1s as milliseconds', () => {
    const result = formatStepDebugTiming({
      llmFirstTokenLatencyMs: 50,
      llmStreamDurationMs: 900,
      usage: { output: 10 },
    });
    expect(result).toContain('TTFT: 50ms');
    expect(result).toContain('900ms');
  });

  it('formats durations at or above 1s as seconds', () => {
    const result = formatStepDebugTiming({
      llmFirstTokenLatencyMs: 1500,
      llmStreamDurationMs: 10000,
      usage: { output: 500 },
    });
    expect(result).toContain('TTFT: 1.5s');
    expect(result).toContain('10.0s');
  });
});
