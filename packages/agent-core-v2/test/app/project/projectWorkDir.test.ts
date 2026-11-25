import { realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { normalize } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { projectDirAt } from '#/app/project/projectWorkDir';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  bareContainer,
  bareRepository,
  createLayoutLab,
  forgedPointer,
  linkedWorktree,
  mainCheckout,
  separateGitDirCheckout,
  submodule,
  type LayoutLab,
} from '../git/checkoutLayouts';

describe('projectDirAt', () => {
  const fs = new HostFileSystem();
  let lab: LayoutLab;
  let home: string;
  let homeDirs: readonly string[] | undefined;

  beforeEach(() => {
    lab = createLayoutLab('project-work-dir-');
    home = lab.dir('home');
    homeDirs = [home, realpathSync(home)];
  });

  afterEach(() => {
    lab.dispose();
  });

  function dirAt(root: string, dir: string): Promise<string | undefined> {
    return projectDirAt(join(lab.base, root), join(lab.base, dir), { fs, homeDirs });
  }

  async function accepts(root: string, dir: string): Promise<boolean> {
    return (await dirAt(root, dir)) !== undefined;
  }

  function repositories(): void {
    const app = mainCheckout(lab.dir('app'));
    lab.dir('app', 'src');
    linkedWorktree(`${app}/.git`, lab.dir('app-fix'));
    lab.dir('app-fix', 'src');
    linkedWorktree(`${app}/.git`, lab.dir('app-fix2'));
    linkedWorktree(`${app}/.git`, lab.dir('app', '.worktrees', 'nested'));
    mainCheckout(lab.dir('app', 'vendor', 'lib'));
    lab.dir('app', 'broken', 'src');
    writeFileSync(join(lab.base, 'app', 'broken', '.git'), 'not a pointer\n');
    linkedWorktree(submodule(app, 'sub'), lab.dir('sub-fix'));
    mainCheckout(lab.dir('lib'));

    const mono = mainCheckout(lab.dir('mono'));
    for (const name of ['foo', 'foobar', 'bar']) lab.dir('mono', 'packages', name);
    lab.dir('mono', 'packages', 'foo', 'src');
    linkedWorktree(`${mono}/.git`, lab.dir('mono-fix'));
    lab.dir('mono-fix', 'packages', 'foo', 'src');
    lab.dir('mono-fix', 'packages', 'bar');

    const bare = bareRepository(lab.dir('app.git'));
    linkedWorktree(bare, lab.dir('bare-one'));
    lab.dir('bare-one', 'src');
    linkedWorktree(bare, lab.dir('bare-two'));
    const nestedBare = bareRepository(lab.dir('lib', 'mirrors', 'nested.git'));
    linkedWorktree(nestedBare, lab.dir('nested-bare-fix'));
    const contained = bareContainer(lab.dir('container'));
    linkedWorktree(contained, lab.dir('container', 'main'));
    linkedWorktree(contained, lab.dir('container', 'feat'));
    linkedWorktree(separateGitDirCheckout(lab.dir('sep'), lab.dir('gitdirs', 'sep.git')), lab.dir('sep-fix'));
    lab.dir('sep', 'src');
    lab.dir('sep-fix', 'src');
    forgedPointer(lab.dir('forged'), `${app}/.git/worktrees/app-fix`);
    lab.dir('emptygit', '.git');
    lab.dir('emptygit', 'sub');

    lab.dir('plain', 'sub');
    lab.dir('plain-other');
    mainCheckout(lab.dir('code', 'repo'));
  }

  it.each([
    ['app', 'app-fix', 'app-fix'],
    ['app', 'app-fix/src', 'app-fix'],
    ['app', 'app/.worktrees/nested', 'app/.worktrees/nested'],
    ['app-fix', 'app-fix2', 'app-fix2'],
    ['app-fix', 'app/src', 'app'],
    ['app-fix', 'app/.worktrees/nested', 'app/.worktrees/nested'],
    ['app/sub', 'sub-fix', 'sub-fix'],
    ['mono/packages/foo', 'mono-fix/packages/foo', 'mono-fix/packages/foo'],
    ['mono/packages/foo', 'mono-fix/packages/foo/src', 'mono-fix/packages/foo'],
    ['mono-fix/packages/foo', 'mono/packages/foo', 'mono/packages/foo'],
    ['app.git', 'bare-one', 'bare-one'],
    ['app.git', 'bare-one/src', 'bare-one'],
    ['bare-one', 'bare-two', 'bare-two'],
    ['lib/mirrors/nested.git', 'nested-bare-fix', 'nested-bare-fix'],
    ['container', 'container/main', 'container/main'],
    ['container/main', 'container/feat', 'container/feat'],
  ])('places a project rooted at %s that runs in %s at %s', async (root, dir, place) => {
    repositories();
    await expect(dirAt(root, dir)).resolves.toBe(normalize(realpathSync(join(lab.base, place))));
  });

  it.each([
    ['app', 'app'],
    ['app', 'app/src'],
    ['app-fix', 'app-fix/src'],
    ['mono/packages/foo', 'mono/packages/foo/src'],
    ['app.git', 'app.git'],
    ['sep', 'sep/src'],
    ['plain', 'plain'],
  ])('places a project rooted at %s that runs in %s at its root as it is written', async (root, dir) => {
    repositories();
    await expect(dirAt(root, dir)).resolves.toBe(join(lab.base, root));
  });

  it.each([
    ['app', 'lib'],
    ['app', '.'],
    ['app', 'app/vendor/lib'],
    ['app', 'app/broken/src'],
    ['app', 'app/sub'],
    ['app', 'forged'],
    ['app/src', 'app'],
    ['app/src', 'app-fix'],
    ['mono/packages/foo', 'mono'],
    ['mono/packages/foo', 'mono-fix'],
    ['mono/packages/foo', 'mono/packages/bar'],
    ['mono/packages/foo', 'mono/packages/foobar'],
    ['mono/packages/foo', 'mono-fix/packages/bar'],
    ['app.git', 'app.git/refs'],
    ['app.git', 'app'],
    ['sep', 'sep-fix'],
    ['sep-fix', 'sep-fix/src'],
    ['emptygit', 'emptygit/sub'],
    ['plain', 'plain/sub'],
    ['plain', 'plain-other'],
    ['code', 'code/repo'],
  ])('keeps a project rooted at %s out of %s', async (root, dir) => {
    repositories();
    await expect(accepts(root, dir)).resolves.toBe(false);
  });

  it('keeps a repository at the home directory or above it from joining directories', async () => {
    const homeRepository = mainCheckout(home);
    lab.dir('home', 'notes', 'deep');
    linkedWorktree(`${homeRepository}/.git`, lab.dir('home-fix'));
    const app = mainCheckout(lab.dir('home', 'app'));
    linkedWorktree(`${app}/.git`, lab.dir('home', 'app-fix'));

    await expect(accepts('home', 'home/notes')).resolves.toBe(false);
    await expect(accepts('home/notes', 'home/notes/deep')).resolves.toBe(false);
    await expect(accepts('home', 'home-fix')).resolves.toBe(false);
    await expect(accepts('home/notes', 'home/notes')).resolves.toBe(true);
    await expect(accepts('home/app', 'home/app-fix')).resolves.toBe(true);
    homeDirs = [realpathSync(lab.dir('home', 'notes'))];
    await expect(accepts('home', 'home/notes')).resolves.toBe(false);
    homeDirs = [lab.dir('elsewhere')];
    await expect(accepts('home', 'home/notes')).resolves.toBe(true);
  });

  it('accepts the root alone when the home directory is unknown', async () => {
    repositories();
    homeDirs = undefined;

    await expect(accepts('app', 'app-fix')).resolves.toBe(false);
    await expect(accepts('app', 'app')).resolves.toBe(true);
  });

  it('compares real paths', async () => {
    repositories();
    symlinkSync(lab.dir('plain'), join(lab.base, 'app', 'to-plain'));
    symlinkSync(lab.dir('lib'), join(lab.base, 'app', 'to-lib'));
    symlinkSync(lab.dir('app'), join(lab.base, 'app-alias'));
    symlinkSync(lab.dir('app', 'src'), join(lab.base, 'src-alias'));
    symlinkSync(lab.dir('app-fix'), join(lab.base, 'app', 'to-fix'));
    symlinkSync(lab.dir('plain'), join(lab.base, 'plain-alias'));
    symlinkSync(lab.dir('lib', 'mirrors'), join(lab.base, 'app', 'to-mirrors'));

    await expect(accepts('app', 'app/to-plain')).resolves.toBe(false);
    await expect(accepts('app', 'app/to-plain/sub')).resolves.toBe(false);
    await expect(accepts('app', 'app/to-lib')).resolves.toBe(false);
    await expect(dirAt('app', 'app/to-fix')).resolves.toBe(normalize(realpathSync(lab.dir('app-fix'))));
    await expect(dirAt('app', 'app-alias')).resolves.toBe(lab.dir('app'));
    await expect(dirAt('app', 'app-alias/src')).resolves.toBe(lab.dir('app'));
    await expect(dirAt('app', 'src-alias')).resolves.toBe(lab.dir('app'));
    await expect(dirAt('app-alias', 'app-fix')).resolves.toBe(normalize(realpathSync(lab.dir('app-fix'))));
    await expect(dirAt('app-alias', 'app/src')).resolves.toBe(join(lab.base, 'app-alias'));
    await expect(dirAt('plain', 'plain-alias')).resolves.toBe(lab.dir('plain'));
    await expect(dirAt('plain-alias', 'plain')).resolves.toBe(join(lab.base, 'plain-alias'));
    await expect(accepts('plain', 'plain-alias/sub')).resolves.toBe(false);
    await expect(projectDirAt(lab.dir('app'), `${lab.base}/app/to-mirrors/..`, { fs, homeDirs })).resolves.toBeUndefined();
  });

  it('answers for directories that do not exist by the place they would have', async () => {
    repositories();

    await expect(accepts('app', 'app/missing/leaf')).resolves.toBe(true);
    await expect(accepts('app', 'app-fix/missing')).resolves.toBe(true);
    await expect(accepts('app', 'missing')).resolves.toBe(false);
    await expect(accepts('plain', 'plain/missing')).resolves.toBe(false);
    await expect(accepts('gone', 'gone')).resolves.toBe(true);
    await expect(accepts('gone', 'gone/sub')).resolves.toBe(false);
    await expect(accepts('app-fix/gone', 'app/gone')).resolves.toBe(true);
  });

  it('accepts no path that is not absolute on the host', async () => {
    repositories();
    const root = lab.dir('app');
    const ports = { fs, homeDirs, pathClass: 'posix' as const };

    for (const dir of [relative(process.cwd(), realpathSync(root)), '.', '~/app', '']) {
      await expect(projectDirAt(root, dir, ports)).resolves.toBeUndefined();
    }
    await expect(projectDirAt(process.cwd(), String.raw`C:\app`, ports)).resolves.toBeUndefined();
  });
});

describe('projectDirAt on a Windows host', () => {
  function windowsFs(cwd: string, directories: readonly string[], files: Readonly<Record<string, string>> = {}): IHostFileSystem {
    const key = (path: string): string => path.replaceAll('/', '\\').replace(/(?<!:)\\+$/, '').toLowerCase();
    const directoryByKey = new Map(directories.map((dir) => [key(dir), dir]));
    const fileByKey = new Map(Object.entries(files).map(([path, text]) => [key(path), { path, text }]));
    const missing = (path: string): Error => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    const stat = async (path: string) => {
      const file = fileByKey.get(key(path));
      if (file === undefined && !directoryByKey.has(key(path))) throw missing(path);
      return { isFile: file !== undefined, isDirectory: file === undefined, size: file?.text.length ?? 0 };
    };
    return {
      realpath: async (path: string) => {
        const found = path === '.' ? cwd : directoryByKey.get(key(path)) ?? fileByKey.get(key(path))?.path;
        if (found === undefined) throw missing(path);
        return found;
      },
      lstat: stat,
      stat,
      readText: async (path: string) => {
        const file = fileByKey.get(key(path));
        if (file === undefined) throw missing(path);
        return file.text;
      },
    } as unknown as IHostFileSystem;
  }

  const plain = ['C:\\', String.raw`C:\work`, String.raw`C:\work\app`, String.raw`C:\work\app\src`, String.raw`C:\Users`];
  const repository = windowsFs(String.raw`C:\work\app`, [
    ...plain,
    String.raw`C:\work\app\.git`,
    String.raw`C:\work\app\.git\worktrees\app-fix`,
    'D:\\',
    String.raw`D:\trees`,
    String.raw`D:\trees\app-fix`,
    String.raw`D:\trees\app-fix\src`,
  ], {
    [String.raw`C:\work\app\.git\HEAD`]: 'ref: refs/heads/main\n',
    [String.raw`C:\work\app\.git\worktrees\app-fix\HEAD`]: 'ref: refs/heads/fix\r\n',
    [String.raw`C:\work\app\.git\worktrees\app-fix\gitdir`]: 'D:/trees/app-fix/.git\r\n',
    [String.raw`C:\work\app\.git\worktrees\app-fix\commondir`]: '../..\r\n',
    [String.raw`D:\trees\app-fix\.git`]: 'gitdir: C:/work/app/.git/worktrees/app-fix\r\n',
  });

  function dirAt(fs: IHostFileSystem, root: string, dir: string): Promise<string | undefined> {
    return projectDirAt(root, dir, { fs, homeDirs: [String.raw`C:\Users\me`], pathClass: 'win32' });
  }

  async function accepts(fs: IHostFileSystem, root: string, dir: string): Promise<boolean> {
    return (await dirAt(fs, root, dir)) !== undefined;
  }

  it.each([
    [String.raw`C:\work\app`, String.raw`c:\WORK\App`, String.raw`C:\work\app`],
    [String.raw`C:\work\app`, 'c:/work/app/', String.raw`C:\work\app`],
    [String.raw`C:\work\app`, String.raw`c:\work\APP\src`, String.raw`C:\work\app`],
    [String.raw`c:\work\app`, String.raw`d:\TREES\app-fix`, 'D:/trees/app-fix'],
    [String.raw`C:\work\app\src`, 'd:/trees/app-fix/SRC', 'D:/trees/app-fix/src'],
    [String.raw`D:\trees\app-fix`, String.raw`c:\work\app\new\leaf`, 'C:/work/app'],
  ])('places a project rooted at %s that runs in %s at %s whatever the drive case and separators', async (root, dir, place) => {
    await expect(dirAt(repository, root, dir)).resolves.toBe(place);
  });

  it.each([
    [String.raw`C:\work\app\src`, String.raw`D:\trees\app-fix`],
    [String.raw`C:\work\app`, String.raw`D:\trees`],
    [String.raw`C:\work\app`, String.raw`C:\Users`],
    [String.raw`C:\work\app`, 'C:app'],
  ])('keeps a project rooted at %s out of %s', async (root, dir) => {
    await expect(accepts(repository, root, dir)).resolves.toBe(false);
  });

  it('resolves a missing directory against its nearest existing ancestor, not the process cwd', async () => {
    const root = String.raw`C:\work\app`;

    await expect(accepts(repository, root, String.raw`C:\work\app\new\leaf`)).resolves.toBe(true);
    await expect(accepts(repository, root, String.raw`E:\elsewhere\leaf`)).resolves.toBe(false);
    await expect(accepts(repository, root, String.raw`C:\Users\leaf`)).resolves.toBe(false);
  });

  it('accepts only the root itself, in any spelling, outside a repository', async () => {
    const fs = windowsFs(String.raw`C:\work\app`, plain);

    await expect(accepts(fs, String.raw`C:\work\app`, String.raw`c:\work\APP`)).resolves.toBe(true);
    await expect(accepts(fs, String.raw`C:\work\app`, String.raw`C:\work\app\src`)).resolves.toBe(false);
    await expect(accepts(fs, String.raw`C:\work\gone`, String.raw`c:\WORK\gone`)).resolves.toBe(true);
    await expect(accepts(fs, String.raw`C:\work\gone`, String.raw`C:\work\gone\src`)).resolves.toBe(false);
    await expect(accepts(fs, String.raw`C:\work\gone`, String.raw`C:\work\app`)).resolves.toBe(false);
  });
});
