import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarness, type KimiError, type PermissionMode } from '#/index';
import { makeTempDir, removeTempDirs, waitForAgentWireEvent } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe('Session.setPermission', () => {
  it.each(['yolo', 'manual', 'auto'] as const)(
    'sends permission.set_mode with mode %s',
    async (mode: PermissionMode) => {
      const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-permission-home-');
      const workDir = await makeTempDir(tempDirs, 'kimi-sdk-permission-work-');
      const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

      try {
        const session = await harness.createSession({
          id: `ses_permission_${mode}`,
          workDir,
        });

        await session.setPermission(mode);

        await expect(
          waitForAgentWireEvent(
            homeDir,
            session.id,
            'permission.set_mode',
            (event) => event['mode'] === mode,
          ),
        ).resolves.toMatchObject({
          type: 'permission.set_mode',
          mode,
        });
      } finally {
        await harness.close();
      }
    },
  );

  it('rejects invalid permission modes', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-permission-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-permission-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_permission_invalid', workDir });

      await expect(session.setPermission('invalid' as never)).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.permission_mode_invalid',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('rejects after the session is closed', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-permission-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-permission-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_permission_closed', workDir });
      await session.close();

      await expect(session.setPermission('yolo')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.closed',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });
});
