import { describe, expect, it } from 'vitest';

import type { TurnEndReason } from '@moonshot-ai/kimi-code-sdk';

import { turnEndReasonToStopReason } from '../src/events-map';

describe('turnEndReasonToStopReason', () => {
  it('maps known SDK turn-end reasons to ACP stop reasons', () => {
    expect(turnEndReasonToStopReason('completed')).toBe('end_turn');
    expect(turnEndReasonToStopReason('cancelled')).toBe('cancelled');
    expect(turnEndReasonToStopReason('failed')).toBe('end_turn');
  });

  it('falls back to end_turn for unknown runtime reasons', () => {
    expect(turnEndReasonToStopReason('interrupted' as TurnEndReason)).toBe('end_turn');
  });
});
