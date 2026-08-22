import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath, { win32 } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canonicalWorkspaceRoot, findUpwardRoot, resolvePath, subtreeWatchFilter } from '#/_base/utils/paths';

describe('subtree watch filtering', () => {
  const root = '/repo';
  const candidates = ['/repo/.kimi-code/skills', '/repo/.agents/skills'];

  it('keeps the root, candidate ancestors and candidate subtrees watched', () => {
    const ignored = subtreeWatchFilter(root, candidates);
    expect(ignored('/repo')).toBe(false);
    expect(ignored('/repo/.agents')).toBe(false);
    expect(ignored('/repo/.agents/skills')).toBe(false);
    expect(ignored('/repo/.agents/skills/demo/SKILL.md')).toBe(false);
    expect(ignored('/repo/src')).toBe(true);
    expect(ignored('/repo/src/index.ts')).toBe(true);
  });

  it('prunes what an excluded entry hides from the scanner, keeps what it still probes', () => {
    const ignored = subtreeWatchFilter(root, candidates, {
      maxDepth: 3,
      skipEntry: (name) => name === 'node_modules' || name.startsWith('.'),
      keepEntryFile: 'SKILL.md',
    });
    expect(ignored('/repo/.agents/skills/demo/node_modules')).toBe(false);
    expect(ignored('/repo/.agents/skills/demo/node_modules/SKILL.md')).toBe(false);
    expect(ignored('/repo/.agents/skills/demo/.hidden')).toBe(false);
    expect(ignored('/repo/.agents/skills/demo/.hidden/SKILL.md')).toBe(false);
    expect(ignored('/repo/.agents/skills/.flat.md')).toBe(false);
    expect(ignored('/repo/.agents/skills/demo/node_modules/pkg')).toBe(true);
    expect(ignored('/repo/.agents/skills/demo/node_modules/pkg/x.js')).toBe(true);
    expect(ignored('/repo/.agents/skills/demo/.venv/bin/python')).toBe(true);
    expect(ignored('/repo/.agents/skills/demo/scripts/run.sh')).toBe(false);
    expect(ignored('/repo/.agents/skills/a/b/c/d/e/f/SKILL.md')).toBe(true);
  });

  it('prunes an excluded entry beyond itself when no keepEntryFile is set', () => {
    const ignored = subtreeWatchFilter(root, candidates, {
      skipEntry: (name) => name === 'node_modules',
    });
    expect(ignored('/repo/.agents/skills/demo/node_modules')).toBe(false);
    expect(ignored('/repo/.agents/skills/demo/node_modules/SKILL.md')).toBe(true);
    expect(ignored('/repo/.agents/skills/demo/node_modules/pkg')).toBe(true);
  });

  it('applies max depth before excluded-entry exceptions', () => {
    const ignored = subtreeWatchFilter(root, candidates, {
      maxDepth: 3,
      skipEntry: (name) => name === 'node_modules',
      keepEntryFile: 'SKILL.md',
    });
    expect(ignored('/repo/.agents/skills/demo/a/b/node_modules')).toBe(true);
    expect(ignored('/repo/.agents/skills/demo/a/b/node_modules/SKILL.md')).toBe(true);
  });

  it('never prunes the candidate ancestor chain itself', () => {
    const ignored = subtreeWatchFilter(root, candidates, {
      skipEntry: (name) => name.startsWith('.'),
    });
    expect(ignored('/repo/.agents')).toBe(false);
    expect(ignored('/repo/.agents/skills')).toBe(false);
    expect(ignored('/repo/.agents/skills/demo')).toBe(false);
  });

  it('keeps direct probes but prunes payload below a terminal bundle', () => {
    const ignored = subtreeWatchFilter(root, candidates, {
      scannedDirectories: ['/repo/.agents/skills'],
      keepEntryFile: 'SKILL.md',
    });
    expect(ignored('/repo/.agents/skills/demo')).toBe(false);
    expect(ignored('/repo/.agents/skills/demo/SKILL.md')).toBe(false);
    expect(ignored('/repo/.agents/skills/demo/runtime')).toBe(true);
    expect(ignored('/repo/.agents/skills/demo/runtime/0.py')).toBe(true);
    expect(ignored('/repo/.agents/skills/.flat.md')).toBe(false);
  });

  it('keeps direct bundle probes when the candidate root has not been scanned yet', () => {
    const ignored = subtreeWatchFilter(root, candidates, {
      scannedDirectories: [],
      keepEntryFile: 'SKILL.md',
    });
    expect(ignored('/repo/.agents/skills/new-skill')).toBe(false);
    expect(ignored('/repo/.agents/skills/new-skill/SKILL.md')).toBe(false);
    expect(ignored('/repo/.agents/skills/new-skill/runtime')).toBe(true);
  });

  it('keeps direct sub-skill probes below a directory the scanner traversed', () => {
    const ignored = subtreeWatchFilter(root, candidates, {
      scannedDirectories: [
        '/repo/.agents/skills',
        '/repo/.agents/skills/parent',
      ],
      keepEntryFile: 'SKILL.md',
    });
    expect(ignored('/repo/.agents/skills/parent/child')).toBe(false);
    expect(ignored('/repo/.agents/skills/parent/child/SKILL.md')).toBe(false);
    expect(ignored('/repo/.agents/skills/parent/child/runtime')).toBe(true);
  });
});

describe('findUpwardRoot', () => {
  const noMarker = async () => false;

  describe('with host-default path semantics', () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(nodePath.join(tmpdir(), 'upward-root-'));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const hasMarker = async (markerPath: string): Promise<boolean> => {
      try {
        await stat(markerPath);
        return true;
      } catch {
        return false;
      }
    };

    it('stops at the nearest ancestor holding the marker', async () => {
      await mkdir(nodePath.join(root, '.git'));
      const child = nodePath.join(root, 'src', 'pkg');
      await mkdir(child, { recursive: true });

      const found = await findUpwardRoot(child, '.git', hasMarker);

      expect(found).toBe(root.replaceAll('\\', '/'));
    });

    it('falls back to the working directory when no ancestor holds the marker', async () => {
      const child = nodePath.join(root, 'src', 'pkg');
      await mkdir(child, { recursive: true });

      const found = await findUpwardRoot(child, '.git', hasMarker);

      expect(found).toBe(child.replaceAll('\\', '/'));
    });
  });

  it('keeps a Windows drive-root working directory in host form', async () => {
    const found = await findUpwardRoot('E:\\', '.git', noMarker, win32);

    expect(found).toBe('E:/');
  });

  it('keeps a Windows UNC working directory in host form', async () => {
    const found = await findUpwardRoot('\\\\fs1\\share\\dir', '.git', noMarker, win32);

    expect(found).toBe('//fs1/share/dir');
  });

  it('stops at the nearest Windows ancestor holding the marker', async () => {
    const found = await findUpwardRoot(
      'E:\\repo\\src',
      '.git',
      async (markerPath) => markerPath === 'E:\\repo\\.git',
      win32,
    );

    expect(found).toBe('E:/repo');
  });
});

describe('resolvePath', () => {
  it('resolves drive-letter absolute values without joining the base', () => {
    expect(resolvePath('/repo', 'C:/tools')).toBe('C:/tools');
    expect(resolvePath('/repo', 'C:\\tools\\bin')).toBe('C:/tools/bin');
  });

  it('resolves values against a Windows base with win32 semantics', () => {
    expect(resolvePath('C:/repo', 'tools/mcp')).toBe('C:/repo/tools/mcp');
    expect(resolvePath('C:\\repo', '.\\tools')).toBe('C:/repo/tools');
    expect(resolvePath('C:/repo', 'D:/elsewhere')).toBe('D:/elsewhere');
  });

  it('keeps UNC bases and values intact', () => {
    expect(resolvePath('//server/share/repo', 'tools')).toBe('//server/share/repo/tools');
    expect(resolvePath('/repo', '//server/share/tools')).toBe('//server/share/tools');
    expect(resolvePath('\\\\server\\share\\repo', 'tools')).toBe('//server/share/repo/tools');
  });

  it('keeps POSIX resolution identical to plain absolute/normalize semantics', () => {
    expect(resolvePath('/repo', 'tools/../mcp')).toBe('/repo/mcp');
    expect(resolvePath('/repo', '/abs/path')).toBe('/abs/path');
  });
});

describe('canonicalWorkspaceRoot', () => {
  it('case-folds drive-letter spellings and strips trailing separators', () => {
    expect(canonicalWorkspaceRoot('C:\\Users\\Foo\\Repo')).toBe('c:/users/foo/repo');
    expect(canonicalWorkspaceRoot('C:/Users/Foo/Repo/')).toBe('c:/users/foo/repo');
  });

  it('keeps the UNC share slash and case-folds', () => {
    expect(canonicalWorkspaceRoot('//server/share/repo')).toBe('//server/share/repo');
    expect(canonicalWorkspaceRoot('\\\\SERVER\\SHARE\\REPO')).toBe('//server/share/repo');
  });

  it('resolves dot segments in Windows spellings', () => {
    expect(canonicalWorkspaceRoot('C:/Users/Foo/../Foo/Repo')).toBe('c:/users/foo/repo');
  });

  it('keeps POSIX roots untouched apart from trailing-slash and dot-segment cleanup', () => {
    expect(canonicalWorkspaceRoot('/Repo/Sub')).toBe('/Repo/Sub');
    expect(canonicalWorkspaceRoot('/Repo/Sub/')).toBe('/Repo/Sub');
    expect(canonicalWorkspaceRoot('/Repo/Sub/../Other')).toBe('/Repo/Other');
  });
});
