import { describe, expect, it } from 'vitest';

import {
  resolveThinkingEffort,
  resolveThinkingLevel,
} from '#/config/thinking';

describe('config/thinking', () => {
  describe('resolveThinkingEffort', () => {
    it('returns config effort when no request', () => {
      expect(resolveThinkingEffort(undefined, { effort: 'low' })).toBe('low');
    });

    it('defaults to high when nothing configured', () => {
      expect(resolveThinkingEffort(undefined, undefined)).toBe('high');
    });

    it('returns off when config mode is off and no request is provided', () => {
      expect(resolveThinkingEffort(undefined, { mode: 'off' })).toBe('off');
    });

    it('returns high when config mode is on without explicit effort', () => {
      expect(resolveThinkingEffort(undefined, { mode: 'on' })).toBe('high');
    });

    it('returns explicit effort when both mode=on and effort are set', () => {
      expect(resolveThinkingEffort(undefined, { mode: 'on', effort: 'medium' })).toBe('medium');
    });

    it('returns off when mode is off even if effort is set', () => {
      expect(resolveThinkingEffort(undefined, { mode: 'off', effort: 'high' })).toBe('off');
    });

    it('honors explicit "off"', () => {
      expect(resolveThinkingEffort('off', { effort: 'high' })).toBe('off');
    });

    it('maps "on" to the configured effort', () => {
      expect(resolveThinkingEffort('on', { effort: 'medium' })).toBe('medium');
    });

    it('maps "on" to high when config has no effort', () => {
      expect(resolveThinkingEffort('on', undefined)).toBe('high');
    });

    it('parses a named effort', () => {
      expect(resolveThinkingEffort('xhigh', undefined)).toBe('xhigh');
    });

    it('falls back to config effort for unknown value', () => {
      expect(resolveThinkingEffort('bogus', { effort: 'low' })).toBe('low');
    });

    it('falls back to default high for unknown value with no config', () => {
      expect(resolveThinkingEffort('bogus', undefined)).toBe('high');
    });

    it('normalizes case and whitespace', () => {
      expect(resolveThinkingEffort('  Medium ', undefined)).toBe('medium');
      expect(resolveThinkingEffort('OFF', { mode: 'on' })).toBe('off');
    });

    it('uses high as the concrete effort for the default-on state', () => {
      expect(resolveThinkingEffort(undefined, undefined)).toBe('high');
      expect(resolveThinkingEffort('on', undefined)).toBe('high');
    });
  });

  describe('resolveThinkingLevel', () => {
    it('uses requested level when provided', () => {
      expect(resolveThinkingLevel('high', {})).toBe('high');
    });

    it('returns "off" when defaultThinking is false and no request', () => {
      expect(resolveThinkingLevel(undefined, { defaultThinking: false })).toBe('off');
    });

    it('honors thinking.mode = off', () => {
      expect(resolveThinkingLevel(undefined, { thinking: { mode: 'off' } })).toBe('off');
    });
  });
});
