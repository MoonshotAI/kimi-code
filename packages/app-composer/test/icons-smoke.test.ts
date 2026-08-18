import { describe, expect, it } from 'vitest';
import { iconSvg } from '../src/icons';
import { mentionIconSvg, fileMentionIconSvg } from '../src/mentionIcons';

describe('icons pipeline smoke', () => {
  it('resolves ~icons virtuals to sized svg strings', () => {
    for (const name of ['file', 'folder', 'skill', 'copy', 'check', 'external-link'] as const) {
      const svg = iconSvg(name, 'sm');
      expect(svg).toContain('<svg');
      expect(svg).toContain('width="14"');
      expect(svg).toContain('aria-hidden="true"');
    }
    expect(mentionIconSvg('skill', '', '')).toContain('<svg');
    expect(fileMentionIconSvg('dir/')).toContain('<svg');
    expect(fileMentionIconSvg('a.ts')).toContain('<svg');
  });
});
