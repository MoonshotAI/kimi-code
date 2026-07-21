import { describe, expect, it } from 'vitest';

import { SDKRpcClientBase } from '#/rpc';

/**
 * A minimal `SDKRpcClientBase` whose `getRpc()` resolves to an injected mock.
 * Used to exercise `getStatus` against a controllable RPC surface without
 * spinning up a real in-process core.
 */
class StubRpc extends SDKRpcClientBase {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly rpc: any,
  ) {
    super();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async getRpc(): Promise<any> {
    return this.rpc;
  }
}

const SESSION_ID = 'ses_status';

/** The non-subagent RPC surface `getStatus` always touches. */
function baseRpc() {
  return {
    getConfig: async () => ({
      modelAlias: 'main-model',
      thinkingEffort: 'medium',
      modelCapabilities: { max_context_tokens: 100_000 },
    }),
    getContext: async () => ({ tokenCount: 1234 }),
    getPermission: async () => ({ mode: 'auto' }),
    getPlan: async () => null,
    getSwarmMode: async () => false,
    getUsage: async () => ({}),
  };
}

describe('SDKRpcClientBase.getStatus — subagent overrides', () => {
  it('populates subagentModel / subagentThinkingEffort when the RPCs return values', async () => {
    const rpc = new StubRpc({
      ...baseRpc(),
      getSubagentModel: async () => ({ subagentModel: 'sub-model' }),
      getSubagentThinking: async () => ({ subagentThinkingEffort: 'high' }),
    });

    await expect(rpc.getStatus({ sessionId: SESSION_ID })).resolves.toMatchObject({
      model: 'main-model',
      subagentModel: 'sub-model',
      subagentThinkingEffort: 'high',
      thinkingEffort: 'medium',
    });
  });

  it('returns undefined subagent fields when the RPCs report nothing configured', async () => {
    const rpc = new StubRpc({
      ...baseRpc(),
      getSubagentModel: async () => ({ subagentModel: undefined }),
      getSubagentThinking: async () => ({ subagentThinkingEffort: undefined }),
    });

    await expect(rpc.getStatus({ sessionId: SESSION_ID })).resolves.toMatchObject({
      subagentModel: undefined,
      subagentThinkingEffort: undefined,
    });
  });

  it('does not throw and leaves subagent fields undefined against an older core lacking the RPCs', async () => {
    // Simulate an older core: the subagent methods are not registered on the
    // proxy, so the keys are absent entirely (not just undefined).
    const rpc = new StubRpc(baseRpc());

    const status = await rpc.getStatus({ sessionId: SESSION_ID });
    expect(status.subagentModel).toBeUndefined();
    expect(status.subagentThinkingEffort).toBeUndefined();
    // The rest of the status surface is still populated normally.
    expect(status).toMatchObject({
      model: 'main-model',
      thinkingEffort: 'medium',
      contextTokens: 1234,
      maxContextTokens: 100_000,
    });
  });
});
