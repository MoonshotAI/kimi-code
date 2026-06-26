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

    it('honors explicit "off"', () => {
      expect(resolveThinkingEffort('off', { effort: 'high' })).toBe('off');
    });

    it('maps "on" to the configured effort', () => {
      expect(resolveThinkingEffort('on', { effort: 'medium' })).toBe('medium');
    });

    it('parses a named effort', () => {
      expect(resolveThinkingEffort('xhigh', undefined)).toBe('xhigh');
    });

    it('falls back to config effort for unknown value', () => {
      expect(resolveThinkingEffort('bogus', { effort: 'low' })).toBe('low');
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
