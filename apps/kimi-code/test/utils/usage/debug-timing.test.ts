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

  it('formats input tokens and cache read/write counts', () => {
    const result = formatStepDebugTiming({
      llmFirstTokenLatencyMs: 800,
      llmStreamDurationMs: 5000,
      usage: {
        inputOther: 700,
        inputCacheRead: 1200,
        inputCacheCreation: 100,
        output: 200,
      },
    });
    expect(result).toBe(
      '[Debug] TTFT: 800ms | TPS: 40.0 tok/s (200 tokens in 5.0s) | tokens in 2.0k | cache read 1.2k (60%) / write 100',
    );
  });

  it('omits cache write count when it is zero', () => {
    const result = formatStepDebugTiming({
      llmFirstTokenLatencyMs: 800,
      llmStreamDurationMs: 5000,
      usage: {
        inputOther: 1000,
        inputCacheRead: 0,
        inputCacheCreation: 0,
        output: 200,
      },
    });
    expect(result).toContain('tokens in 1.0k');
    expect(result).toContain('cache read 0 (0%)');
    expect(result).not.toContain('/ write 0');
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

  it('splits TTFT into api-server and client portions when both are present', () => {
    const result = formatStepDebugTiming({
      llmFirstTokenLatencyMs: 2500,
      llmStreamDurationMs: 5000,
      llmServerFirstTokenMs: 2400,
      llmRequestBuildMs: 100,
      usage: { output: 200 },
    });
    expect(result).toBe(
      '[Debug] TTFT: 2.5s (api 2.4s + client 100ms) | TPS: 40.0 tok/s (200 tokens in 5.0s)',
    );
  });

  it('falls back to the bare TTFT when only one split component is present', () => {
    const result = formatStepDebugTiming({
      llmFirstTokenLatencyMs: 800,
      llmStreamDurationMs: 5000,
      llmServerFirstTokenMs: 700,
      usage: { output: 0 },
    });
    expect(result).toBe('[Debug] TTFT: 800ms');
  });

  it('appends the decode wait/consume split to the TPS clause', () => {
    const result = formatStepDebugTiming({
      llmFirstTokenLatencyMs: 800,
      llmStreamDurationMs: 5000,
      llmServerDecodeMs: 4600,
      llmClientConsumeMs: 400,
      usage: { output: 200 },
    });
    expect(result).toBe(
      '[Debug] TTFT: 800ms | TPS: 40.0 tok/s (200 tokens in 5.0s; server 4.6s + client 400ms)',
    );
  });

  it('omits the decode split when only one component is present', () => {
    const result = formatStepDebugTiming({
      llmFirstTokenLatencyMs: 800,
      llmStreamDurationMs: 5000,
      llmServerDecodeMs: 4600,
      usage: { output: 200 },
    });
    expect(result).toBe('[Debug] TTFT: 800ms | TPS: 40.0 tok/s (200 tokens in 5.0s)');
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
