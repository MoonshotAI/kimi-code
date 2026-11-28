import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ICONS } from '@moonshot-ai/app-ui/icons';
import { iconSvg } from '../../src/shared/icons';
import { mentionIconSvg, fileMentionIconSvg } from '../../src/features/mention/icons';

const pathsOf = (svg: string): string[] => [...svg.matchAll(/\bd="([^"]+)"/g)].map((match) => match[1]!);

describe('icons pipeline smoke', () => {
  it('resolves every composer icon to a sized svg string', () => {
    const names = ['file', 'folder', 'skill', 'session', 'copy', 'check', 'external-link', 'target', 'file-edit', 'close', 'attachment', 'image', 'video', 'fullscreen', 'quote', 'browser', 'text'] as const;
    for (const name of names) {
      const svg = iconSvg(name, 'sm');
      expect(svg, name).toContain('<svg');
      expect(svg, name).toContain('width="14"');
      expect(svg, name).toContain('aria-hidden="true"');
    }
    expect(mentionIconSvg('skill', '', '')).toContain('<svg');
    expect(fileMentionIconSvg('dir/')).toContain('<svg');
    expect(fileMentionIconSvg('a.ts')).toContain('<svg');
  });

  it('uses the exact same glyph geometry as the official app icon registry', () => {
    const officialMap = {
      file: 'file',
      folder: 'folder',
      skill: 'skill',
      session: 'message',
      copy: 'copy',
      check: 'check',
      'external-link': 'external-link',
      target: 'target',
      'file-edit': 'file-edit',
      close: 'close',
      attachment: 'attachment',
      image: 'image',
      fullscreen: 'expand',
      browser: 'browser',
      text: 'file-text',
    } as const;
    for (const [composerName, officialName] of Object.entries(officialMap)) {
      expect(pathsOf(iconSvg(composerName as keyof typeof officialMap, 'sm')), composerName)
        .toEqual(pathsOf(ICONS[officialName].svg));
    }
  });

  it('does not force a synthetic stroke onto pill icons in the shared stylesheet', () => {
    const css = readFileSync(new URL('../../../app-ui/src/style.css', import.meta.url), 'utf8');
    const ruleStart = css.indexOf('.mention-pill-icon svg,\n.attachment-pill-icon svg,\n.quote-pill-icon svg {');
    expect(ruleStart).toBeGreaterThanOrEqual(0);
    const rule = css.slice(ruleStart, css.indexOf('\n}', ruleStart));
    expect(rule).not.toContain('stroke:');
    expect(rule).not.toContain('stroke-width:');
  });
});
