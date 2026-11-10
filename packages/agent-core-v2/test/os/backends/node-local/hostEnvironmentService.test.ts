import { describe, expect, it, vi } from 'vitest';

import { ProbeShellNotFoundError } from '#/_base/execEnv/environmentProbe';
import { HostEnvironmentService } from '#/os/backends/node-local/hostEnvironmentService';
import { HostProcessError, OsProcessErrors } from '#/os/interface/hostProcess';

vi.mock('#/_base/execEnv/environmentProbe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/_base/execEnv/environmentProbe')>();
  return {
    ...actual,
    probeHostEnvironmentFromNode: () =>
      Promise.reject(
        new actual.ProbeShellNotFoundError('Git Bash missing (stubbed)', [
          'C:\\Program Files\\Git\\bin\\bash.exe',
        ]),
      ),
  };
});

vi.mock('#/_base/execEnv/loginShellPath', () => ({
  applyLoginShellPathFromNode: () => Promise.resolve(),
}));

describe('HostEnvironmentService', () => {
  it('rejects ready with the translated HostProcessError when the probe fails', async () => {
    const service = new HostEnvironmentService();

    await expect(service.ready).rejects.toBeInstanceOf(HostProcessError);
    await expect(service.ready).rejects.toMatchObject({
      code: OsProcessErrors.codes.SHELL_GIT_BASH_NOT_FOUND,
    });
  });

  it('preserves the probe error as cause and checked paths as details', async () => {
    const service = new HostEnvironmentService();

    const rejected: unknown = await service.ready.catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(HostProcessError);
    const hostError = rejected as HostProcessError;
    expect(hostError.details).toEqual({ checkedPaths: ['C:\\Program Files\\Git\\bin\\bash.exe'] });
    expect(hostError.cause).toBeInstanceOf(ProbeShellNotFoundError);
  });

  it('does not surface the ready rejection as an unhandledRejection', async () => {
    const service = new HostEnvironmentService();

    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(service.ready).rejects.toBeInstanceOf(HostProcessError);
  });

  it('throws HostProcessError when reading fields after a failed probe', async () => {
    const service = new HostEnvironmentService();
    await service.ready.catch(() => {});

    expect(() => service.shellPath).toThrow(HostProcessError);
    expect(() => service.osKind).toThrow(HostProcessError);
  });
});
