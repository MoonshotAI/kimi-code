import { describe, expect, it } from 'vitest';
import { approvalDecisionName } from '../../src/renderer/lib/approvalTelemetry';

// The card's pending-action keys double as telemetry decision names except
// for the two composites flattened here (plan options and feedback submits).
describe('approvalDecisionName', () => {
  it('passes the plain action keys through unchanged', () => {
    for (const action of ['approve', 'approveSession', 'reject', 'approvePlan', 'rejectAndExit'] as const) {
      expect(approvalDecisionName(action)).toBe(action);
    }
  });

  it('flattens a clicked/numbered plan option to approveOption', () => {
    expect(approvalDecisionName('option:Refactor the parser')).toBe('approveOption');
    expect(approvalDecisionName('option:')).toBe('approveOption');
  });

  it('reads a plan-review feedback submit as revisePlan', () => {
    expect(approvalDecisionName('feedback', 'Revise')).toBe('revisePlan');
  });

  it('reads a plain feedback submit as a reject carrying feedback text', () => {
    expect(approvalDecisionName('feedback')).toBe('reject');
    expect(approvalDecisionName('feedback', undefined)).toBe('reject');
  });
});
