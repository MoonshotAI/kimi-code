import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';

import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';

function serviceWithReadError(error: Error): FileProjectLocalConfigService {
  const fs = {
    _serviceBrand: undefined,
    readText: async () => {
      throw error;
    },
    lstat: async () => {
      throw error;
    },
  } as unknown as IHostFileSystem;
  return new FileProjectLocalConfigService({ _serviceBrand: undefined } as never, fs);
}

describe('FileProjectLocalConfigService.readAdditionalDirs', () => {
  it('propagates a real read failure as a storage io error', async () => {
    const service = serviceWithReadError(
      new HostFsError(OsFsErrors.codes.OS_FS_PERMISSION_DENIED, 'read failed: permission denied'),
    );
    await expect(service.readAdditionalDirs('/repo')).rejects.toMatchObject({ code: 'storage.io_failed' });
  });
});

describe('FileProjectLocalConfigService permissionRules', () => {
  it('serializes atomic appends and rejects unsafe or invalid config without losing the last valid file', async () => {
    const existing = { decision: 'deny', scope: 'project', pattern: 'Bash(git push *)' };
    const added = { decision: 'allow', scope: 'project', pattern: 'Read(**)' };
    const concurrentAdded = { decision: 'ask', scope: 'project', pattern: 'Edit(**)' };
    const configPath = '/repo/.kimi-code/local.toml';
    let text = `[workspace]\nadditional_dir = []\n\n[[permission.rules]]\ndecision = "deny"\nscope = "project"\npattern = "Bash(git push *)"\n`;
    const staged = new Map<string, string>();
    const writes: string[] = [];
    const renames: string[] = [];
    const symlinks = new Set<string>();
    let failRename = false;
    const missing = () => new HostFsError(OsFsErrors.codes.OS_FS_NOT_FOUND, 'missing');
    const fs = {
      _serviceBrand: undefined,
      readText: async (path: string) => {
        if (path === configPath) return text;
        const value = staged.get(path);
        if (value === undefined) throw missing();
        return value;
      },
      lstat: async (path: string) => {
        if (['/repo', '/repo/.git', '/repo/.kimi-code', configPath].includes(path)) {
          return { isSymbolicLink: symlinks.has(path) };
        }
        throw missing();
      },
      mkdir: async (_path: string, _options: unknown) => undefined,
      writeText: async (path: string, value: string) => {
        await Promise.resolve();
        writes.push(path);
        staged.set(path, value);
      },
      rename: async (from: string, to: string) => {
        if (failRename) throw new Error('rename failed');
        const value = staged.get(from);
        if (value === undefined) throw missing();
        text = value;
        staged.delete(from);
        renames.push(to);
      },
      remove: async (path: string) => {
        staged.delete(path);
      },
    } as unknown as IHostFileSystem;
    const service = new FileProjectLocalConfigService(
      { _serviceBrand: undefined, osHomeDir: '' } as never,
      fs,
    );

    const [appended] = await Promise.all([
      service.appendPermissionRules('/repo', [added]),
      service.appendPermissionRules('/repo', [concurrentAdded]),
    ]);

    expect(appended.rules).toEqual([existing, added]);
    expect(parseToml(text)).toMatchObject({
      workspace: { additional_dir: [] },
      permission: { rules: [existing, added, concurrentAdded] },
    });
    await expect(service.readPermissionRules('/repo')).resolves.toMatchObject({
      rules: [existing, added, concurrentAdded],
    });
    expect(writes.every((path) => path !== configPath)).toBe(true);
    expect(renames).toEqual([configPath, configPath]);

    const validText = text;
    failRename = true;
    await expect(service.appendPermissionRules('/repo', [added])).rejects.toThrow();
    expect(text).toBe(validText);
    failRename = false;
    for (const path of [configPath, '/repo/.kimi-code']) {
      symlinks.add(path);
      await expect(service.appendPermissionRules('/repo', [added])).rejects.toThrow('symlink');
      symlinks.clear();
    }
    expect(text).toBe(validText);

    text = '[permission]\nrules = "invalid"\n';
    await expect(service.readPermissionRules('/repo')).rejects.toThrow('permission.rules must be an array');
    text = '[permission\nrules = []\n';
    await expect(service.readPermissionRules('/repo')).rejects.toThrow('Invalid TOML');
  });
});

describe('FileProjectLocalConfigService.resolveAdditionalDirs', () => {
  function service(osHomeDir: string, homeDir?: string): { service: FileProjectLocalConfigService; stated: string[] } {
    const stated: string[] = [];
    const fs = {
      _serviceBrand: undefined,
      stat: async (path: string) => {
        stated.push(path);
        return { isDirectory: () => true };
      },
    } as unknown as IHostFileSystem;
    return {
      service: new FileProjectLocalConfigService({ _serviceBrand: undefined, osHomeDir } as never, fs, homeDir),
      stated,
    };
  }

  it('expands ~ with the target home when given and otherwise the client home', async () => {
    const { service: local, stated } = service('/client/home');
    await expect(local.resolveAdditionalDirs('/work', ['~/shared'])).resolves.toEqual(['/client/home/shared']);
    expect(stated).toEqual(['/client/home/shared']);

    const { service: remote, stated: remoteStated } = service('/client/home', '/remote/home');
    await expect(remote.resolveAdditionalDirs('/work', ['~/shared', '~'])).resolves.toEqual([
      '/remote/home/shared',
      '/remote/home',
    ]);
    expect(remoteStated).toEqual(['/remote/home/shared', '/remote/home']);
  });

  it('leaves ~ unexpanded when the target home is unknown', async () => {
    const { service: remote, stated } = service('/client/home', '');
    await expect(remote.resolveAdditionalDirs('/work', ['~/shared'])).resolves.toEqual(['/work/~/shared']);
    expect(stated).toEqual(['/work/~/shared']);
  });
});
