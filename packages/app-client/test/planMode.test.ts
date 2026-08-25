import { describe, expect, it } from 'vitest';
import {
  ackPlanPending,
  foldDaemonPlanMode,
  markPlanPending,
} from '@moonshot-ai/app-core/lib';

describe('planMode pending marks', () => {
  function state() {
    return {
      planModeBySession: {} as Record<string, boolean>,
      pendingPlanBySession: {} as Record<string, number>,
    };
  }

  it('applies the daemon mode when no pick is pending', () => {
    const s = state();
    foldDaemonPlanMode(s, 's1', true);
    expect(s.planModeBySession['s1']).toBe(true);
  });

  it('drops every report while a pick is pending, even a matching echo', () => {
    const s = state();
    s.planModeBySession['s1'] = false;
    markPlanPending(s, 's1');
    foldDaemonPlanMode(s, 's1', true);
    foldDaemonPlanMode(s, 's1', false);
    expect(s.planModeBySession['s1']).toBe(false);
    expect(s.pendingPlanBySession['s1']).toBeDefined();
  });

  it('acks only the completion of the latest write, then resumes folding', () => {
    const s = state();
    s.planModeBySession['s1'] = false;
    const stale = markPlanPending(s, 's1');
    const latest = markPlanPending(s, 's1');
    // A completion for the superseded write must not clear the shield.
    expect(ackPlanPending(s, 's1', stale)).toBe(false);
    expect(s.pendingPlanBySession['s1']).toBe(latest);
    foldDaemonPlanMode(s, 's1', true);
    expect(s.planModeBySession['s1']).toBe(false);
    expect(ackPlanPending(s, 's1', latest)).toBe(true);
    foldDaemonPlanMode(s, 's1', true);
    expect(s.planModeBySession['s1']).toBe(true);
  });
});
