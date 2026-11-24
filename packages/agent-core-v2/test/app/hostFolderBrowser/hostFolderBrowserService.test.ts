import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { IWorkspaceService } from '#/app/workspace/workspace';
import { HostFolderBrowser } from '#/app/hostFolderBrowser/hostFolderBrowserService';

const fakeRegistry = {
  list: async () => [],
} as unknown as IWorkspaceService;

describe('HostFolderBrowser', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    while (dirs.length > 0) {
      const dir = dirs.pop()!;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('includes symlinked directories and skips broken, looped, and file symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-folder-browser-'));
    dirs.push(root);

    const projects = join(root, 'projects');
    const external = join(root, 'external');
    const targetDir = join(projects, 'real-dir');
    const targetFile = join(root, 'file.txt');

    await mkdir(projects, { recursive: true });
    await mkdir(external, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await writeFile(targetFile, 'hello', 'utf8');

    await symlink(targetDir, join(projects, 'internal-link'));
    await symlink(external, join(projects, 'external-link'));
    await symlink(targetFile, join(projects, 'file-link'));
    await symlink(join(root, 'missing-target'), join(projects, 'broken-link'));
    await symlink(join(projects, 'loop-b'), join(projects, 'loop-a'));
    await symlink(join(projects, 'loop-a'), join(projects, 'loop-b'));

    const browser = new HostFolderBrowser(fakeRegistry);
    const res = await browser.browse(projects);

    expect(res.entries.map((e) => e.name)).toEqual([
      'external-link',
      'internal-link',
      'real-dir',
    ]);
    expect(res.entries.every((e) => e.is_dir)).toBe(true);

    const nav = await browser.browse(join(projects, 'external-link'));
    expect(nav.entries).toEqual([]);
  });
});
