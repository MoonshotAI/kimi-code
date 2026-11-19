import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../..');
const formatterFile = resolve(__dirname, '../src/lib/shortcutKeys.ts');
const sourceRoots = ['apps/desktop/src', 'packages'];
const modifierSymbol = /[⌘⌃⌥⇧]/;
const lonelyKeySymbol = /(['"`])[↵⇥⌫]\1/;

function writesKeySymbol(line: string): boolean {
  return modifierSymbol.test(line) || lonelyKeySymbol.test(line);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'test') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(vue|ts)$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('shortcut key sources', () => {
  it('pass key names instead of key symbols to shortcut displays', () => {
    const offenders = sourceRoots
      .flatMap((root) => sourceFiles(join(repoRoot, root)))
      .filter((file) => file !== formatterFile)
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .flatMap((line, index) => (writesKeySymbol(line) ? [`${relative(repoRoot, file)}:${index + 1}`] : [])),
      );
    expect(offenders).toEqual([]);
  });

  it('flags hand-written modifier symbols alone or inside other text', () => {
    expect(writesKeySymbol(`<Kbd :keys="isMac ? ['⌘', 'K'] : ['Ctrl', 'K']" />`)).toBe(true);
    expect(writesKeySymbol(`const hint = isApplePlatform() ? '⌘↩' : '⌃↩';`)).toBe(true);
    expect(writesKeySymbol('<span>⇧⌘B</span>')).toBe(true);
    expect(writesKeySymbol(`<Kbd :keys="['↵']" />`)).toBe(true);
  });

  it('allows key names and arrow or enter glyphs inside copy', () => {
    expect(writesKeySymbol(`<Kbd :keys="['mod', 'k']" />`)).toBe(false);
    expect(writesKeySymbol(`send: 'Send ↵',`)).toBe(false);
    expect(writesKeySymbol(`hint: '↑↓ to select · ↵ to open',`)).toBe(false);
  });
});
