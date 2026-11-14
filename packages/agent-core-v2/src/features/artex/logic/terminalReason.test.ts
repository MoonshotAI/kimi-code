import { describe, expect, it } from 'vitest';

import {
  ARTEX_SYNTHESIZED_CANCEL_LABEL,
  ARTEX_TERMINAL_REASONS,
  artexTerminalReasonHint,
  artexTerminalReasonLabel,
  isArtexAbortedReason,
  isArtexBudgetCapReason,
  isArtexTerminalReason,
} from './terminalReason';

describe('terminal reason taxonomy', () => {
  it('has a non-empty hint for every known reason', () => {
    for (const reason of ARTEX_TERMINAL_REASONS) {
      expect(artexTerminalReasonHint(reason).trim()).not.toBe('');
    }
  });

  it('labels the empty reason as a synthesized cancellation', () => {
    expect(artexTerminalReasonLabel('')).toBe(ARTEX_SYNTHESIZED_CANCEL_LABEL);
    expect(artexTerminalReasonLabel('max_turns')).toBe('max_turns');
  });

  it('hints the empty and unknown reasons distinctly', () => {
    expect(artexTerminalReasonHint('')).toContain('no Terminal event');
    expect(artexTerminalReasonHint('brand_new_reason')).toContain('unknown terminal state');
  });

  it('classifies aborted and budget-cap reasons', () => {
    expect(isArtexAbortedReason('aborted_tools')).toBe(true);
    expect(isArtexAbortedReason('aborted_streaming')).toBe(true);
    expect(isArtexAbortedReason('max_turns')).toBe(false);
    expect(isArtexBudgetCapReason('max_turns')).toBe(true);
    expect(isArtexBudgetCapReason('timeout')).toBe(true);
    expect(isArtexBudgetCapReason('completed')).toBe(false);
  });

  it('recognizes known reasons', () => {
    expect(isArtexTerminalReason('model_error')).toBe(true);
    expect(isArtexTerminalReason('nope')).toBe(false);
  });
});
