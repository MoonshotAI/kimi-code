import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IDefaultWorkspace } from '#/app/defaultWorkspace/defaultWorkspace';
import { resolveCustomRoot } from '#/app/defaultWorkspace/defaultWorkspacePaths';
import { DefaultWorkspaceService } from '#/app/defaultWorkspace/defaultWorkspaceService';
import { LifecycleScope } from '#/app/scopes';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { stubBootstrap } from '../bootstrap/stubs';

describe('default workspace paths', () => {
  it('judges custom paths by the host platform', () => {
    expect(resolveCustomRoot('C:\\Chats', '/home/alice', 'linux')).toBeUndefined();
    expect(resolveCustomRoot('/srv/chats', '/home/alice', 'linux')).toBe('/srv/chats');
    expect(resolveCustomRoot('/srv/chats\\archive', '/home/alice', 'linux')).toBe(
      '/srv/chats\\archive',
    );
    expect(resolveCustomRoot('~\\Chats', '/home/alice', 'linux')).toBeUndefined();
    expect(resolveCustomRoot('C:\\Chats', 'C:\\Users\\alice', 'win32')).toBe('C:/Chats');
    expect(resolveCustomRoot('~\\Chats', 'C:\\Users\\alice', 'win32')).toBe('C:/Users/alice/Chats');
    expect(resolveCustomRoot('Chats', 'C:\\Users\\alice', 'win32')).toBeUndefined();
    expect(resolveCustomRoot('C:Chats', 'C:\\Users\\alice', 'win32')).toBeUndefined();
    expect(resolveCustomRoot('\\Chats', 'C:\\Users\\alice', 'win32')).toBeUndefined();
    expect(resolveCustomRoot('/Chats', 'C:\\Users\\alice', 'win32')).toBeUndefined();
    expect(resolveCustomRoot('\\\\server', 'C:\\Users\\alice', 'win32')).toBeUndefined();
    expect(resolveCustomRoot('\\\\server\\share\\Chats', 'C:\\Users\\alice', 'win32')).toBe(
      '//server/share/Chats',
    );
    expect(resolveCustomRoot('C:\\..\\Chats', 'C:\\Users\\alice', 'win32')).toBe('C:/Chats');
    expect(resolveCustomRoot('\\\\server\\share\\..\\Chats', 'C:\\Users\\alice', 'win32')).toBe(
      '//server/share/Chats',
    );
  });
});

describe('DefaultWorkspaceService', () => {
  let osHomeDir: string;
  let currentHost: ReturnType<typeof createScopedTestHost> | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IDefaultWorkspace,
      DefaultWorkspaceService,
      ScopeActivation.OnDemand,
      'defaultWorkspace',
    );
    osHomeDir = await fsp.mkdtemp(join(os.tmpdir(), 'default-workspace-home-'));
  });

  afterEach(async () => {
    currentHost?.dispose();
    currentHost = undefined;
    await fsp.chmod(join(osHomeDir, 'KimiCode'), 0o755).catch(() => undefined);
    await fsp.rm(osHomeDir, { recursive: true, force: true });
  });

  function build(sections: Record<string, unknown> = {}): IDefaultWorkspace {
    currentHost?.dispose();
    currentHost = createScopedTestHost([
      stubPair(IBootstrapService, stubBootstrap('/tmp/kimi-home', {}, {}, osHomeDir)),
      stubPair(IHostFileSystem, new HostFileSystem()),
      stubPair(IConfigService, memoryConfig(sections)),
    ]);
    return currentHost.app.accessor.get(IDefaultWorkspace);
  }

  function memoryConfig(sections: Record<string, unknown>): IConfigService {
    return {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (domain: string) => sections[domain],
    } as unknown as IConfigService;
  }

  const unavailable = (reason: string) => ({
    code: 'default_workspace.unavailable',
    details: expect.objectContaining({ reason }),
  });

  it('creates the directory under the home folder on first use and reuses it afterwards', async () => {
    const service = build();
    const root = join(osHomeDir, 'KimiCode', 'Default');

    expect(await service.ensure()).toBe(root);
    await fsp.writeFile(join(root, 'notes.md'), 'kept', 'utf8');
    expect(await service.ensure()).toBe(root);

    expect(await fsp.readFile(join(root, 'notes.md'), 'utf8')).toBe('kept');
  });

  it('recreates the directory after it has been removed', async () => {
    const service = build();
    const root = await service.ensure();
    await fsp.rm(join(osHomeDir, 'KimiCode'), { recursive: true });

    expect(await service.ensure()).toBe(root);
    expect((await fsp.stat(root)).isDirectory()).toBe(true);
  });

  it('recognizes the default root regardless of a trailing separator', async () => {
    const service = build();
    const root = join(osHomeDir, 'KimiCode', 'Default');

    expect(await service.isDefault(root)).toBe(true);
    expect(await service.isDefault(`${root}/`)).toBe(true);
    expect(await service.isDefault(join(osHomeDir, 'KimiCode'))).toBe(false);
  });

  it.each([
    ['the default folder', ['KimiCode', 'Default']],
    ['a parent folder', ['KimiCode']],
  ])('reports a path blocked by a file at %s', async (_label, segments) => {
    const blocked = join(osHomeDir, ...segments);
    await fsp.mkdir(join(blocked, '..'), { recursive: true });
    await fsp.writeFile(blocked, 'not a folder', 'utf8');

    const service = build();

    await expect(service.ensure()).rejects.toMatchObject(unavailable('blocked_by_file'));
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a permission failure',
    async () => {
      const parent = join(osHomeDir, 'KimiCode');
      await fsp.mkdir(parent, { recursive: true });
      await fsp.chmod(parent, 0o500);

      await expect(build().ensure()).rejects.toMatchObject(unavailable('permission_denied'));
    },
  );

  describe('custom location', () => {
    it('creates sessions in the configured folder and treats it as the default', async () => {
      const custom = join(osHomeDir, 'Projects', 'Chats');
      const service = build({ defaultWorkspace: { path: custom } });

      expect(await service.ensure()).toBe(custom);
      expect(await service.isDefault(custom)).toBe(true);
      expect(await service.isDefault(join(osHomeDir, 'KimiCode', 'Default'))).toBe(false);
    });

    it('expands a leading tilde against the user home', async () => {
      const service = build({ defaultWorkspace: { path: '~/Chats' } });

      expect(await service.ensure()).toBe(join(osHomeDir, 'Chats'));
    });

    it('rejects a relative path found in the config file', async () => {
      const service = build({ defaultWorkspace: { path: 'Chats' } });

      await expect(service.ensure()).rejects.toMatchObject(unavailable('invalid_path'));
    });

    it('explains that an overlong path is too long', async () => {
      const service = build({
        defaultWorkspace: { path: join(osHomeDir, 'a'.repeat(300)) },
      });

      await expect(service.ensure()).rejects.toMatchObject({
        ...unavailable('invalid_path'),
        message: expect.stringContaining('too long'),
      });
    });
  });
});
