import { join } from 'node:path';

import { FileTokenStorage, type TokenInfo } from '@moonshot-ai/kimi-code-oauth';
import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarness, type KimiError, type KimiHarness } from '#/index';
import { makeTempDir, removeTempDirs, waitForAgentWireEvent } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

function freshToken(): TokenInfo {
  return {
    accessToken: 'oauth-access-token',
    refreshToken: 'oauth-refresh-token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: '',
    tokenType: 'Bearer',
    expiresIn: 3600,
  };
}

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

describe('Session.setModel', () => {
  it('updates the runtime model and sends config.update with the resolved model', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-model-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-model-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await configureLocalProvider(harness);
      const session = await harness.createSession({
        id: 'ses_model_wire',
        workDir,
        model: 'initial-model',
      });

      await session.setModel('next-model');

      await expect(session.getStatus()).resolves.toMatchObject({ model: 'next-model' });
      const configEvent = await waitForAgentWireEvent(
        homeDir,
        session.id,
        'config.update',
        (event) => event['modelAlias'] === 'next-model',
      );
      expect(configEvent).toMatchObject({
        type: 'config.update',
        modelAlias: 'next-model',
      });
      expect(configEvent).not.toHaveProperty('provider');
    } finally {
      await harness.close();
    }
  });

  it('resolves managed OAuth aliases before updating the runtime provider', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-model-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-model-work-');
    await new FileTokenStorage(join(homeDir, 'credentials')).save('kimi-code', freshToken());
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await harness.setConfig({
        providers: {
          'managed:kimi-code': {
            type: 'kimi',
            baseUrl: 'https://api.kimi.com/coding/v1',
            apiKey: '',
            oauth: { storage: 'file', key: 'oauth/kimi-code' },
          },
        },
        models: {
          'kimi-code/initial': {
            provider: 'managed:kimi-code',
            model: 'kimi-initial',
            maxContextSize: 262144,
          },
          'kimi-code/kimi-for-coding': {
            provider: 'managed:kimi-code',
            model: 'kimi-for-coding',
            maxContextSize: 262144,
          },
        },
        defaultModel: 'kimi-code/initial',
      });
      const session = await harness.createSession({
        id: 'ses_model_oauth_wire',
        workDir,
        model: 'kimi-code/initial',
      });

      await session.setModel('kimi-code/kimi-for-coding');

      await expect(session.getStatus()).resolves.toMatchObject({
        model: 'kimi-code/kimi-for-coding',
      });
      const configEvent = await waitForAgentWireEvent(
        homeDir,
        session.id,
        'config.update',
        (event) => event['modelAlias'] === 'kimi-code/kimi-for-coding',
      );
      expect(configEvent).toMatchObject({
        type: 'config.update',
        modelAlias: 'kimi-code/kimi-for-coding',
      });
      expect(configEvent).not.toHaveProperty('provider');
    } finally {
      await harness.close();
    }
  });

  it('rejects empty model names', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-model-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-model-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await configureLocalProvider(harness);
      const session = await harness.createSession({ id: 'ses_model_empty', workDir });

      await expect(session.setModel('   ')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.model_empty',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('rejects after the session is closed', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-model-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-model-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await configureLocalProvider(harness);
      const session = await harness.createSession({ id: 'ses_model_closed', workDir });
      await session.close();

      await expect(session.setModel('next-model')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'session.closed',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });
});

async function configureLocalProvider(harness: KimiHarness): Promise<void> {
  await harness.setConfig({
    providers: {
      local: {
        type: 'kimi',
        apiKey: 'sk-test',
      },
    },
    models: {
      'initial-model': {
        provider: 'local',
        model: 'initial-model',
        maxContextSize: 262144,
      },
      'next-model': {
        provider: 'local',
        model: 'next-model',
        maxContextSize: 262144,
      },
    },
    defaultProvider: 'local',
  });
}
