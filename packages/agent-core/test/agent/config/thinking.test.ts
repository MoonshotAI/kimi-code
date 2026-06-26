import { describe, expect, it } from 'vitest';

import { effectiveDefaultEffort, resolveThinkingEffort } from '../../../src/agent/config/thinking';

describe('resolveThinkingEffort', () => {
  describe('without explicit request', () => {
    it('defaults to high when no config is provided', () => {
      expect(resolveThinkingEffort(undefined, undefined)).toBe('high');
    });

    it('returns off when config mode is off', () => {
      expect(resolveThinkingEffort(undefined, { mode: 'off' })).toBe('off');
    });

    it('returns high when config mode is on without explicit effort', () => {
      expect(resolveThinkingEffort(undefined, { mode: 'on' })).toBe('high');
    });

    it('returns explicit effort when both mode=on and effort are set', () => {
      expect(resolveThinkingEffort(undefined, { mode: 'on', effort: 'medium' })).toBe('medium');
    });

    it('uses effort even when mode is omitted', () => {
      expect(resolveThinkingEffort(undefined, { effort: 'low' })).toBe('low');
    });

    it('returns off when mode is off even if effort is set', () => {
      expect(resolveThinkingEffort(undefined, { mode: 'off', effort: 'high' })).toBe('off');
    });
  });

  describe('with explicit request', () => {
    it('returns off when request is "off" regardless of config', () => {
      expect(resolveThinkingEffort('off', { mode: 'on', effort: 'medium' })).toBe('off');
    });

    it('returns config effort when request is "on" and config has effort', () => {
      expect(resolveThinkingEffort('on', { effort: 'medium' })).toBe('medium');
    });

    it('returns high when request is "on" and config has no effort', () => {
      expect(resolveThinkingEffort('on', undefined)).toBe('high');
    });

    it('returns explicit effort level when request is a level name', () => {
      expect(resolveThinkingEffort('xhigh', undefined)).toBe('xhigh');
    });

    it('falls back to config effort when request is unknown', () => {
      expect(resolveThinkingEffort('bogus', { effort: 'low' })).toBe('low');
    });

    it('falls back to default high when request is unknown and no config', () => {
      expect(resolveThinkingEffort('bogus', undefined)).toBe('high');
    });

    it('normalizes case and whitespace', () => {
      expect(resolveThinkingEffort('  Medium ', undefined)).toBe('medium');
      expect(resolveThinkingEffort('OFF', { mode: 'on' })).toBe('off');
    });
  });

  describe('default behavior', () => {
    it('uses high as the concrete effort for the default-on state', () => {
      expect(resolveThinkingEffort(undefined, undefined)).toBe('high');
      expect(resolveThinkingEffort('on', undefined)).toBe('high');
    });
  });

  describe('model default effort fallback', () => {
    it('uses modelDefaultEffort when thinking.effort is unset', () => {
      expect(resolveThinkingEffort(undefined, undefined, 'max')).toBe('max');
      expect(resolveThinkingEffort('on', undefined, 'max')).toBe('max');
    });

    it('uses modelDefaultEffort when thinking.effort is invalid', () => {
      expect(resolveThinkingEffort(undefined, { effort: 'bogus' }, 'max')).toBe('max');
    });

    it('prefers a valid thinking.effort over modelDefaultEffort', () => {
      expect(resolveThinkingEffort(undefined, { effort: 'low' }, 'max')).toBe('low');
    });

    it('falls back to high when neither thinking.effort nor modelDefaultEffort is usable', () => {
      expect(resolveThinkingEffort(undefined, undefined, 'bogus')).toBe('high');
      expect(resolveThinkingEffort(undefined, { effort: 'bogus' }, 'bogus')).toBe('high');
    });

    it('honours off regardless of modelDefaultEffort', () => {
      expect(resolveThinkingEffort('off', undefined, 'max')).toBe('off');
      expect(resolveThinkingEffort(undefined, { mode: 'off' }, 'max')).toBe('off');
    });
  });
});

describe('effectiveDefaultEffort', () => {
  it('returns the declared defaultEffort when present', () => {
    expect(effectiveDefaultEffort({ defaultEffort: 'max', supportEfforts: ['low', 'high', 'max'] })).toBe(
      'max',
    );
  });

  it('falls back to the middle supportEfforts entry when defaultEffort is absent', () => {
    expect(effectiveDefaultEffort({ supportEfforts: ['low', 'high', 'max'] })).toBe('high');
    expect(effectiveDefaultEffort({ supportEfforts: ['low', 'medium', 'high'] })).toBe('medium');
    expect(effectiveDefaultEffort({ supportEfforts: ['low', 'high'] })).toBe('high');
    expect(effectiveDefaultEffort({ supportEfforts: ['low'] })).toBe('low');
  });

  it('returns undefined when neither defaultEffort nor supportEfforts are present', () => {
    expect(effectiveDefaultEffort({})).toBeUndefined();
    expect(effectiveDefaultEffort({ supportEfforts: [] })).toBeUndefined();
  });
});
