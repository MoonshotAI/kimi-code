import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('VS Code webview stylesheet focus outline normalization', () => {
  it('suppresses VS Code host default focus outlines and scopes focus-visible to interactive controls', () => {
    const css = readFileSync(fileURLToPath(new URL('../webview-ui/src/styles/index.css', import.meta.url)), 'utf8');
    expect(css).toMatch(/a:focus,\s*input:focus,\s*select:focus,\s*textarea:focus\s*\{\s*outline:\s*none;\s*\}/);
    expect(css).toMatch(/input\[type="checkbox"\][\s\S]*?:not\(\[data-slot\]\):focus-visible/);
    expect(css).toMatch(/:where\(\*\):focus\s*\{\s*outline:\s*none;\s*\}/);
    const match = css.match(/:where\(([^)]*)\):focus-visible\s*\{([^}]*)\}/);
    expect(match).not.toBeNull();
    const selectors = match![1]!.split(',').map((entry) => entry.trim()).filter(Boolean);
    expect(selectors).toContain('button');
    expect(selectors).toContain('[role="radio"]');
    expect(match![2]).toContain('outline: 2px solid color-mix(in oklab, var(--ring) 50%, transparent);');
  });
});
