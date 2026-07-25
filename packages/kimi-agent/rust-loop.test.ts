import { describe, expect, it, vi, afterEach } from 'vitest';

import { classifyRpcMessage, mapStopReason, WorkspacePredictor } from './rust-loop';

// Mock the native workspace index so we can test the native-first /
// fs-fallback prediction path without requiring the Rust module.
vi.mock('@moonshot-ai/agent-core-v2', () => ({
  tryNativeWorkspaceIndexPredictRead: vi.fn(),
  tryNativeBuildWorkspaceIndex: vi.fn(),
}));

const { tryNativeWorkspaceIndexPredictRead } = await import('@moonshot-ai/agent-core-v2');

describe('classifyRpcMessage', () => {
  it('classifies a host request (method + id) as a request', () => {
    expect(
      classifyRpcMessage({ jsonrpc: '2.0', id: 1, method: 'host/execute_tool', params: {} }),
    ).toBe('request');
  });

  it('classifies a result response (id, no method) as a response', () => {
    expect(classifyRpcMessage({ jsonrpc: '2.0', id: 1, result: {} })).toBe('response');
  });

  it('classifies an error response (id, no method) as a response', () => {
    expect(classifyRpcMessage({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } })).toBe(
      'response',
    );
  });

  // Regression: a Rust host request carrying an id that collides with a pending
  // request id (both sides allocate ids from 1) must route as a request, not be
  // mis-consumed as the pending request's response.
  it('routes a colliding host request as a request, not a response', () => {
    const colliding = { jsonrpc: '2.0' as const, id: 1, method: 'host/llm_chat', params: {} };
    expect(classifyRpcMessage(colliding)).toBe('request');
  });

  it('ignores a notification (method, no id)', () => {
    expect(classifyRpcMessage({ jsonrpc: '2.0', method: 'host/log', params: {} })).toBe('ignore');
  });

  it('ignores a message with neither method nor id', () => {
    expect(classifyRpcMessage({ jsonrpc: '2.0' })).toBe('ignore');
  });
});

describe('mapStopReason', () => {
  it('maps EndTurn to end_turn', () => {
    expect(mapStopReason('EndTurn')).toBe('end_turn');
  });

  it('maps MaxTokens to max_tokens', () => {
    expect(mapStopReason('MaxTokens')).toBe('max_tokens');
  });

  it('maps Filtered to filtered', () => {
    expect(mapStopReason('Filtered')).toBe('filtered');
  });

  it('maps Paused to paused', () => {
    expect(mapStopReason('Paused')).toBe('paused');
  });

  it('maps Aborted to aborted', () => {
    expect(mapStopReason('Aborted')).toBe('aborted');
  });

  it('maps BudgetLimited to budget_limited', () => {
    expect(mapStopReason('BudgetLimited')).toBe('budget_limited');
  });

  it('maps unknown reason to unknown', () => {
    expect(mapStopReason('SomethingElse')).toBe('unknown');
  });

  it('maps empty string to unknown', () => {
    expect(mapStopReason('')).toBe('unknown');
  });
});

describe('WorkspacePredictor', () => {
  const predictor = new WorkspacePredictor(process.cwd());

  afterEach(() => {
    vi.mocked(tryNativeWorkspaceIndexPredictRead).mockReset();
  });

  it('serves a prediction from the native index when available', () => {
    vi.mocked(tryNativeWorkspaceIndexPredictRead).mockReturnValue({
      lineCount: 42,
      size: 1024,
      preview: 'line one\nline two\nline three\nline four\nline five',
      estimatedReadMs: 1,
    });

    const result = predictor.predictRead('some/file.rs');

    expect(result).not.toBeNull();
    expect(result).toContain('prediction: 42 lines, 1024 bytes');
    expect(result).toContain('line one');
    expect(result).toContain('[... prediction — precise result loading ...]');
    expect(tryNativeWorkspaceIndexPredictRead).toHaveBeenCalledWith('some/file.rs');
  });

  it('falls back to fs stat when the native index misses (returns null)', () => {
    // Native index miss → returns null → predictor falls back to fs.
    vi.mocked(tryNativeWorkspaceIndexPredictRead).mockReturnValue(null);

    // Point at a real file on disk so the fs fallback path succeeds.
    const realFile = new URL('./rust-loop.test.ts', import.meta.url).pathname.replace(/^\//, '');
    const result = predictor.predictRead(realFile);

    expect(result).not.toBeNull();
    expect(result).toContain('prediction:');
    expect(result).toContain('[... prediction — precise result loading ...]');
  });

  it('falls back to fs when the native module is unavailable (returns undefined)', () => {
    // Native module absent → returns undefined → predictor falls back to fs.
    vi.mocked(tryNativeWorkspaceIndexPredictRead).mockReturnValue();

    const realFile = new URL('./rust-loop.test.ts', import.meta.url).pathname.replace(/^\//, '');
    const result = predictor.predictRead(realFile);

    expect(result).not.toBeNull();
    expect(result).toContain('prediction:');
  });

  it('returns null for a non-existent file when both paths miss', () => {
    vi.mocked(tryNativeWorkspaceIndexPredictRead).mockReturnValue(null);

    const result = predictor.predictRead('definitely/does/not/exist.txt');

    expect(result).toBeNull();
  });
});
