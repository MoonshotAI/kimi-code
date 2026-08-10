/**
 * v1 protocol event → AppEvent contract (`mappers.toAppEvent`).
 *
 * These cases pin the Rust server's v1 wire projections onto the web layer's
 * AppEvent shapes: the message close-out status (G-2 #5) and the live usage
 * numbers (G-2 #3) must survive the mapping untouched.
 */

import { describe, expect, it } from 'vitest';

import { toAppEvent, toAppMessage } from '../src/api/daemon/mappers';
import type { WireEvent, WireMessage } from '../src/api/daemon/wire';

describe('toAppEvent message.updated', () => {
  it('maps the protocol completion status onto messageUpdated', () => {
    const event = {
      type: 'event.message.updated',
      session_id: 's1',
      payload: {
        message_id: 'msg_1',
        content: [{ type: 'text', text: 'final' }],
        status: 'completed',
      },
    } as WireEvent;
    expect(toAppEvent(event)).toEqual({
      type: 'messageUpdated',
      sessionId: 's1',
      messageId: 'msg_1',
      content: [{ type: 'text', text: 'final' }],
      status: 'completed',
    });
  });
});

describe('toAppEvent session.usage_updated', () => {
  it('normalizes the engine usage numbers onto sessionUsageUpdated', () => {
    const event = {
      type: 'event.session.usage_updated',
      session_id: 's1',
      payload: {
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          total_cost_usd: 0,
          context_tokens: 0,
          context_limit: 0,
          turn_count: 0,
        },
        delta: { input_tokens: 100, output_tokens: 50 },
      },
    } as WireEvent;
    expect(toAppEvent(event)).toEqual({
      type: 'sessionUsageUpdated',
      sessionId: 's1',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalCostUsd: 0,
        contextTokens: 0,
        contextLimit: 0,
        turnCount: 0,
      },
    });
  });
});

describe('toAppMessage status parameter', () => {
  const wire = {
    id: 'msg_1',
    session_id: 's1',
    role: 'assistant',
    content: [],
    created_at: '2026-01-01T00:00:00.000Z',
  } as WireMessage;

  it('attaches completed for snapshot loads', () => {
    expect(toAppMessage(wire, 'completed').status).toBe('completed');
  });

  it('leaves WS-created messages unset until message.updated arrives', () => {
    expect(toAppMessage(wire).status).toBeUndefined();
  });
});
