import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { WorkspaceConfig } from '#/tool/path-access';
import { assertRealPathWithinWorkspace, assertRealPathWriteTarget } from '#/tool/realpath-access';

describe('realpath access guard', () => {
  let tmpDir: string;
  let wsDir: string;
  let outsideDir: string;
  let fs: HostFileSystem;
  let workspace: WorkspaceConfig;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'realpath-access-'));
    wsDir = join(tmpDir, 'ws');
    outsideDir = join(tmpDir, 'outside');
    await mkdir(wsDir);
    await mkdir(outsideDir);
    fs = new HostFileSystem();
    workspace = { workspaceDir: wsDir, additionalDirs: [] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('allows a symlink that stays inside the workspace', async () => {
    const target = join(wsDir, 'real.txt');
    await writeFile(target, 'original');
    const link = join(wsDir, 'alias.txt');
    await symlink(target, link);

    await expect(assertRealPathWriteTarget(fs, link, workspace, 'posix')).resolves.toBeUndefined();
  });

  it('rejects a symlink that points outside the workspace', async () => {
    const target = join(outsideDir, 'target.txt');
    await writeFile(target, 'original');
    const link = join(wsDir, 'link.txt');
    await symlink(target, link);

    await expect(assertRealPathWriteTarget(fs, link, workspace, 'posix')).rejects.toThrow(
      /symbolic link/,
    );
  });

  it('rejects a path whose symlinked parent directory points outside the workspace', async () => {
    const fakeHome = join(tmpDir, 'fake-home');
    await mkdir(fakeHome);
    const target = join(fakeHome, '.bashrc');
    await writeFile(target, 'original');
    await symlink(fakeHome, join(wsDir, 'home'));

    await expect(
      assertRealPathWriteTarget(fs, join(wsDir, 'home', '.bashrc'), workspace, 'posix'),
    ).rejects.toThrow(/symbolic link/);
  });

  it('rejects a path that is too deep to verify', async () => {
    const target = join(outsideDir, 'target.txt');
    await writeFile(target, 'original');
    const link = join(wsDir, 'link');
    await symlink(outsideDir, link);

    const deep = join(link, ...Array.from({ length: 300 }, () => 'a'), 'file.txt');
    await expect(assertRealPathWriteTarget(fs, deep, workspace, 'posix')).rejects.toThrow(
      /too deep/,
    );
  });

  it('blocks a target that resolves to a sensitive file', async () => {
    const target = join(outsideDir, 'id_rsa');
    await writeFile(target, 'secret-key');
    const link = join(wsDir, 'notes.md');
    await symlink(target, link);

    await expect(assertRealPathWriteTarget(fs, link, workspace, 'posix')).rejects.toThrow(
      /sensitive-file pattern/,
    );
  });

  it('rejects a dangling symlink whose target does not exist', async () => {
    const link = join(wsDir, 'dangling.txt');
    await symlink(join(outsideDir, 'missing.txt'), link);

    await expect(assertRealPathWriteTarget(fs, link, workspace, 'posix')).rejects.toThrow(
      /symbolic link/,
    );
  });

  it('rejects the project config through a symlink alias', async () => {
    const configDir = join(wsDir, '.kimi-code');
    await mkdir(configDir);
    await writeFile(join(configDir, 'local.toml'), 'original');
    const alias = join(wsDir, 'config-link');
    await symlink(configDir, alias);

    await expect(
      assertRealPathWriteTarget(fs, join(alias, 'local.toml'), workspace, 'posix'),
    ).rejects.toThrow(/project-local config/);
  });

  it('allows the project config through its real path', async () => {
    const configDir = join(wsDir, '.kimi-code');
    await mkdir(configDir);
    await writeFile(join(configDir, 'local.toml'), 'original');

    await expect(
      assertRealPathWriteTarget(fs, join(configDir, 'local.toml'), workspace, 'posix'),
    ).resolves.toBeUndefined();
  });

  it('allows a symlink that points into an additional dir', async () => {
    const target = join(outsideDir, 'shared.txt');
    await writeFile(target, 'original');
    const link = join(wsDir, 'shared.txt');
    await symlink(target, link);
    const withAdditional: WorkspaceConfig = { workspaceDir: wsDir, additionalDirs: [outsideDir] };

    await expect(assertRealPathWriteTarget(fs, link, withAdditional, 'posix')).resolves.toBeUndefined();
  });

  it('blocks an absolute outside symlink that resolves to a sensitive file', async () => {
    const target = join(outsideDir, 'id_rsa');
    await writeFile(target, 'secret-key');
    const link = join(tmpDir, 'notes.md');
    await symlink(target, link);

    await expect(assertRealPathWithinWorkspace(fs, link, workspace, 'posix')).rejects.toThrow(
      /sensitive-file pattern/,
    );
  });

  it('allows an absolute outside path that is not sensitive', async () => {
    const target = join(outsideDir, 'plain.txt');
    await writeFile(target, 'data');

    await expect(assertRealPathWithinWorkspace(fs, target, workspace, 'posix')).resolves.toBe(
      target,
    );
  });

  it('compares resolved config paths with Windows semantics', async () => {
    const realpath = vi.fn(async (path: string) => {
      if (path === 'C:/ws/alias/local.toml') return 'C:\\ws\\.kimi-code\\local.toml';
      return path.replaceAll('/', '\\');
    });
    const winFs = { realpath } as unknown as IHostFileSystem;
    const winWorkspace: WorkspaceConfig = { workspaceDir: 'C:/ws', additionalDirs: [] };

    await expect(
      assertRealPathWriteTarget(winFs, 'C:/ws/.kimi-code/local.toml', winWorkspace, 'win32'),
    ).resolves.toBeUndefined();
    await expect(
      assertRealPathWriteTarget(winFs, 'C:/ws/alias/local.toml', winWorkspace, 'win32'),
    ).rejects.toThrow(/project-local config/);
  });
});
