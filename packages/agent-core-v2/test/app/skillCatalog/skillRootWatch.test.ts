/**
 * Scenario: `SkillRootWatcher` candidate arming.
 *
 * Existing candidates get a depth-bounded recursive watch on their realpath,
 * nested symlink bundles are followed, and symlinked roots retain a lexical
 * anchor for deletion and retargeting. Missing candidates re-arm along their
 * lexical and last-known target chains. Uses the shared `stubHostFsWatch`
 * fake.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/skillCatalog/skillRootWatch.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SkillRootWatcher } from '#/app/skillCatalog/skillRootWatch';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { stubHostFsWatch } from '../../os/stubs';
import { createFakeHostFs } from '../../tools/fixtures/fake-exec';

function fakeHostFs(
  existingDirs: Set<string>,
  symlinkTargets: Map<string, string>,
): IHostFileSystem {
  return createFakeHostFs({
    stat: async (path) => {
      const target = symlinkTargets.get(path) ?? path;
      if (!existingDirs.has(target)) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return { isFile: false, isDirectory: true, size: 0 };
    },
    lstat: async (path) => {
      if (!symlinkTargets.has(path) && !existingDirs.has(path)) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return {
        isFile: false,
        isDirectory: !symlinkTargets.has(path),
        isSymbolicLink: symlinkTargets.has(path),
        size: 0,
      };
    },
    realpath: async (path) => symlinkTargets.get(path) ?? path,
  });
}

function makeWatcher(
  existingDirs: Set<string>,
  onChanged: () => void,
  symlinkTargets = new Map<string, string>(),
) {
  const watch = stubHostFsWatch();
  const watcher = new SkillRootWatcher(
    watch,
    fakeHostFs(existingDirs, symlinkTargets),
    onChanged,
  );
  return { watch, watcher };
}

describe('SkillRootWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('arms an existing candidate with a recursive target watch and debounces events', async () => {
    const existing = new Set(['/home', '/home/skills']);
    let fired = 0;
    const { watch, watcher } = makeWatcher(existing, () => {
      fired += 1;
    });
    try {
      await watcher.setPaths(['/home/skills']);

      expect(watch.watchedEntries()).toEqual([
        {
          path: '/home/skills',
          options: {
            recursive: true,
            followSymlinks: true,
            depth: 8,
            ignored: expect.any(Function),
          },
        },
      ]);

      watch.fire('/home/skills/added/SKILL.md', { action: 'created' });
      watch.fire('/home/skills/added/extra.md', { action: 'created' });
      await vi.advanceTimersByTimeAsync(300);

      expect(fired).toBe(1);
    } finally {
      watcher.dispose();
    }
  });

  it('arms a missing candidate on its nearest existing ancestor and re-arms when it appears', async () => {
    const existing = new Set(['/home']);
    let fired = 0;
    const { watch, watcher } = makeWatcher(existing, () => {
      fired += 1;
    });
    try {
      await watcher.setPaths(['/home/.agents/skills']);

      expect(watch.watchedEntries()).toEqual([
        { path: '/home', options: { recursive: false, ignored: expect.any(Function) } },
      ]);

      // A parent directory appearing only moves the anchor closer — no reload yet.
      existing.add('/home/.agents');
      watch.fire('/home/.agents', { action: 'created', kind: 'directory' });
      await vi.advanceTimersByTimeAsync(300);
      expect(fired).toBe(0);
      expect(watch.watchedPaths()).toEqual(['/home/.agents']);

      // The candidate itself appearing is a visible change.
      existing.add('/home/.agents/skills');
      watch.fire('/home/.agents/skills', { action: 'created', kind: 'directory' });
      await vi.advanceTimersByTimeAsync(300);
      expect(fired).toBe(1);
      expect(watch.watchedEntries()).toEqual([
        {
          path: '/home/.agents/skills',
          options: {
            recursive: true,
            followSymlinks: true,
            depth: 8,
            ignored: expect.any(Function),
          },
        },
      ]);
    } finally {
      watcher.dispose();
    }
  });

  it('re-arms onto the ancestor chain when the watched root is deleted', async () => {
    const existing = new Set(['/repo', '/repo/skills']);
    let fired = 0;
    const { watch, watcher } = makeWatcher(existing, () => {
      fired += 1;
    });
    try {
      await watcher.setPaths(['/repo/skills']);
      expect(watch.watchedPaths()).toEqual(['/repo/skills']);

      existing.delete('/repo/skills');
      watch.fire('/repo/skills', { action: 'deleted', kind: 'directory' });
      await vi.advanceTimersByTimeAsync(300);
      expect(fired).toBe(1);
      expect(watch.watchedEntries()).toEqual([
        { path: '/repo', options: { recursive: false, ignored: expect.any(Function) } },
      ]);

      existing.add('/repo/skills');
      watch.fire('/repo/skills', { action: 'created', kind: 'directory' });
      await vi.advanceTimersByTimeAsync(300);
      expect(fired).toBe(2);
      expect(watch.watchedPaths()).toEqual(['/repo/skills']);
    } finally {
      watcher.dispose();
    }
  });

  it('prunes events under node_modules and dot-directories to the traversal policy', async () => {
    const existing = new Set(['/home', '/home/skills']);
    let fired = 0;
    const { watch, watcher } = makeWatcher(existing, () => {
      fired += 1;
    });
    try {
      await watcher.setPaths(['/home/skills']);

      watch.fire('/home/skills/node_modules/dep/SKILL.md', { action: 'created' });
      watch.fire('/home/skills/.hidden/secret/SKILL.md', { action: 'created' });
      await vi.advanceTimersByTimeAsync(300);
      expect(fired).toBe(0);

      watch.fire('/home/skills/regular/SKILL.md', { action: 'created' });
      await vi.advanceTimersByTimeAsync(300);
      expect(fired).toBe(1);
    } finally {
      watcher.dispose();
    }
  });

  it('watches a symlinked root target recursively and its lexical parent shallowly', async () => {
    const existing = new Set(['/repo', '/targets/a']);
    const symlinkTargets = new Map([['/repo/skills', '/targets/a']]);
    const { watch, watcher } = makeWatcher(existing, () => {}, symlinkTargets);
    try {
      await watcher.setPaths(['/repo/skills']);

      expect(watch.watchedEntries()).toEqual([
        {
          path: '/targets/a',
          options: {
            recursive: true,
            followSymlinks: true,
            depth: 8,
            ignored: expect.any(Function),
          },
        },
        {
          path: '/repo',
          options: { recursive: false, ignored: expect.any(Function) },
        },
      ]);
    } finally {
      watcher.dispose();
    }
  });

  it('rebinds the recursive target when a symlinked root is retargeted', async () => {
    const existing = new Set(['/repo', '/targets/a', '/targets/b']);
    const symlinkTargets = new Map([['/repo/skills', '/targets/a']]);
    let fired = 0;
    const { watch, watcher } = makeWatcher(
      existing,
      () => {
        fired += 1;
      },
      symlinkTargets,
    );
    try {
      await watcher.setPaths(['/repo/skills']);
      symlinkTargets.set('/repo/skills', '/targets/b');

      watch.fire('/repo/skills', { action: 'modified', kind: 'file' });
      await vi.advanceTimersByTimeAsync(300);

      expect(fired).toBe(1);
      expect(watch.watchedPaths().toSorted()).toEqual(['/repo', '/targets/b']);
      watch.fire('/targets/a/SKILL.md', { action: 'modified' });
      await vi.advanceTimersByTimeAsync(300);
      expect(fired).toBe(1);
    } finally {
      watcher.dispose();
    }
  });

  it('re-arms a deleted symlink target from its target and lexical ancestors', async () => {
    const existing = new Set(['/repo', '/targets', '/targets/a']);
    const symlinkTargets = new Map([['/repo/skills', '/targets/a']]);
    let fired = 0;
    const { watch, watcher } = makeWatcher(
      existing,
      () => {
        fired += 1;
      },
      symlinkTargets,
    );
    try {
      await watcher.setPaths(['/repo/skills']);
      existing.delete('/targets/a');

      watch.fire('/targets/a', { action: 'deleted', kind: 'directory' });
      await vi.advanceTimersByTimeAsync(300);

      expect(fired).toBe(1);
      expect(watch.watchedPaths().toSorted()).toEqual(['/repo', '/targets']);

      existing.add('/targets/a');
      watch.fire('/targets/a', { action: 'created', kind: 'directory' });
      await vi.advanceTimersByTimeAsync(300);

      expect(fired).toBe(2);
      expect(watch.watchedPaths().toSorted()).toEqual(['/repo', '/targets/a']);
    } finally {
      watcher.dispose();
    }
  });

  it('disposes handles of candidates removed from the set', async () => {
    const existing = new Set(['/home', '/home/a', '/home/b']);
    let fired = 0;
    const { watch, watcher } = makeWatcher(existing, () => {
      fired += 1;
    });
    try {
      await watcher.setPaths(['/home/a', '/home/b']);
      expect(watch.watchedPaths().toSorted()).toEqual(['/home/a', '/home/b']);

      await watcher.setPaths(['/home/a']);
      expect(watch.watchedPaths()).toEqual(['/home/a']);

      watch.fire('/home/b/SKILL.md', { action: 'created' });
      await vi.advanceTimersByTimeAsync(300);
      expect(fired).toBe(0);
    } finally {
      watcher.dispose();
    }
  });
});
