import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tryAcquireUpdateInstallLock } from '#/cli/update/install-lock';
import { getUpdateInstallLockFile } from '#/utils/paths';

const originalEnv = { ...process.env };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kimi-update-install-lock-'));
  process.env['KIMI_CODE_HOME'] = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

describe('update install lock', () => {
  it('allows only one holder until the lock is released', async () => {
    const first = await tryAcquireUpdateInstallLock({ version: '0.5.0' });
    expect(first).not.toBeNull();
    expect(getUpdateInstallLockFile()).toBe(join(dir, 'updates', 'install.lock'));

    const second = await tryAcquireUpdateInstallLock({ version: '0.5.0' });
    expect(second).toBeNull();

    await first?.release();

    const third = await tryAcquireUpdateInstallLock({ version: '0.5.0' });
    expect(third).not.toBeNull();
    await third?.release();
  });
});
