import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { basename, dirname, join } from 'node:path';

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
import {
  parseWindowsDocumentsOutput,
  parseXdgDocumentsDir,
  resolveCustomRoot,
} from '#/app/defaultWorkspace/defaultWorkspacePaths';
import { DefaultWorkspaceService } from '#/app/defaultWorkspace/defaultWorkspaceService';
import { LifecycleScope } from '#/app/scopes';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';

import { stubBootstrap } from '../bootstrap/stubs';

describe('default workspace paths', () => {
  it('reads XDG_DOCUMENTS_DIR and treats the bare home directory as unset', () => {
    const home = '/home/alice';
    expect(parseXdgDocumentsDir('XDG_DOCUMENTS_DIR="$HOME/Dokumente"\n', home)).toBe(
      '/home/alice/Dokumente',
    );
    expect(parseXdgDocumentsDir('XDG_DOCUMENTS_DIR="/data/docs"', home)).toBe('/data/docs');
    expect(parseXdgDocumentsDir('XDG_DOCUMENTS_DIR="$HOME/"', home)).toBeUndefined();
    expect(parseXdgDocumentsDir('XDG_DESKTOP_DIR="$HOME/Desktop"', home)).toBeUndefined();
  });

  it('reads the Windows documents folder reported by the shell', () => {
    expect(parseWindowsDocumentsOutput('C:\\Users\\alice\\Documents\r\n')).toBe(
      'C:\\Users\\alice\\Documents',
    );
    expect(parseWindowsDocumentsOutput('\uFEFFC:\\Users\\张三\\OneDrive\\文档\r\n')).toBe(
      'C:\\Users\\张三\\OneDrive\\文档',
    );
    expect(parseWindowsDocumentsOutput('\\\\server\\home\\alice\\Documents')).toBe(
      '\\\\server\\home\\alice\\Documents',
    );
    expect(parseWindowsDocumentsOutput('\r\n')).toBeUndefined();
    expect(parseWindowsDocumentsOutput('Documents')).toBeUndefined();
  });

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
    expect(resolveCustomRoot('\\Chats', 'C:\\Users\\alice', 'win32')).toBeUndefined();
    expect(resolveCustomRoot('/Chats', 'C:\\Users\\alice', 'win32')).toBeUndefined();
    expect(resolveCustomRoot('C:Chats', 'C:\\Users\\alice', 'win32')).toBeUndefined();
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
    await fsp.chmod(join(osHomeDir, 'Documents'), 0o755).catch(() => undefined);
    await fsp.rm(osHomeDir, { recursive: true, force: true });
  });

  function build(
    env: NodeJS.ProcessEnv = {},
    windows?: { spawn: IHostProcessService['spawn'] },
    sections: Record<string, unknown> = {},
    fs: IHostFileSystem = new HostFileSystem(),
  ): IDefaultWorkspace {
    const bootstrap = stubBootstrap('/tmp/kimi-home', env, {}, osHomeDir);
    currentHost?.dispose();
    currentHost = createScopedTestHost([
      stubPair(
        IBootstrapService,
        windows === undefined ? bootstrap : { ...bootstrap, platform: 'win32' },
      ),
      stubPair(IHostFileSystem, fs),
      stubPair(IHostProcessService, (windows ?? {}) as IHostProcessService),
      stubPair(IConfigService, memoryConfig(sections)),
    ]);
    return currentHost.app.accessor.get(IDefaultWorkspace);
  }

  function memoryConfig(sections: Record<string, unknown>): IConfigService {
    return {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (domain: string) => sections[domain],
      set: async (domain: string, value: Record<string, unknown>) => {
        sections[domain] = { ...(sections[domain] as object | undefined), ...value };
      },
      replace: async (domain: string, value: unknown) => {
        sections[domain] = value;
      },
    } as unknown as IConfigService;
  }

  const unavailable = (reason: string) => ({
    code: 'default_workspace.unavailable',
    details: expect.objectContaining({ reason }),
  });

  function documentsReply(documentsDir: string): IHostProcessService['spawn'] {
    const output = `${documentsDir}\r\n`;
    return (async () => ({
      stdout: (async function* () {
        yield output;
      })(),
      wait: async () => 0,
      dispose: () => undefined,
    })) as unknown as IHostProcessService['spawn'];
  }

  const shellUnavailable = (async () => {
    throw new Error('spawn powershell.exe ENOENT');
  }) as unknown as IHostProcessService['spawn'];

  it('places the directory under the Windows documents folder', async () => {
    const documentsDir = join(osHomeDir, 'OneDrive', 'Docs');
    await fsp.mkdir(documentsDir, { recursive: true });

    const root = await build({}, { spawn: documentsReply(documentsDir) }).ensure();

    expect(root).toBe(join(documentsDir, 'KimiCode', 'Default'));
  });

  it('starts Windows PowerShell by absolute path instead of searching PATH', async () => {
    const documentsDir = join(osHomeDir, 'Docs');
    await fsp.mkdir(documentsDir, { recursive: true });
    const commands: string[] = [];
    const spawn = ((...args: Parameters<IHostProcessService['spawn']>) => {
      commands.push(args[0]);
      return documentsReply(documentsDir)(...args);
    }) as IHostProcessService['spawn'];

    await build({ SystemRoot: 'D:\\Windows' }, { spawn }).ensure();
    await build({ SystemRoot: 'Windows' }, { spawn }).ensure();

    expect(commands).toEqual([
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ]);
  });

  it('fails instead of falling back when the Windows documents folder cannot be resolved', async () => {
    const service = build({}, { spawn: shellUnavailable });

    await expect(service.ensure()).rejects.toMatchObject(unavailable('documents_unavailable'));
    expect(await service.isDefault(join(osHomeDir, 'Documents', 'KimiCode', 'Default'))).toBe(
      false,
    );
    await expect(fsp.stat(join(osHomeDir, 'Documents'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a Windows documents folder that does not exist', async () => {
    const reported = join(osHomeDir, 'ÎÄµµ');
    const service = build({}, { spawn: documentsReply(reported) });

    await expect(service.ensure()).rejects.toMatchObject(unavailable('documents_unavailable'));
    await expect(fsp.stat(reported)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retries the Windows documents lookup after a failure', async () => {
    const documentsDir = join(osHomeDir, 'Docs');
    await fsp.mkdir(documentsDir, { recursive: true });
    let attempts = 0;
    const spawn = ((...args: Parameters<IHostProcessService['spawn']>) => {
      attempts += 1;
      return attempts === 1 ? shellUnavailable(...args) : documentsReply(documentsDir)(...args);
    }) as IHostProcessService['spawn'];
    const service = build({}, { spawn });

    await expect(service.ensure()).rejects.toMatchObject(unavailable('documents_unavailable'));
    expect(await service.ensure()).toBe(join(documentsDir, 'KimiCode', 'Default'));
  });

  it('creates the directory on first use and reuses it afterwards', async () => {
    const service = build();
    const root = join(osHomeDir, 'Documents', 'KimiCode', 'Default');

    expect(await service.ensure()).toBe(root);
    await fsp.writeFile(join(root, 'notes.md'), 'kept', 'utf8');
    expect(await service.ensure()).toBe(root);

    expect(await fsp.readFile(join(root, 'notes.md'), 'utf8')).toBe('kept');
  });

  it('recreates the directory after it has been removed', async () => {
    const service = build();
    const root = await service.ensure();
    await fsp.rm(join(osHomeDir, 'Documents', 'KimiCode'), { recursive: true });

    expect(await service.ensure()).toBe(root);
    expect((await fsp.stat(root)).isDirectory()).toBe(true);
  });

  it('places the directory under the configured XDG documents directory', async () => {
    const configHome = join(osHomeDir, 'config');
    await fsp.mkdir(configHome, { recursive: true });
    await fsp.writeFile(
      join(configHome, 'user-dirs.dirs'),
      'XDG_DOCUMENTS_DIR="$HOME/Dokumente"\n',
      'utf8',
    );

    const root = await build({ XDG_CONFIG_HOME: configHome }).ensure();

    expect(root).toBe(join(osHomeDir, 'Dokumente', 'KimiCode', 'Default'));
  });

  it('recognizes the default root regardless of a trailing separator', async () => {
    const service = build();
    const root = join(osHomeDir, 'Documents', 'KimiCode', 'Default');

    expect(await service.isDefault(root)).toBe(true);
    expect(await service.isDefault(`${root}/`)).toBe(true);
    expect(await service.isDefault(join(osHomeDir, 'Documents', 'KimiCode'))).toBe(false);
  });

  it.each([
    ['the default folder', ['KimiCode', 'Default']],
    ['a parent folder', ['KimiCode']],
  ])('reports a path blocked by a file at %s', async (_label, segments) => {
    const blocked = join(osHomeDir, 'Documents', ...segments);
    await fsp.mkdir(join(blocked, '..'), { recursive: true });
    await fsp.writeFile(blocked, 'not a folder', 'utf8');

    const service = build();

    await expect(service.ensure()).rejects.toMatchObject(unavailable('blocked_by_file'));
    expect(await service.status()).toMatchObject({ exists: false, problem: 'blocked_by_file' });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a permission failure',
    async () => {
      const documents = join(osHomeDir, 'Documents');
      await fsp.mkdir(documents, { recursive: true });
      await fsp.chmod(documents, 0o500);

      await expect(build().ensure()).rejects.toMatchObject(unavailable('permission_denied'));
      expect(await build().status()).toMatchObject({ exists: false, problem: 'permission_denied' });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reports a dangling symlink in the path the same way creating the folder fails',
    async () => {
      const documents = join(osHomeDir, 'Documents');
      await fsp.mkdir(documents, { recursive: true });
      await fsp.symlink(join(osHomeDir, 'gone'), join(documents, 'KimiCode'));
      const service = build();

      expect(await service.status()).toMatchObject({ exists: false, problem: 'blocked_by_file' });
      await expect(
        service.setCustomPath(join(documents, 'KimiCode', 'Chats')),
      ).rejects.toMatchObject(unavailable('blocked_by_file'));
      await expect(service.ensure()).rejects.toMatchObject(unavailable('blocked_by_file'));
    },
  );

  describe('custom location', () => {
    it('creates sessions in the configured folder and treats it as the default', async () => {
      const custom = join(osHomeDir, 'Projects', 'Chats');
      const service = build({}, undefined, { defaultWorkspace: { path: custom } });

      expect(await service.ensure()).toBe(custom);
      expect(await service.isDefault(custom)).toBe(true);
      expect(await service.isDefault(join(osHomeDir, 'Documents', 'KimiCode', 'Default'))).toBe(
        false,
      );
    });

    it('expands a leading tilde against the user home', async () => {
      const service = build({}, undefined, { defaultWorkspace: { path: '~/Chats' } });

      expect(await service.ensure()).toBe(join(osHomeDir, 'Chats'));
    });

    it('rejects a relative path found in the config file', async () => {
      const service = build({}, undefined, { defaultWorkspace: { path: 'Chats' } });

      await expect(service.ensure()).rejects.toMatchObject(unavailable('invalid_path'));
      expect(await service.status()).toMatchObject({ path: undefined, problem: 'invalid_path' });
    });

    it('rejects a Windows drive path on a POSIX host', async () => {
      const sections: Record<string, unknown> = {};
      const service = build({}, undefined, sections);

      await expect(service.setCustomPath('C:\\Chats')).rejects.toMatchObject(
        unavailable('invalid_path'),
      );
      expect(sections['defaultWorkspace']).toBeUndefined();
    });

    it('saves the trimmed path and reports both locations', async () => {
      const sections: Record<string, unknown> = {};
      const service = build({}, undefined, sections);

      const status = await service.setCustomPath('  ~/Chats  ');

      expect(sections['defaultWorkspace']).toEqual({ path: '~/Chats' });
      expect(status).toEqual({
        path: join(osHomeDir, 'Chats'),
        customPath: '~/Chats',
        systemPath: join(osHomeDir, 'Documents', 'KimiCode', 'Default'),
        exists: false,
        problem: undefined,
      });
      await expect(fsp.stat(join(osHomeDir, 'Chats'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('returns to the system location when cleared', async () => {
      const sections: Record<string, unknown> = { defaultWorkspace: { path: '/somewhere' } };
      const service = build({}, undefined, sections);

      const status = await service.setCustomPath('   ');

      expect(sections['defaultWorkspace']).toEqual({});
      expect(status.path).toBe(join(osHomeDir, 'Documents', 'KimiCode', 'Default'));
      expect(status.customPath).toBeUndefined();
    });

    it('keeps the custom location when the system location is unusable', async () => {
      await fsp.writeFile(join(osHomeDir, 'Documents'), 'not a folder', 'utf8');
      const sections: Record<string, unknown> = { defaultWorkspace: { path: '~/Kept' } };
      const service = build({}, undefined, sections);

      await expect(service.setCustomPath(undefined)).rejects.toMatchObject(
        unavailable('blocked_by_file'),
      );
      expect(sections['defaultWorkspace']).toEqual({ path: '~/Kept' });
    });

    it('keeps the custom location when the Windows documents folder cannot be located', async () => {
      const sections: Record<string, unknown> = { defaultWorkspace: { path: 'C:\\Kept' } };
      const service = build({}, { spawn: shellUnavailable }, sections);

      await expect(service.setCustomPath(undefined)).rejects.toMatchObject(
        unavailable('documents_unavailable'),
      );
      expect(sections['defaultWorkspace']).toEqual({ path: 'C:\\Kept' });
    });

    it('refuses an unusable folder and keeps the saved location', async () => {
      await fsp.writeFile(join(osHomeDir, 'note.txt'), 'x', 'utf8');
      const sections: Record<string, unknown> = { defaultWorkspace: { path: '~/Kept' } };
      const service = build({}, undefined, sections);

      await expect(service.setCustomPath('relative')).rejects.toMatchObject(
        unavailable('invalid_path'),
      );
      await expect(service.setCustomPath(join(osHomeDir, 'note.txt', 'Chats'))).rejects.toMatchObject(
        unavailable('blocked_by_file'),
      );
      expect(sections['defaultWorkspace']).toEqual({ path: '~/Kept' });
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'refuses a folder it cannot write to and leaves no probe file behind',
      async () => {
        const locked = join(osHomeDir, 'Locked');
        await fsp.mkdir(locked);
        await fsp.chmod(locked, 0o500);
        const service = build();

        try {
          await expect(service.setCustomPath(join(locked, 'Chats'))).rejects.toMatchObject(
            unavailable('permission_denied'),
          );
        } finally {
          await fsp.chmod(locked, 0o755);
        }
        await service.setCustomPath(locked);
        expect(await fsp.readdir(locked)).toEqual([]);
      },
    );

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'refuses to hand out a saved folder that is no longer writable',
      async () => {
        const custom = join(osHomeDir, 'Chats');
        await fsp.mkdir(custom);
        const service = build({}, undefined, { defaultWorkspace: { path: custom } });
        await fsp.chmod(custom, 0o500);

        try {
          await expect(service.ensure()).rejects.toMatchObject(unavailable('permission_denied'));
        } finally {
          await fsp.chmod(custom, 0o755);
        }
        expect(await service.ensure()).toBe(custom);
        expect(await fsp.readdir(custom)).toEqual([]);
      },
    );

    it('reports a folder where files can be created but not removed', async () => {
      const custom = join(osHomeDir, 'Chats');
      await fsp.mkdir(custom);
      class NoRemoveFileSystem extends HostFileSystem {
        override async remove(): Promise<void> {
          throw new HostFsError(OsFsErrors.codes.OS_FS_PERMISSION_DENIED, 'permission denied');
        }
      }
      const service = build(
        {},
        undefined,
        { defaultWorkspace: { path: custom } },
        new NoRemoveFileSystem(),
      );

      await expect(service.ensure()).rejects.toMatchObject(unavailable('permission_denied'));
      expect(await service.status()).toMatchObject({ problem: 'permission_denied' });
    });

    it('refuses to save a missing folder where files can be created but folders cannot', async () => {
      class NoMkdirFileSystem extends HostFileSystem {
        override async mkdir(): Promise<void> {
          throw new HostFsError(OsFsErrors.codes.OS_FS_PERMISSION_DENIED, 'permission denied');
        }
      }
      const sections: Record<string, unknown> = {};
      const service = build({}, undefined, sections, new NoMkdirFileSystem());

      await expect(service.setCustomPath(join(osHomeDir, 'Chats'))).rejects.toMatchObject(
        unavailable('permission_denied'),
      );
      expect(sections['defaultWorkspace']).toBeUndefined();
      expect(await fsp.readdir(osHomeDir)).toEqual([]);
    });

    it('refuses to save a missing folder whose new subfolders deny file creation', async () => {
      class NoFilesInNewFoldersFileSystem extends HostFileSystem {
        private readonly created = new Set<string>();
        override async mkdir(path: string, options?: { readonly recursive?: boolean }) {
          await super.mkdir(path, options);
          this.created.add(path);
        }
        override async createExclusive(path: string, data: Uint8Array): Promise<boolean> {
          if (this.created.has(dirname(path))) {
            throw new HostFsError(OsFsErrors.codes.OS_FS_PERMISSION_DENIED, 'permission denied');
          }
          return super.createExclusive(path, data);
        }
      }
      const sections: Record<string, unknown> = {};
      const service = build({}, undefined, sections, new NoFilesInNewFoldersFileSystem());

      await expect(service.setCustomPath(join(osHomeDir, 'Chats'))).rejects.toMatchObject(
        unavailable('permission_denied'),
      );
      expect(sections['defaultWorkspace']).toBeUndefined();
      expect(await fsp.readdir(osHomeDir)).toEqual([]);
    });

    it('explains that an overlong path is too long', async () => {
      const service = build();

      await expect(
        service.setCustomPath(join(osHomeDir, 'a'.repeat(300))),
      ).rejects.toMatchObject({
        ...unavailable('invalid_path'),
        message: expect.stringContaining('too long'),
      });
    });
  });

  it('leaves an existing entry alone when the probe name is already taken', async () => {
    const removed: string[] = [];
    class TakenProbeFileSystem extends HostFileSystem {
      override async createExclusive(): Promise<boolean> {
        return false;
      }
      override async mkdir(path: string, options?: { readonly recursive?: boolean }) {
        if (basename(path).startsWith('.kimi-code-write-test-')) {
          throw new HostFsError(OsFsErrors.codes.OS_FS_ALREADY_EXISTS, 'already exists');
        }
        await super.mkdir(path, options);
      }
      override async remove(path: string): Promise<void> {
        removed.push(path);
      }
    }
    const service = build({}, undefined, {}, new TakenProbeFileSystem());

    await expect(service.ensure()).rejects.toMatchObject(unavailable('unknown'));
    await expect(service.setCustomPath(join(osHomeDir, 'Chats'))).rejects.toMatchObject(
      unavailable('unknown'),
    );
    expect(removed).toEqual([]);
  });
});
