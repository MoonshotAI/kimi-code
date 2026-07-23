import type { CoreAPI, RPCMethods } from '@moonshot-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';

import {
  Session,
  type Event,
  type PasswordHandler,
  type PasswordRequest,
  type PasswordResult,
} from '#/index';
import { SDKRpcClientBase } from '#/rpc';

describe('Session password handler', () => {
  it('registers a password handler and returns handler results', async () => {
    const rpc = new TestSDKRpcClient();
    const session = new Session({
      id: 'ses_password_handler',
      workDir: '/tmp',
      rpc,
    });
    const handler = vi.fn(async (request: PasswordRequest) => {
      expect(request).toMatchObject({ prompt: '[sudo] password for alice:' });
      return { kind: 'submitted', password: 'hunter2' } as const;
    });
    session.setPasswordHandler(handler);

    await expect(
      rpc.requestPassword({
        sessionId: session.id,
        agentId: 'main',
        prompt: '[sudo] password for alice:',
        command: 'sudo ls /root',
      }),
    ).resolves.toEqual({ kind: 'submitted', password: 'hunter2' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: session.id, agentId: 'main' }),
    );
  });

  it('resolves cancelled when no handler is registered', async () => {
    const rpc = new TestSDKRpcClient();
    const session = new Session({
      id: 'ses_password_default',
      workDir: '/tmp',
      rpc,
    });

    await expect(
      rpc.requestPassword({ sessionId: session.id, agentId: 'main', prompt: 'password:' }),
    ).resolves.toEqual({ kind: 'cancelled' });
    await session.close();
  });

  it('resolves cancelled and emits an error event when the handler throws', async () => {
    const rpc = new TestSDKRpcClient();
    const session = new Session({
      id: 'ses_password_throw',
      workDir: '/tmp',
      rpc,
    });
    session.setPasswordHandler(() => {
      throw new Error('boom');
    });
    const events: Event[] = [];
    rpc.onEvent((event) => {
      events.push(event);
    });

    await expect(
      rpc.requestPassword({ sessionId: session.id, agentId: 'main', prompt: 'password:' }),
    ).resolves.toEqual({ kind: 'cancelled' });
    // The error event carries only the message — never any password material.
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });

  it('clears the handler when the session closes', async () => {
    const rpc = new TestSDKRpcClient();
    const session = new Session({
      id: 'ses_password_close',
      workDir: '/tmp',
      rpc,
    });
    session.setPasswordHandler(() => ({ kind: 'submitted', password: 'hunter2' }));
    await session.close();

    await expect(
      rpc.requestPassword({ sessionId: session.id, agentId: 'main', prompt: 'password:' }),
    ).resolves.toEqual({ kind: 'cancelled' });
  });
});

class TestSDKRpcClient extends SDKRpcClientBase {
  protected getRpc(): Promise<RPCMethods<CoreAPI>> {
    throw new Error('not needed for password dispatch');
  }

  override async closeSession(): Promise<void> {}
}

// Type-level guard: the handler signature stays the SDK contract.
const _typecheck: PasswordHandler = (request: PasswordRequest): PasswordResult => ({
  kind: 'cancelled',
});
void _typecheck;
