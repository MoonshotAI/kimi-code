import { describe, expect, it } from 'vitest';
import {
  ackTowerPending,
  foldDaemonTowerMode,
  markTowerPending,
} from '@moonshot-ai/app-core/lib';

describe('towerMode pending marks', () => {
  function state() {
    return {
      towerModeBySession: {} as Record<string, boolean>,
      pendingTowerBySession: {} as Record<string, number>,
    };
  }

  it('applies the daemon mode when no pick is pending', () => {
    const s = state();
    foldDaemonTowerMode(s, 's1', true);
    expect(s.towerModeBySession['s1']).toBe(true);
  });

  it('drops every report while a pick is pending, even a matching echo', () => {
    const s = state();
    s.towerModeBySession['s1'] = true;
    markTowerPending(s, 's1');
    foldDaemonTowerMode(s, 's1', false);
    foldDaemonTowerMode(s, 's1', true);
    expect(s.towerModeBySession['s1']).toBe(true);
    expect(s.pendingTowerBySession['s1']).toBeDefined();
  });

  it('acks only the completion of the latest write, then resumes folding', () => {
    const s = state();
    s.towerModeBySession['s1'] = true;
    const stale = markTowerPending(s, 's1');
    const latest = markTowerPending(s, 's1');
    expect(ackTowerPending(s, 's1', stale)).toBe(false);
    expect(s.pendingTowerBySession['s1']).toBe(latest);
    foldDaemonTowerMode(s, 's1', false);
    expect(s.towerModeBySession['s1']).toBe(true);
    expect(ackTowerPending(s, 's1', latest)).toBe(true);
    foldDaemonTowerMode(s, 's1', false);
    expect(s.towerModeBySession['s1']).toBe(false);
  });
});
