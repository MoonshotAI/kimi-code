import type { Kaos } from '@moonshot-ai/kaos';
import { describe, expect, it } from 'vitest';

import {
  LIST_DIR_CHILD_WIDTH,
  listDirectory,
} from '../../src/tools/support/list-directory';
import { createFakeKaos } from './fixtures/fake-kaos';

describe('listDirectory', () => {
  it('renders a two-level tree with dirs first then files', async () => {
    const kaos = createFakeKaos({
      iterdir: async function* (p: string) {
        if (p === '/w') {
          yield '/w/src';
          yield '/w/README.md';
          yield '/w/package.json';
        } else if (p === '/w/src') {
          yield '/w/src/index.ts';
          yield '/w/src/utils.ts';
        }
      } as unknown as Kaos['iterdir'],
      stat: (async (p: string) => ({
        // list-directory reads stMode: S_IFDIR (0o040000) vs S_IFREG (0o100000).
        stMode: p.endsWith('src') ? 0o040_755 : 0o100_644,
        stIno: 1,
        stDev: 1,
        stNlink: 1,
        stUid: 0,
        stGid: 0,
        stSize: 1,
        stAtime: 0,
        stMtime: 0,
        stCtime: 0,
      })) as unknown as Kaos['stat'],
    });
    const tree = await listDirectory(kaos, '/w');
    expect(tree.split('\n')[0]).toContain('src/');
    expect(tree).toMatch(/README\.md(?!\/)/);
    expect(tree).toMatch(/index\.ts/);
    expect(tree).toMatch(/utils\.ts/);
  });

  it('uses the backend path class when reading child directories', async () => {
    const seenDirs: string[] = [];
    const kaos = createFakeKaos({
      pathClass: () => 'win32',
      iterdir: async function* (p: string) {
        seenDirs.push(p);
        const n = p.replaceAll('\\', '/');
        if (n === 'C:/workspace') {
          yield 'C:\\workspace\\src';
        } else if (n === 'C:/workspace/src') {
          yield 'C:\\workspace\\src\\index.ts';
        }
      } as unknown as Kaos['iterdir'],
      stat: (async (p: string) => ({
        stMode: p.replaceAll('\\', '/').endsWith('/src') ? 0o040_755 : 0o100_644,
        stIno: 1,
        stDev: 1,
        stNlink: 1,
        stUid: 0,
        stGid: 0,
        stSize: 1,
        stAtime: 0,
        stMtime: 0,
        stCtime: 0,
      })) as unknown as Kaos['stat'],
    });

    const tree = await listDirectory(kaos, 'C:\\workspace');

    expect(seenDirs).toEqual(['C:\\workspace', 'C:/workspace/src']);
    expect(tree).toContain('src/');
    expect(tree).toContain('index.ts');
  });

  it('returns "(empty directory)" when the dir has no entries', async () => {
    const kaos = createFakeKaos({
      // eslint-disable-next-line require-yield
      iterdir: async function* (_p: string) {} as unknown as Kaos['iterdir'],
    });
    const result = await listDirectory(kaos, '/empty');
    expect(result).toBe('(empty directory)');
  });

  it('truncates to LIST_DIR_ROOT_WIDTH entries at depth 0', async () => {
    const kaos = createFakeKaos({
      iterdir: async function* (_p: string) {
        for (let i = 0; i < 50; i++) {
          yield `/w/file_${String(i).padStart(2, '0')}.txt`;
        }
      } as unknown as Kaos['iterdir'],
      stat: (async () => ({
        stMode: 0o100_644,
        stIno: 1,
        stDev: 1,
        stNlink: 1,
        stUid: 0,
        stGid: 0,
        stSize: 1,
        stAtime: 0,
        stMtime: 0,
        stCtime: 0,
      })) as unknown as Kaos['stat'],
    });
    const tree = await listDirectory(kaos, '/w');
    expect(tree).toMatch(/\.\.\. and 20 more entries/);
  });

  it('returns [not readable] when the root directory itself is inaccessible', async () => {
    const kaos = createFakeKaos({
      iterdir: async function* (_p: string) {
        throw new Error('EACCES');
        // eslint-disable-next-line no-unreachable
        yield '';
      } as unknown as Kaos['iterdir'],
    } as Parameters<typeof createFakeKaos>[0]);
    const result = await listDirectory(kaos, '/no-access');
    expect(result).toBe('[not readable]');
  });

  it('shows [not readable] for inaccessible subdirectory', async () => {
    const kaos = createFakeKaos({
      iterdir: async function* (p: string) {
        if (p === '/w') {
          yield '/w/locked';
        } else {
          throw new Error('EACCES');
        }
      } as unknown as Kaos['iterdir'],
      stat: (async () => ({
        stMode: 0o040_000,
        stIno: 1,
        stDev: 1,
        stNlink: 1,
        stUid: 0,
        stGid: 0,
        stSize: 1,
        stAtime: 0,
        stMtime: 0,
        stCtime: 0,
      })) as unknown as Kaos['stat'],
    });
    const tree = await listDirectory(kaos, '/w');
    expect(tree).toContain('locked/');
    expect(tree).toContain('[not readable]');
  });

  it('still lists an entry as a file when stat() throws (covers the stat-catch path)', async () => {
    // Real-world parallel: a dangling symlink can iterdir() fine but throw
    // on stat. The entry must still appear, plain-name (no trailing slash).
    const kaos = createFakeKaos({
      iterdir: async function* (p: string) {
        if (p === '/w') {
          yield '/w/regular.txt';
          yield '/w/broken-link';
        }
      } as unknown as Kaos['iterdir'],
      stat: (async (p: string) => {
        if (p.endsWith('broken-link')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return {
          stMode: 0o100_644,
          stIno: 1,
          stDev: 1,
          stNlink: 1,
          stUid: 0,
          stGid: 0,
          stSize: 1,
          stAtime: 0,
          stMtime: 0,
          stCtime: 0,
        };
      }) as unknown as Kaos['stat'],
    });

    const tree = await listDirectory(kaos, '/w');
    expect(tree).toContain('regular.txt');
    expect(tree).toContain('broken-link');
    expect(tree).not.toContain('broken-link/');
  });

  it('truncates child entries at LIST_DIR_CHILD_WIDTH and prints overflow under the parent', async () => {
    const overflow = 5;
    const childCount = LIST_DIR_CHILD_WIDTH + overflow;
    const kaos = createFakeKaos({
      iterdir: async function* (p: string) {
        if (p === '/w') {
          yield '/w/subdir';
        } else if (p === '/w/subdir') {
          for (let i = 0; i < childCount; i++) {
            yield `/w/subdir/child_${String(i).padStart(3, '0')}.txt`;
          }
        }
      } as unknown as Kaos['iterdir'],
      stat: (async (p: string) => ({
        stMode: p.endsWith('subdir') ? 0o040_755 : 0o100_644,
        stIno: 1,
        stDev: 1,
        stNlink: 1,
        stUid: 0,
        stGid: 0,
        stSize: 1,
        stAtime: 0,
        stMtime: 0,
        stCtime: 0,
      })) as unknown as Kaos['stat'],
    });

    const tree = await listDirectory(kaos, '/w');
    const lines = tree.split('\n');
    expect(lines).toHaveLength(1 + LIST_DIR_CHILD_WIDTH + 1);
    expect(lines[0]).toContain('subdir/');
    expect(lines.at(-1)).toBe(`    └── ... and ${String(overflow)} more`);
  });

  it('uses a 4-space prefix (not "│   ") when the last root entry is a directory', async () => {
    // Branch lockdown: when there is no sibling after a dir, child rows
    // align under a blank gutter — `└── only_dir/\n    └── child.txt`.
    const kaos = createFakeKaos({
      iterdir: async function* (p: string) {
        if (p === '/w') {
          yield '/w/only_dir';
        } else if (p === '/w/only_dir') {
          yield '/w/only_dir/child.txt';
        }
      } as unknown as Kaos['iterdir'],
      stat: (async (p: string) => ({
        stMode: p.endsWith('only_dir') ? 0o040_755 : 0o100_644,
        stIno: 1,
        stDev: 1,
        stNlink: 1,
        stUid: 0,
        stGid: 0,
        stSize: 1,
        stAtime: 0,
        stMtime: 0,
        stCtime: 0,
      })) as unknown as Kaos['stat'],
    });

    const tree = await listDirectory(kaos, '/w');
    expect(tree).toBe('└── only_dir/\n    └── child.txt');
  });

  it('collapses hidden directories without hiding hidden files when requested', async () => {
    const seenDirs: string[] = [];
    const kaos = createFakeKaos({
      iterdir: async function* (p: string) {
        seenDirs.push(p);
        if (p === '/w') {
          yield '/w/.git';
          yield '/w/.gitignore';
          yield '/w/src';
        } else if (p === '/w/.git') {
          yield '/w/.git/HEAD';
        } else if (p === '/w/src') {
          yield '/w/src/index.ts';
        }
      } as unknown as Kaos['iterdir'],
      stat: (async (p: string) => ({
        stMode: p.endsWith('.git') || p.endsWith('src') ? 0o040_755 : 0o100_644,
        stIno: 1,
        stDev: 1,
        stNlink: 1,
        stUid: 0,
        stGid: 0,
        stSize: 1,
        stAtime: 0,
        stMtime: 0,
        stCtime: 0,
      })) as unknown as Kaos['stat'],
    });

    const expanded = await listDirectory(kaos, '/w');
    expect(expanded).toContain('.git/');
    expect(expanded).toContain('HEAD');

    seenDirs.length = 0;
    const collapsed = await listDirectory(kaos, '/w', { collapseHiddenDirs: true });
    expect(collapsed).toContain('.git/');
    expect(collapsed).toContain('.gitignore');
    expect(collapsed).toContain('src/');
    expect(collapsed).toContain('index.ts');
    expect(collapsed).not.toContain('HEAD');
    expect(seenDirs).toEqual(['/w', '/w/src']);
  });
});
