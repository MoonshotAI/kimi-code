import { describe, expect, it } from 'vitest';
import { BUILTIN_OUTPUT_STYLES } from '../../src/output-style/builtin';
describe('BUILTIN_OUTPUT_STYLES', () => {
  it('ships concise and explanatory, all builtin-sourced with non-empty bodies', () => {
    expect(BUILTIN_OUTPUT_STYLES.map((s) => s.name).toSorted()).toEqual(['concise', 'explanatory']);
    for (const s of BUILTIN_OUTPUT_STYLES) {
      expect(s.source).toBe('builtin');
      expect(s.body.trim().length).toBeGreaterThan(0);
      expect(s.description.trim().length).toBeGreaterThan(0);
    }
  });
});
