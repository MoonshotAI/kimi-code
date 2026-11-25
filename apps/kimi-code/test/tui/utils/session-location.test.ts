import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { planResume, sessionLocationTags } from '#/tui/utils/session-location';
import { isDirectoryAsync } from '#/utils/session-directory';

describe('session-location', () => {
  const createdDirs: string[] = [];

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    createdDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks directory existence asynchronously for dirs, files, and missing paths', async () => {
    const dir = tempDir('kimi-is-dir-async-');
    const file = join(dir, 'file.txt');
    writeFileSync(file, 'hello');

    await expect(isDirectoryAsync(dir)).resolves.toBe(true);
    await expect(isDirectoryAsync(file)).resolves.toBe(false);
    await expect(isDirectoryAsync(join(dir, 'missing'))).resolves.toBe(false);
  });

  it('tags missing, plain, and worktree directories while deduplicating workDirs', async () => {
    const plain = tempDir('kimi-loc-plain-');
    const wt = tempDir('kimi-loc-wt-');
    const missing = join(plain, 'deleted');
    const resolveWorkLocation = vi.fn(async (cwd: string) => ({
      cwd,
      projectRoot: plain,
      isGitRepo: true,
      ...(cwd === wt ? { worktree: { root: wt, name: 'fix-auth', repoRoot: plain } } : {}),
    }));

    const tags = await sessionLocationTags({ resolveWorkLocation }, [
      { workDir: plain },
      { workDir: plain },
      { workDir: wt },
      { workDir: missing },
    ]);

    expect(resolveWorkLocation).toHaveBeenCalledTimes(2);
    expect(tags.get(plain)).toEqual({ worktree: undefined, missing: false });
    expect(tags.get(wt)).toEqual({ worktree: 'fix-auth', missing: false });
    expect(tags.get(missing)).toEqual({ missing: true });
  });

  it('bounds concurrent directory probes and stops early when cancelled', async () => {
    const dirs = Array.from({ length: 16 }, (_, index) => tempDir(`kimi-loc-conc-${index}-`));
    let inFlight = 0;
    let maxInFlight = 0;
    const resolvers: Array<() => void> = [];
    const resolveWorkLocation = vi.fn(
      (cwd: string) =>
        new Promise<{ cwd: string; projectRoot: string; isGitRepo: boolean }>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          resolvers.push(() => {
            inFlight -= 1;
            resolve({ cwd, projectRoot: cwd, isGitRepo: false });
          });
        }),
    );

    let cancelled = false;
    const promise = sessionLocationTags(
      { resolveWorkLocation },
      dirs.map((workDir) => ({ workDir })),
      { isCancelled: () => cancelled },
    );

    await vi.waitFor(() => {
      expect(resolveWorkLocation).toHaveBeenCalledTimes(8);
    });
    expect(maxInFlight).toBe(8);

    cancelled = true;
    for (const release of resolvers.splice(0)) release();

    const tags = await promise;
    expect(resolveWorkLocation).toHaveBeenCalledTimes(8);
    expect(tags.size).toBe(8);
  });

  it('plans same-project switch with missing detection asynchronously', async () => {
    const project = tempDir('kimi-plan-project-');
    const missing = join(project, 'gone');
    const resolveWorkLocation = vi.fn();

    const plan = await planResume(
      { resolveWorkLocation },
      { workDir: missing, projectWorkDir: project },
      { workDir: project, projectRoot: project, isGitRepo: true },
    );

    expect(resolveWorkLocation).not.toHaveBeenCalled();
    expect(plan).toEqual({
      kind: 'switch',
      missing: true,
      location: { cwd: missing, projectRoot: project, isGitRepo: true },
    });
  });
});
