import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IMcpOAuthService, AppMcpOAuthService } from '#/app/mcpConfig/oauthService';
import { IMcpOAuthStore } from '#/app/mcpConfig/oauthStore';

import { stubLog } from '../../_base/log/stubs';
import { deferredAgentIdentityStub } from '../agentIdentity/stubs';
import { createMemoryMcpOAuthStore } from '../../mcpCore/stubs';

describe('App MCP OAuth bootstrap', () => {
  let disposables: DisposableStore;

  beforeEach(() => {
    disposables = new DisposableStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    disposables.dispose();
  });

  it('starts the proactive refresh sweep only after identity resolution', async () => {
    const memory = createMemoryMcpOAuthStore();
    let signalList: () => void = () => undefined;
    const listed = new Promise<void>((resolve) => {
      signalList = resolve;
    });
    const list = vi.fn(async (prefix?: string) => {
      signalList();
      return memory.list(prefix);
    });
    const identity = deferredAgentIdentityStub({ slug: 'test-agent' });
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.defineInstance(IMcpOAuthStore, {
          _serviceBrand: undefined,
          ...memory,
          list,
        });
        reg.defineInstance(ILogService, stubLog());
        reg.defineInstance(IAgentIdentity, identity.identity);
        reg.define(IMcpOAuthService, AppMcpOAuthService);
      },
    });
    ix.get(IMcpOAuthService);

    await Promise.resolve();
    expect(list).not.toHaveBeenCalled();

    identity.freeze();
    await listed;
    expect(list).toHaveBeenCalledTimes(1);
  });
});
