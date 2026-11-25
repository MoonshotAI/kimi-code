import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function sfcStyle(relativePath: string): string {
  const sfc = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  return Array.from(sfc.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g), (match) => match[1]).join('\n');
}

describe('app-ui focus outline normalization', () => {
  const styleCss = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

  it('resets native UA focus outlines at zero specificity for all elements including containers', () => {
    expect(styleCss).toMatch(/:where\(\*\):focus\s*\{\s*outline:\s*none;\s*\}/);
  });

  it('applies a zero-specificity theme focus-visible outline only to interactive controls', () => {
    const match = styleCss.match(/:where\(([^)]*)\):focus-visible\s*\{([^}]*)\}/);
    expect(match).not.toBeNull();
    const selectors = match![1]!.split(',').map((entry) => entry.trim()).filter(Boolean);
    expect(selectors).toEqual([
      'button',
      '[type="button"]',
      '[type="reset"]',
      '[type="submit"]',
      '[type="checkbox"]',
      '[type="radio"]',
      '[type="range"]',
      '[type="color"]',
      'select',
      'summary',
      'a[href]',
      '[role="button"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[role="switch"]',
      '[role="checkbox"]',
      '[role="radio"]',
    ]);
    expect(match![2]).toContain('outline: 2px solid var(--color-accent-bd);');
    expect(match![2]).toContain('outline-offset: 1px;');
  });

  it('prevents composite sub-controls and menu options from double-ringing', () => {
    expect(sfcStyle('../src/components/ui/NumberInput.vue')).toMatch(
      /\.ui-number-input__step:focus,\s*\.ui-number-input__step:focus-visible\s*\{\s*outline:\s*none;\s*\}/,
    );
    expect(sfcStyle('../src/components/ui/Select.vue')).toMatch(
      /\.ui-select__option:focus,\s*\.ui-select__option:focus-visible\s*\{\s*outline:\s*none;\s*\}/,
    );
    expect(sfcStyle('../src/components/ui/Checkbox.vue')).toMatch(
      /\.ui-check__input:focus,\s*\.ui-check__input:focus-visible\s*\{\s*outline:\s*none;\s*\}/,
    );
  });
});
