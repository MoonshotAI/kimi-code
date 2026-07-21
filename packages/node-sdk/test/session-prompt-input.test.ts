import { describe, expect, it, vi } from 'vitest';
import type { CoreAPI, RPCMethods } from '@moonshot-ai/agent-core';

import { SDKRpcClientBase } from '../src/rpc';
import { Session } from '../src/session';

class CapturingRpc extends SDKRpcClientBase {
  readonly promptCalls: unknown[] = [];
  readonly enterPlanCalls: unknown[] = [];
  readonly cancelPlanCalls: unknown[] = [];
  readonly getPlanCalls: unknown[] = [];
  readonly clearPlanCalls: unknown[] = [];
  readonly setModelCalls: unknown[] = [];
  private getRpcDelay: Promise<void> | undefined;
  private getRpcCallCount = 0;
  private readonly getRpcWaiters = new Set<() => void>();

  delayGetRpcUntil(promise: Promise<void>): void {
    this.getRpcDelay = promise;
  }

  waitForGetRpcCalls(count: number): Promise<void> {
    if (this.getRpcCallCount >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const check = () => {
        if (this.getRpcCallCount < count) return;
        this.getRpcWaiters.delete(check);
        resolve();
      };
      this.getRpcWaiters.add(check);
    });
  }

  protected async getRpc(): Promise<RPCMethods<CoreAPI>> {
    this.getRpcCallCount += 1;
    for (const waiter of this.getRpcWaiters) waiter();
    if (this.getRpcDelay !== undefined) await this.getRpcDelay;
    return {
      prompt: async (input: unknown) => {
        this.promptCalls.push(input);
      },
      setModel: async (input: unknown) => {
        this.setModelCalls.push(input);
        return { model: 'captured-model' };
      },
      enterPlan: async (input: unknown) => {
        this.enterPlanCalls.push(input);
      },
      cancelPlan: async (input: unknown) => {
        this.cancelPlanCalls.push(input);
      },
      getPlan: async (input: unknown) => {
        this.getPlanCalls.push(input);
        return null;
      },
      clearPlan: async (input: unknown) => {
        this.clearPlanCalls.push(input);
      },
    } as unknown as RPCMethods<CoreAPI>;
  }
}

describe('Session.prompt input normalization', () => {
  it('passes multimodal prompt parts through to the core RPC client', async () => {
    const prompt = vi.fn(async () => {});
    const session = new Session({
      id: 'ses_multimodal_prompt',
      workDir: '/tmp/work',
      rpc: { prompt } as unknown as SDKRpcClientBase,
    });
    const input = [
      { type: 'text', text: 'describe these' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
      { type: 'video_url', videoUrl: { url: 'ms://file-123', id: 'file-123' } },
    ] as const;

    await session.prompt(input);

    expect(prompt).toHaveBeenCalledWith({
      sessionId: 'ses_multimodal_prompt',
      input,
    });
  });

  it('starts btw and returns the forked agent id', async () => {
    const startBtw = vi.fn(async () => 'agent-btw');
    const session = new Session({
      id: 'ses_btw_start',
      workDir: '/tmp/work',
      rpc: { startBtw } as unknown as SDKRpcClientBase,
    });

    await expect(session.startBtw()).resolves.toBe('agent-btw');
    expect(startBtw).toHaveBeenCalledWith({
      sessionId: 'ses_btw_start',
    });
  });

  it('scopes interactive agent id across awaited session operations', async () => {
    const rpc = new CapturingRpc();
    const session = new Session({
      id: 'ses_scoped_agent',
      workDir: '/tmp/work',
      rpc,
    });

    await rpc.withInteractiveAgent('agent-btw', async () => {
      await Promise.resolve();
      await session.prompt('side question');
      await session.setPlanMode(true);
      await session.getPlan();
      await session.clearPlan();
      await session.setPlanMode(false);
      expect(rpc.interactiveAgentId).toBe('agent-btw');
    });

    expect(rpc.interactiveAgentId).toBe('main');
    expect(rpc.promptCalls).toEqual([
      {
        sessionId: 'ses_scoped_agent',
        agentId: 'agent-btw',
        input: [{ type: 'text', text: 'side question' }],
      },
    ]);
    expect(rpc.enterPlanCalls).toEqual([{ sessionId: 'ses_scoped_agent', agentId: 'agent-btw' }]);
    expect(rpc.getPlanCalls).toEqual([{ sessionId: 'ses_scoped_agent', agentId: 'agent-btw' }]);
    expect(rpc.clearPlanCalls).toEqual([{ sessionId: 'ses_scoped_agent', agentId: 'agent-btw' }]);
    expect(rpc.cancelPlanCalls).toEqual([{ sessionId: 'ses_scoped_agent', agentId: 'agent-btw' }]);
  });

  it('isolates overlapping interactive agent scopes while RPC resolution is pending', async () => {
    let releaseRpc!: () => void;
    const getRpcDelay = new Promise<void>((resolve) => {
      releaseRpc = resolve;
    });
    const rpc = new CapturingRpc();
    rpc.delayGetRpcUntil(getRpcDelay);
    const session = new Session({
      id: 'ses_overlapping_agents',
      workDir: '/tmp/work',
      rpc,
    });

    const first = rpc.withInteractiveAgent('agent-a', () => session.setModel('model-a'));
    const second = rpc.withInteractiveAgent('agent-b', () => session.setModel('model-b'));
    await rpc.waitForGetRpcCalls(2);

    expect(rpc.setModelCalls).toEqual([]);
    releaseRpc();
    await Promise.all([first, second]);

    expect(rpc.interactiveAgentId).toBe('main');
    expect(rpc.setModelCalls).toHaveLength(2);
    expect(rpc.setModelCalls).toEqual(
      expect.arrayContaining([
        { sessionId: 'ses_overlapping_agents', agentId: 'agent-a', model: 'model-a' },
        { sessionId: 'ses_overlapping_agents', agentId: 'agent-b', model: 'model-b' },
      ]),
    );
  });
});
