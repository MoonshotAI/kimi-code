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
  it('appends rules without dropping other config and reads them back', async () => {
    const existing = { decision: 'deny', scope: 'project', pattern: 'Bash(git push *)' };
    const added = { decision: 'allow', scope: 'project', pattern: 'Read(**)' };
    const concurrentAdded = { decision: 'ask', scope: 'project', pattern: 'Edit(**)' };
    let text = `[workspace]\nadditional_dir = []\n\n[[permission.rules]]\ndecision = "deny"\nscope = "project"\npattern = "Bash(git push *)"\n`;
    const fs = {
      _serviceBrand: undefined,
      readText: async () => text,
      lstat: async (_path: string) => ({}),
      mkdir: async (_path: string, _options: unknown) => undefined,
      writeText: async (_path: string, value: string) => {
        await Promise.resolve();
        text = value;
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

  it('includes the resolved path when an additional directory is missing', async () => {
    const fs = {
      _serviceBrand: undefined,
      stat: async () => {
        throw new HostFsError(OsFsErrors.codes.OS_FS_NOT_FOUND, 'path does not exist');
      },
    } as unknown as IHostFileSystem;
    const local = new FileProjectLocalConfigService(
      { _serviceBrand: undefined, osHomeDir: '/client/home' } as never,
      fs,
    );

    await expect(local.resolveAdditionalDirs('/work', ['../missing'])).rejects.toThrow(
      'workspace.additional_dir must exist and be a directory: /missing',
    );
  });

  it('includes the resolved path when an additional directory is a file', async () => {
    const fs = {
      _serviceBrand: undefined,
      stat: async () => ({ isDirectory: false }),
    } as unknown as IHostFileSystem;
    const local = new FileProjectLocalConfigService(
      { _serviceBrand: undefined, osHomeDir: '/client/home' } as never,
      fs,
    );

    await expect(local.resolveAdditionalDirs('/work', ['file'])).rejects.toThrow(
      'workspace.additional_dir must exist and be a directory: /work/file',
    );
  });

  it('reports an empty additional directory value', async () => {
    const { service: local } = service('/client/home');

    await expect(local.resolveAdditionalDirs('/work', ['  '])).rejects.toThrow(
      'workspace.additional_dir must not be empty',
    );
  });
});
