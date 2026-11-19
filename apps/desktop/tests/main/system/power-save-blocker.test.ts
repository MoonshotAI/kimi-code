import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  start: vi.fn(() => 7),
  stop: vi.fn(),
}));

vi.mock('electron', () => ({
  powerSaveBlocker: {
    start: mocks.start,
    stop: mocks.stop,
  },
}));

import { getPowerSaveBlockerMode, isPowerSaveBlockerEnabled, setPowerSaveBlockerMode } from '../../../src/main/system/power-save-blocker';

describe('power save blocker', () => {
  beforeEach(() => {
    setPowerSaveBlockerMode('allow-sleep');
    vi.clearAllMocks();
    mocks.start.mockReset();
    mocks.start.mockReturnValue(7);
  });

  it('starts once and stops once across repeated state changes', () => {
    expect(isPowerSaveBlockerEnabled()).toBe(false);
    setPowerSaveBlockerMode('prevent-app-suspension');
    setPowerSaveBlockerMode('prevent-app-suspension');
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledWith('prevent-app-suspension');
    expect(isPowerSaveBlockerEnabled()).toBe(true);
    setPowerSaveBlockerMode('allow-sleep');
    setPowerSaveBlockerMode('allow-sleep');
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledWith(7);
    expect(isPowerSaveBlockerEnabled()).toBe(false);
  });

  it('can be enabled again after being stopped', () => {
    setPowerSaveBlockerMode('prevent-app-suspension');
    setPowerSaveBlockerMode('allow-sleep');
    setPowerSaveBlockerMode('prevent-app-suspension');
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(isPowerSaveBlockerEnabled()).toBe(true);
  });

  it('switches both active modes without leaving duplicate blockers', () => {
    mocks.start.mockReturnValueOnce(10).mockReturnValueOnce(11).mockReturnValueOnce(12);
    setPowerSaveBlockerMode('prevent-app-suspension');
    setPowerSaveBlockerMode('prevent-display-sleep');
    setPowerSaveBlockerMode('prevent-display-sleep');
    expect(getPowerSaveBlockerMode()).toBe('prevent-display-sleep');
    expect(mocks.start.mock.calls).toEqual([['prevent-app-suspension'], ['prevent-display-sleep']]);
    expect(mocks.stop.mock.calls).toEqual([[10]]);
    setPowerSaveBlockerMode('prevent-app-suspension');
    setPowerSaveBlockerMode('allow-sleep');
    expect(mocks.stop.mock.calls).toEqual([[10], [11], [12]]);
    expect(getPowerSaveBlockerMode()).toBe('allow-sleep');
  });

  it('keeps the existing blocker if starting the replacement fails', () => {
    setPowerSaveBlockerMode('prevent-app-suspension');
    mocks.start.mockImplementationOnce(() => { throw new Error('unavailable'); });
    expect(() => setPowerSaveBlockerMode('prevent-display-sleep')).toThrow('unavailable');
    expect(getPowerSaveBlockerMode()).toBe('prevent-app-suspension');
    expect(mocks.stop).not.toHaveBeenCalled();
  });
});
