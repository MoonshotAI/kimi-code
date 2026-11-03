import { describe, expect, it } from 'vitest';

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

  it('expands ~ with the client home when no target home is given', async () => {
    const { service: local, stated } = service('/client/home');
    await expect(local.resolveAdditionalDirs('/work', ['~/shared'])).resolves.toEqual(['/client/home/shared']);
    expect(stated).toEqual(['/client/home/shared']);
  });

  it('expands ~ with the target home instead of the client home', async () => {
    const { service: remote, stated } = service('/client/home', '/remote/home');
    await expect(remote.resolveAdditionalDirs('/work', ['~/shared', '~'])).resolves.toEqual([
      '/remote/home/shared',
      '/remote/home',
    ]);
    expect(stated).toEqual(['/remote/home/shared', '/remote/home']);
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
