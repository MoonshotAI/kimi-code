import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createFeature } from '@moonshot-ai/agent-core/app/index';
import { useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';
import { FileTokenStorage } from '@moonshot-ai/kimi-code-oauth';

import { ConfigRef, createConfig, type ConfigPersist, type ConfigStore } from '#/features/config/index';
import { createKimi } from '#/features/kimi/index';
import { OAuthTokensRef, type OAuthTokens } from '#/features/kimi/oauth/index';
import {
  SessionTitlePromptSourceRef,
  SessionTitleRef,
  type SessionTitleFace,
  type SessionTitlePromptSource,
} from '#/features/kimi/sessionTitle/index';
import { TraceRef, type TraceFace } from '#/features/kimi/trace/index';
import { SERVICES_CONFIG_SECTION, WebSearchRef, type WebSearchFace } from '#/features/kimi/web/index';
import { providerCatalog } from '#/features/provider-catalog/index';
import { createHarness, memoryHarnessSpace } from '#/runtime/index';

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

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Capture {
  oauth?: Readonly<ShallowRef<OAuthTokens | undefined>>;
  web?: Readonly<ShallowRef<WebSearchFace | undefined>>;
  config?: Readonly<ShallowRef<ConfigStore | undefined>>;
  title?: Readonly<ShallowRef<SessionTitleFace | undefined>>;
  promptSource?: Readonly<ShallowRef<SessionTitlePromptSource | undefined>>;
  trace?: Readonly<ShallowRef<TraceFace | undefined>>;
}

function kimiProbe(capture: Capture) {
  return createFeature('probe', {
    app() {
      capture.oauth = useInject(OAuthTokensRef);
      capture.web = useInject(WebSearchRef);
      capture.config = useInject(ConfigRef);
    },
    session() {
      capture.title = useInject(SessionTitleRef);
    },
    agent() {
      capture.promptSource = useInject(SessionTitlePromptSourceRef);
      capture.trace = useInject(TraceRef);
    },
  });
}

describe('kimi composite feature', () => {
  it('exposes the app-tier facades of the sub features', async () => {
    const home = await setupHome();
    const capture: Capture = {};
    const harness = createHarness({ space: memoryHarnessSpace() });
    harness.app.features.add(createConfig({ persist: fakePersist() }));
    harness.app.features.add(providerCatalog);
    harness.app.features.add(createKimi({ oauth: { home } }));
    harness.app.features.add(kimiProbe(capture));
    await tick();
    const tokens = capture.oauth?.value;
    const web = capture.web?.value;
    const config = capture.config?.value;
    if (tokens === undefined || web === undefined || config === undefined) {
      throw new Error('app-tier facades were not exposed');
    }

    const token = tokens.resolve({ storage: 'file', key: 'oauth/kimi-code' });
    await expect(token!.getAccessToken()).resolves.toBe('sk-managed');

    expect(web.getProvider()).toBeUndefined();
    expect(config.get(SERVICES_CONFIG_SECTION)).toEqual({});
    await harness.close();
  });

  it('exposes the session and agent tier facades of sessionTitle and trace', async () => {
    const capture: Capture = {};
    const harness = createHarness({ space: memoryHarnessSpace() });
    harness.app.features.add(createConfig({ persist: fakePersist() }));
    harness.app.features.add(providerCatalog);
    harness.app.features.add(createKimi());
    harness.app.features.add(kimiProbe(capture));
    await tick();
    const session = await harness.app.create({ sessionId: 'sess' });
    await harness.ensureAgent(session, MAIN_AGENT_ID);
    await tick();
    const face = capture.title?.value;
    const promptSource = capture.promptSource?.value;
    const trace = capture.trace?.value;
    if (face === undefined || promptSource === undefined || trace === undefined) {
      throw new Error('session or agent tier facades were not exposed');
    }

    expect(promptSource.compose('user_prompts')).toBeUndefined();
    expect(trace.traceId.value).toBeUndefined();
    await expect(face.generateTitle()).resolves.toBeUndefined();
    await harness.close();
  });
});
