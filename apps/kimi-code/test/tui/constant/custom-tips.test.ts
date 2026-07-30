import { afterEach, describe, expect, it } from 'vitest';

import {
  ALL_TIPS,
  WORKING_TIPS,
  configureCustomTips,
  getAllTips,
  getCustomTipsConfig,
  getWorkingTips,
  tipsConfigVersion,
} from '#/tui/constant/tips';

afterEach(() => {
  configureCustomTips('append', []);
});

describe('configureCustomTips', () => {
  it('appends custom tips to the built-in lists by default', () => {
    configureCustomTips('append', ['Accidental Virtue']);
    expect(getWorkingTips().some((t) => t.text === 'Accidental Virtue')).toBe(true);
    expect(getAllTips().some((t) => t.text === 'Accidental Virtue')).toBe(true);
    expect(getWorkingTips().length).toBe(WORKING_TIPS.length + 1);
    expect(getAllTips().length).toBe(ALL_TIPS.length + 1);
  });

  it('replace mode shows only custom tips', () => {
    configureCustomTips('replace', ['Accidental Virtue', 'Quantum Truss']);
    expect(getWorkingTips().map((t) => t.text)).toEqual(['Accidental Virtue', 'Quantum Truss']);
    expect(getAllTips().map((t) => t.text)).toEqual(['Accidental Virtue', 'Quantum Truss']);
  });

  it('replace mode with an empty list falls back to built-ins', () => {
    configureCustomTips('replace', []);
    expect(getWorkingTips().length).toBe(WORKING_TIPS.length);
    expect(getAllTips().length).toBe(ALL_TIPS.length);
  });

  it('trims and drops empty entries', () => {
    configureCustomTips('append', ['  Padded  ', '', '   ']);
    expect(getWorkingTips().some((t) => t.text === 'Padded')).toBe(true);
    expect(getWorkingTips().length).toBe(WORKING_TIPS.length + 1);
  });

  it('bumps the version only on effective changes', () => {
    const v0 = tipsConfigVersion();
    configureCustomTips('append', []);
    expect(tipsConfigVersion()).toBe(v0);
    configureCustomTips('append', ['New Verb']);
    expect(tipsConfigVersion()).toBe(v0 + 1);
    configureCustomTips('append', ['New Verb']);
    expect(tipsConfigVersion()).toBe(v0 + 1);
    configureCustomTips('replace', ['New Verb']);
    expect(tipsConfigVersion()).toBe(v0 + 2);
  });

  it('getCustomTipsConfig round-trips the configured state', () => {
    configureCustomTips('replace', ['One', 'Two']);
    expect(getCustomTipsConfig()).toEqual({ mode: 'replace', custom: ['One', 'Two'] });
    configureCustomTips('append', []);
    expect(getCustomTipsConfig()).toEqual({ mode: 'append', custom: [] });
  });
});
