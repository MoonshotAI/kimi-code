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
  it('treats a node-errno not-found from a local fs as no project-local config', async () => {
    const service = serviceWithReadError(Object.assign(new Error('ENOENT: open'), { code: 'ENOENT' }));
    await expect(service.readAdditionalDirs('/repo')).resolves.toMatchObject({ additionalDirs: [] });
  });

  it('treats a domain-coded not-found from a remote fs as no project-local config', async () => {
    const service = serviceWithReadError(
      new HostFsError(OsFsErrors.codes.OS_FS_NOT_FOUND, 'read failed: path does not exist'),
    );
    await expect(service.readAdditionalDirs('/repo')).resolves.toMatchObject({ additionalDirs: [] });
  });

  it('propagates a real read failure as a storage io error', async () => {
    const service = serviceWithReadError(
      new HostFsError(OsFsErrors.codes.OS_FS_PERMISSION_DENIED, 'read failed: permission denied'),
    );
    await expect(service.readAdditionalDirs('/repo')).rejects.toMatchObject({ code: 'storage.io_failed' });
  });
});
