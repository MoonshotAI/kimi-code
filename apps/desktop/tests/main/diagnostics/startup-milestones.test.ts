import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  logStartup: vi.fn(),
  track: vi.fn(),
}));

vi.mock('../../../src/main/diagnostics/log', () => ({ logStartup: mocks.logStartup, uptimeMs: () => 4321 }));
vi.mock('../../../src/main/diagnostics/track', () => ({ trackDesktopEvent: mocks.track, trySendDesktopEvent: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('asRendererMilestone', () => {
  it('accepts the known milestones and boot stages only', async () => {
    const { asRendererMilestone } = await import('../../../src/main/diagnostics/startup-milestones');
    expect(asRendererMilestone({ milestone: 'ui-mounted' })).toEqual({ milestone: 'ui-mounted' });
    expect(asRendererMilestone({ milestone: 'boot-stage', stage: 'sessions' })).toEqual({ milestone: 'boot-stage', stage: 'sessions' });
    expect(asRendererMilestone({ milestone: 'boot-stage', stage: '../../etc' })).toBeNull();
    expect(asRendererMilestone({ milestone: 'boot-stage' })).toBeNull();
    expect(asRendererMilestone({ milestone: 'other' })).toBeNull();
    expect(asRendererMilestone(['ui-ready'])).toBeNull();
    expect(asRendererMilestone(null)).toBeNull();
  });
});

describe('recordRendererMilestone', () => {
  it('logs every milestone as a startup step and reports each UI phase once', async () => {
    const { recordRendererMilestone } = await import('../../../src/main/diagnostics/startup-milestones');
    recordRendererMilestone({ milestone: 'ui-mounted' });
    recordRendererMilestone({ milestone: 'boot-stage', stage: 'config' });
    recordRendererMilestone({ milestone: 'ui-ready' });
    recordRendererMilestone({ milestone: 'ui-mounted' });
    recordRendererMilestone({ milestone: 'nope' });

    expect(mocks.logStartup.mock.calls).toEqual([['ui-mounted'], ['boot-config'], ['ui-ready'], ['ui-mounted']]);
    expect(mocks.track.mock.calls).toEqual([
      ['startup_timing', { phase: 'ui_mounted', duration_ms: 4321 }],
      ['startup_timing', { phase: 'ui_ready', duration_ms: 4321 }],
    ]);
  });
});
