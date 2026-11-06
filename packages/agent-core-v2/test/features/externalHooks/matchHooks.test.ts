import { describe, expect, it } from 'vitest';
import { compileMatcher, matches } from '../../../src/features/externalHooks/internal/matchHooks';

describe('matchHooks', () => {
  describe('compileMatcher', () => {
    it('compiles standard regular expressions without flags', () => {
      const regex = compileMatcher('Bash|Write');
      expect(regex.test('Bash')).toBe(true);
      expect(regex.test('bash')).toBe(false);
      expect(regex.flags).toBe('');
    });

    it('extracts inline (?i) flag for case-insensitive matching', () => {
      const regex = compileMatcher('(?i)(read|write|edit)');
      expect(regex.flags).toBe('i');
      expect(regex.test('Read')).toBe(true);
      expect(regex.test('WRITE')).toBe(true);
      expect(regex.test('edit')).toBe(true);
      expect(regex.test('bash')).toBe(false);
    });

    it('extracts multiple inline flags like (?im) or (?i)(?m)', () => {
      const regex1 = compileMatcher('(?im)^test');
      expect(regex1.flags).toContain('i');
      expect(regex1.flags).toContain('m');

      const regex2 = compileMatcher('(?i)(?m)^test');
      expect(regex2.flags).toContain('i');
      expect(regex2.flags).toContain('m');
    });

    it('deduplicates duplicate flags correctly', () => {
      const regex = compileMatcher('(?i)(?i)test');
      expect(regex.flags).toBe('i');
    });
  });

  describe('matches', () => {
    it('returns true when pattern is empty', () => {
      expect(matches('', 'anything')).toBe(true);
    });

    it('matches case-insensitively with inline (?i) prefix', () => {
      expect(matches('(?i)(read|write|edit)', 'Read')).toBe(true);
      expect(matches('(?i)(read|write|edit)', 'WRITE')).toBe(true);
      expect(matches('(?i)(read|write|edit)', 'edit')).toBe(true);
      expect(matches('(?i)(read|write|edit)', 'bash')).toBe(false);
    });

    it('matches exact regex expressions', () => {
      expect(matches('^Bash$', 'Bash')).toBe(true);
      expect(matches('^Bash$', 'BashCommand')).toBe(false);
    });

    it('fails safely and returns false on malformed regex syntax', () => {
      expect(matches('(?invalid', 'test')).toBe(false);
      expect(matches('[unclosed', 'test')).toBe(false);
    });
  });
});
