/**
 * HostEnvironmentService — shell-probe error handling.
 *
 * Verifies that a failed Windows Git Bash probe does not produce an
 * unhandledRejection and is surfaced as a HostProcessError when callers
 * access sync fields or await `ready`.
 */

import { describe, expect, it } from 'vitest';

import { HostEnvironmentService } from '#/os/backends/node-local/hostEnvironmentService';
import { HostProcessError, OsProcessErrors } from '#/os/interface/hostProcess';

describe('HostEnvironmentService', () => {
  // The missing-Git-Bash path is Windows-only. On POSIX the probe resolves
  // with /bin/bash or /bin/sh and never rejects.
  const isWin = process.platform === 'win32';

  it('surfaces missing Git Bash as HostProcessError when awaiting ready', async () => {
    if (!isWin) return;
    const service = new HostEnvironmentService();

    await expect(service.ready).rejects.toBeInstanceOf(HostProcessError);
    await expect(service.ready).rejects.toMatchObject({
      code: OsProcessErrors.codes.SHELL_GIT_BASH_NOT_FOUND,
    });
  });

  it('does not leave the ready rejection unhandled when Git Bash is missing', async () => {
    if (!isWin) return;
    const service = new HostEnvironmentService();

    // The constructor attaches an internal catch handler so the rejection is
    // never considered unhandled, even before the caller awaits `ready`.
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(service.ready).rejects.toBeInstanceOf(HostProcessError);
  });

  it('throws HostProcessError when reading fields after a failed probe', async () => {
    if (!isWin) return;
    const service = new HostEnvironmentService();

    // Wait for the probe to settle (reject) before reading fields.
    await service.ready.catch(() => {});

    expect(() => service.shellPath).toThrow(HostProcessError);
    expect(() => service.osKind).toThrow(HostProcessError);
  });
});
