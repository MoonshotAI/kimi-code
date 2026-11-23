import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const layerCss = readFileSync(join(repoRoot, 'packages/app-ui/src/menu-layer.css'), 'utf8');
const styleCss = readFileSync(join(repoRoot, 'packages/app-ui/src/style.css'), 'utf8');

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collect(path, out);
    else if (entry.name.endsWith('.vue') || entry.name.endsWith('.css')) out.push(path);
  }
  return out;
}

const clientFiles = [
  ...readdirSync(join(repoRoot, 'packages'))
    .filter(name => name.startsWith('app-'))
    .flatMap(name => collect(join(repoRoot, 'packages', name, 'src'))),
  ...collect(join(repoRoot, 'apps/desktop/src/renderer')),
].filter(path => !path.endsWith('menu-layer.css'));

describe('menu layer', () => {
  it('ships the shared menu classes through the app-ui stylesheet', () => {
    expect(styleCss).toContain("@import './menu-layer.css';");
    for (const selector of [
      '.ui-menu-floating {',
      '.ui-menu-pop-enter-active {',
      '.ui-menu-pop-leave-active {',
      '.ui-menu-pop-enter-from,',
      '.ui-menu-fade-enter-active {',
      '.ui-menu-fade-leave-active {',
      '.ui-menu-fade-enter-from,',
    ]) {
      expect(layerCss).toContain(selector);
    }
    expect(layerCss).toContain('transform: scale(0.97) translateY(var(--menu-pop-shift, -2px));');
    expect(layerCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.ui-menu-pop-enter-active[\s\S]*\.ui-menu-fade-leave-active[\s\S]*transition: none;/);
  });

  it('keeps menu transitions and the floating layer out of component styles', () => {
    const offenders = clientFiles.filter(path => {
      const source = readFileSync(path, 'utf8');
      return /^\s*\.[\w-]*menu-(?:pop|fade)-(?:enter|leave)/m.test(source)
        || /<Transition name="(?!ui-menu-(?:pop|fade)")[\w-]*menu-(?:pop|fade)"/.test(source)
        || /position: fixed;\s*top: 0;\s*left: 0;\s*z-index: var\(--z-dropdown\);/.test(source);
    });
    expect(offenders.map(path => path.slice(repoRoot.length))).toEqual([]);
  });
});
