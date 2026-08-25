import { describe, expect, it } from 'vitest';
import {
  ackSwarmPending,
  foldDaemonSwarmMode,
  markSwarmPending,
} from '@moonshot-ai/app-core/lib';

describe('swarmMode pending marks', () => {
  function state() {
    return {
      swarmModeBySession: {} as Record<string, boolean>,
      pendingSwarmBySession: {} as Record<string, number>,
    };
  }

  it('applies the daemon mode when no pick is pending', () => {
    const s = state();
    foldDaemonSwarmMode(s, 's1', true);
    expect(s.swarmModeBySession['s1']).toBe(true);
  });

  it('drops every report while a pick is pending, even a matching echo', () => {
    const s = state();
    s.swarmModeBySession['s1'] = true;
    markSwarmPending(s, 's1');
    foldDaemonSwarmMode(s, 's1', false);
    foldDaemonSwarmMode(s, 's1', true);
    expect(s.swarmModeBySession['s1']).toBe(true);
    expect(s.pendingSwarmBySession['s1']).toBeDefined();
  });

  it('acks only the completion of the latest write, then resumes folding', () => {
    const s = state();
    s.swarmModeBySession['s1'] = true;
    const stale = markSwarmPending(s, 's1');
    const latest = markSwarmPending(s, 's1');
    // A completion for the superseded write must not clear the shield.
    expect(ackSwarmPending(s, 's1', stale)).toBe(false);
    expect(s.pendingSwarmBySession['s1']).toBe(latest);
    foldDaemonSwarmMode(s, 's1', false);
    expect(s.swarmModeBySession['s1']).toBe(true);
    expect(ackSwarmPending(s, 's1', latest)).toBe(true);
    foldDaemonSwarmMode(s, 's1', false);
    expect(s.swarmModeBySession['s1']).toBe(false);
  });
});
