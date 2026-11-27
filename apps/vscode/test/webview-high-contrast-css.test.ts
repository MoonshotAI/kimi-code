import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('VS Code webview high contrast code styles', () => {
  const css = readFileSync(fileURLToPath(new URL('../webview-ui/src/styles/index.css', import.meta.url)), 'utf8');

  it('pairs foreground, background and contrast border for code and kbd in high contrast themes', () => {
    const rule = css.match(/body\.vscode-high-contrast\s+:is\(code,\s*pre,\s*\.kbd\):not\(pre\s+code\)\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toContain('color: var(--vscode-editor-foreground)');
    expect(rule![1]).toContain('background-color: var(--vscode-textCodeBlock-background)');
    expect(rule![1]).toContain('border: 1px solid var(--vscode-contrastBorder');
    expect(css).toMatch(/body\.vscode-high-contrast\s+pre\s+code\s*\{\s*color:\s*inherit;\s*\}/);
  });
});
