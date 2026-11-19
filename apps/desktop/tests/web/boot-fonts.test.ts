import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const bootJs = readFileSync(fileURLToPath(new URL('../../src/renderer/public/boot.js', import.meta.url)), 'utf8');

function runBoot(fonts: unknown): Map<string, string> {
  const props = new Map<string, string>();
  const store: Record<string, string> = { 'kimi-web.fonts': JSON.stringify(fonts) };
  runInNewContext(bootJs, {
    localStorage: { getItem: (key: string) => store[key] ?? null },
    document: {
      documentElement: {
        dataset: {},
        style: { setProperty: (name: string, value: string) => props.set(name, value) },
      },
    },
  });
  return props;
}

describe('boot.js font prefs', () => {
  it('applies each target by mode before the bundle runs', () => {
    const props = runBoot({
      ui: { mode: 'custom', families: ['Inter', '-apple-system', 'sans-serif', 'Ignored'], regular: 300, features: '"ss01" 1' },
      transcript: { mode: 'same' },
      code: { mode: 'kimi', families: ['Menlo'] },
      terminal: { mode: 'same', size: 15 },
    });
    expect(Object.fromEntries(props)).toEqual({
      '--user-font-ui': '"Inter", system-ui',
      '--user-font-transcript': '"Inter", system-ui',
      '--user-font-mono': '"JetBrains Mono Variable"',
      '--user-font-terminal': '"JetBrains Mono Variable"',
      '--user-terminal-size': '15px',
    });
  });

  it('leaves system rows and legacy unfollowed rows on their own lists', () => {
    const props = runBoot({
      ui: { mode: 'system', families: ['Inter'] },
      transcript: { families: ['LXGW WenKai'], follow: false },
      code: { families: [] },
    });
    expect(Object.fromEntries(props)).toEqual({ '--user-font-transcript': '"LXGW WenKai"' });
  });
});
