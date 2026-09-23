import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { dirname, join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
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

describe('FileProjectLocalConfigService additional_dir scope', () => {
  let homeDir: string;
  let workDir: string;
  let cleanupDirs: string[];

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-local-config-home-'));
    workDir = mkdtempSync(join(tmpdir(), 'kimi-local-config-work-'));
    cleanupDirs = [homeDir, workDir];
  });

  afterEach(async () => {
    await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function createService(): FileProjectLocalConfigService {
    const bootstrap = { _serviceBrand: undefined, osHomeDir: homeDir } as IBootstrapService;
    return new FileProjectLocalConfigService(bootstrap, new HostFileSystem());
  }

  async function writeLocalToml(additionalDirs: readonly string[]): Promise<void> {
    const dir = join(workDir, '.kimi-code');
    await mkdir(dir, { recursive: true });
    const entries = additionalDirs.map((dir) => `"${dir}"`).join(', ');
    await writeFile(join(dir, 'local.toml'), `[workspace]\nadditional_dir = [${entries}]\n`, 'utf8');
  }

  it('rejects an additional_dir that resolves to the user home directory', async () => {
    await writeLocalToml([homeDir]);

    await expect(createService().readAdditionalDirs(workDir)).rejects.toMatchObject({
      code: 'config.invalid',
    });
  });

  it('rejects a bare ~ additional_dir', async () => {
    await writeLocalToml(['~']);

    await expect(createService().readAdditionalDirs(workDir)).rejects.toMatchObject({
      code: 'config.invalid',
    });
  });

  it('rejects an additional_dir that resolves to the filesystem root', async () => {
    await writeLocalToml(['/']);

    await expect(createService().readAdditionalDirs(workDir)).rejects.toMatchObject({
      code: 'config.invalid',
    });
  });

  it('rejects an additional_dir that is an ancestor of the user home directory', async () => {
    await writeLocalToml([dirname(homeDir)]);

    await expect(createService().readAdditionalDirs(workDir)).rejects.toMatchObject({
      code: 'config.invalid',
    });
  });

  it('rejects an additional_dir that is the real target of a symlinked home directory', async () => {
    const realHome = await mkdtemp(join(tmpdir(), 'kimi-local-config-realhome-'));
    cleanupDirs.push(realHome);
    const homeLink = join(workDir, 'home-link');
    await symlink(realHome, homeLink);
    const bootstrap = { _serviceBrand: undefined, osHomeDir: homeLink } as IBootstrapService;
    const service = new FileProjectLocalConfigService(bootstrap, new HostFileSystem());
    await writeLocalToml([realHome]);

    await expect(service.readAdditionalDirs(workDir)).rejects.toMatchObject({
      code: 'config.invalid',
    });
  });

  it('still allows a subdirectory of the home directory', async () => {
    const shared = join(homeDir, 'shared');
    await mkdir(shared, { recursive: true });
    cleanupDirs.push(shared);
    await writeLocalToml([shared]);

    await expect(createService().readAdditionalDirs(workDir)).resolves.toMatchObject({
      additionalDirs: [shared],
    });
  });

  it('rejects an additional_dir that symlinks to the user home directory', async () => {
    const link = join(workDir, 'home-link');
    await symlink(homeDir, link);
    await writeLocalToml([link]);

    await expect(createService().readAdditionalDirs(workDir)).rejects.toMatchObject({
      code: 'config.invalid',
    });
  });

  it('rejects an additional_dir that symlinks to the filesystem root', async () => {
    const link = join(workDir, 'root-link');
    await symlink('/', link);
    await writeLocalToml([link]);

    await expect(createService().readAdditionalDirs(workDir)).rejects.toMatchObject({
      code: 'config.invalid',
    });
  });

  it('still allows a symlink into a subdirectory of the home directory', async () => {
    const shared = join(homeDir, 'shared');
    await mkdir(shared, { recursive: true });
    const link = join(workDir, 'shared-link');
    await symlink(shared, link);
    await writeLocalToml([link]);

    await expect(createService().readAdditionalDirs(workDir)).resolves.toMatchObject({
      additionalDirs: [link],
    });
  });
});
