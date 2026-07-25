import { describe, expect, it } from 'vitest';

import { classifyRpcMessage, mapStopReason } from './rust-loop';

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
    expect(
      classifyRpcMessage({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } }),
    ).toBe('response');
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
