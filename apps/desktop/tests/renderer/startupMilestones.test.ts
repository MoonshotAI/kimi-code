import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

const markRendererRunning = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/debug/rendererErrors', () => ({ markRendererRunning }));

import { reportStartupMilestone, watchStartupMilestones } from '../../src/renderer/lib/startupMilestones';

const report = vi.fn();

beforeEach(() => {
  report.mockClear();
  markRendererRunning.mockClear();
  vi.stubGlobal('window', { kimiDesktop: { reportStartupMilestone: report } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('watchStartupMilestones', () => {
  it('reports each boot stage until the client is ready, then ui-ready exactly once', async () => {
    const initialized = ref(false);
    const bootStage = ref('auth');
    watchStartupMilestones(initialized, bootStage);

    bootStage.value = 'server';
    await nextTick();
    bootStage.value = 'sessions';
    await nextTick();
    initialized.value = true;
    await nextTick();
    bootStage.value = 'session';
    initialized.value = false;
    await nextTick();
    initialized.value = true;
    await nextTick();

    expect(report.mock.calls).toEqual([
      ['boot-stage', 'auth'],
      ['boot-stage', 'server'],
      ['boot-stage', 'sessions'],
      ['ui-ready', undefined],
    ]);
    expect(markRendererRunning).toHaveBeenCalledOnce();
  });

  it('reports ui-ready immediately when the client is already initialized', () => {
    watchStartupMilestones(ref(true), ref('session'));
    expect(report.mock.calls).toEqual([['ui-ready', undefined]]);
  });
});

describe('reportStartupMilestone', () => {
  it('is a no-op without the desktop bridge and never throws', () => {
    vi.stubGlobal('window', {});
    expect(() => reportStartupMilestone('ui-mounted')).not.toThrow();
    vi.stubGlobal('window', { kimiDesktop: { reportStartupMilestone: () => { throw new Error('bridge gone'); } } });
    expect(() => reportStartupMilestone('ui-mounted')).not.toThrow();
  });
});
