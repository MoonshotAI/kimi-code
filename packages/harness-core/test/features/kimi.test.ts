import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ConfigRef,
  createConfig,
  MAIN_AGENT_ID,
  memorySessionSpace,
  createHarness,
  providerCatalog,
  type ConfigPersist,
} from '@moonshot-ai/agent-core';
import { FileTokenStorage } from '@moonshot-ai/kimi-code-oauth';

import { createKimi } from '#/features/kimi/index';
import { OAuthTokensRef } from '#/features/kimi/oauth/index';
import { SessionTitlePromptSourceRef, SessionTitleRef } from '#/features/kimi/sessionTitle/index';
import { TraceRef } from '#/features/kimi/trace/index';
import { SERVICES_CONFIG_SECTION, WebSearchRef } from '#/features/kimi/web/index';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function setupHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'harness-kimi-'));
  homes.push(home);
  await new FileTokenStorage(join(home, 'credentials')).save('kimi-code', {
    accessToken: 'sk-managed',
    refreshToken: 'refresh-token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: '',
    tokenType: 'Bearer',
    expiresIn: 3600,
  });
  return home;
}

function fakePersist(initial?: string): ConfigPersist {
  let text = initial;
  return {
    load: () => Promise.resolve(text),
    save: (value) => {
      text = value;
      return Promise.resolve();
    },
  };
}

describe('kimi composite feature', () => {
  it('exposes the app-tier facades of the sub features from the app node', async () => {
    const home = await setupHome();
    const app = createHarness({
      features: [
        createConfig({ persist: fakePersist() }),
        providerCatalog,
        createKimi({ oauth: { home } }),
      ],
    });
    await app.ready();

    const tokens = app.resolve(OAuthTokensRef);
    const token = tokens.resolve({ storage: 'file', key: 'oauth/kimi-code' });
    await expect(token!.getAccessToken()).resolves.toBe('sk-managed');

    expect(app.resolve(WebSearchRef).getProvider()).toBeUndefined();
    expect(app.resolve(ConfigRef).get(SERVICES_CONFIG_SECTION)).toEqual({});
    await app.disposeAsync();
  });

  it('exposes the session and agent tier facades of sessionTitle and trace', async () => {
    const app = createHarness({
      space: memorySessionSpace(),
      features: [createConfig({ persist: fakePersist() }), providerCatalog, createKimi()],
    });
    await app.ready();
    const session = await app.open({ sessionId: 'sess' });
    const face = session.resolve(SessionTitleRef);
    const main = await session.create({ agentId: MAIN_AGENT_ID });

    const promptSource = main.resolve(SessionTitlePromptSourceRef);
    expect(promptSource.compose('user_prompts')).toBeUndefined();
    expect(main.resolve(TraceRef).traceId.value).toBeUndefined();
    await expect(face.generateTitle()).resolves.toBeUndefined();
    await app.disposeAsync();
  });
});
