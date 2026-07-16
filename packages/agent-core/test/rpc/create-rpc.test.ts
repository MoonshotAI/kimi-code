import { describe, expect, it, vi } from 'vitest';

import { ErrorCodes, KimiError } from '../../src/errors';
import { createRPC } from '../../src/rpc';

interface CoreSide {
  getConfig(payload: { sessionId: string }): { model: string };
}

interface HostSide {
  emitEvent(event: { type: string; payload: { value: number } }): void;
  requestApproval(request: { requestId: string; toolName: string }): Promise<{ decision: string }>;
  fail(request: { code: string }): Promise<void>;
}

describe('createRPC', () => {
  it('routes request and response payloads across both sides', async () => {
    const [connectCore, connectHost] = createRPC<CoreSide, HostSide>();
    const hostImpl = {
      emitEvent: vi.fn(),
      requestApproval: vi.fn(async (request: { requestId: string; toolName: string }) => ({
        decision: `approved:${request.toolName}`,
      })),
      fail: vi.fn(async () => {}),
    };

    const hostProxyPromise = connectCore({
      getConfig: ({ sessionId }) => ({ model: `model-for:${sessionId}` }),
    });
    const coreProxy = await connectHost(hostImpl);
    const hostProxy = await hostProxyPromise;

    await hostProxy.emitEvent({ type: 'agent.status.updated', payload: { value: 1 } });
    await expect(
      hostProxy.requestApproval({ requestId: 'approval-1', toolName: 'Bash' }),
    ).resolves.toEqual({ decision: 'approved:Bash' });
    await expect(coreProxy.getConfig({ sessionId: 'session-1' })).resolves.toEqual({
      model: 'model-for:session-1',
    });
    expect(hostImpl.emitEvent).toHaveBeenCalledWith({
      type: 'agent.status.updated',
      payload: { value: 1 },
    });
  });

  it('binds prototype methods and rehydrates plain remote errors as KimiError(internal)', async () => {
    class HostImpl implements HostSide {
      readonly approvals: string[] = [];

      emitEvent(_event: { type: string; payload: { value: number } }): void {}

      async requestApproval(request: { requestId: string; toolName: string }) {
        this.approvals.push(request.requestId);
        return { decision: 'approved' };
      }

      async fail(request: { code: string }): Promise<void> {
        throw new Error(`host failed:${request.code}`);
      }
    }

    const hostImpl = new HostImpl();
    const [connectCore, connectHost] = createRPC<CoreSide, HostSide>();
    const hostProxyPromise = connectCore({
      getConfig: ({ sessionId }) => ({ model: sessionId }),
    });
    await connectHost(hostImpl);
    const hostProxy = await hostProxyPromise;

    await expect(
      hostProxy.requestApproval({ requestId: 'approval-2', toolName: 'Bash' }),
    ).resolves.toEqual({ decision: 'approved' });

    await expect(hostProxy.fail({ code: 'boom' })).rejects.toMatchObject({
      message: 'host failed:boom',
      code: ErrorCodes.INTERNAL,
    });
    await expect(hostProxy.fail({ code: 'boom' })).rejects.toBeInstanceOf(KimiError);
    expect(hostImpl.approvals).toEqual(['approval-2']);
  });

  it('passes a thrown KimiError across the wire preserving code and details', async () => {
    interface CallerSide {}
    interface RemoteSide {
      prompt(payload: { input: string }): Promise<void>;
    }
    const [connectCaller, connectRemote] = createRPC<CallerSide, RemoteSide>();
    const remoteProxyPromise = connectCaller({});
    await connectRemote({
      async prompt(payload) {
        if (payload.input === '') {
          throw new KimiError(ErrorCodes.REQUEST_PROMPT_INPUT_EMPTY, 'Prompt input cannot be empty', {
            details: { hint: 'pass at least one content part' },
            cause: new Error('local diagnostic — must not cross'),
          });
        }
      },
    });
    const remoteProxy = await remoteProxyPromise;

    const received = await remoteProxy.prompt({ input: '' }).then(
      () => {
        throw new Error('expected prompt() to reject');
      },
      (error: unknown) => error,
    );

    expect(received).toBeInstanceOf(KimiError);
    const error = received as KimiError;
    expect(error.code).toBe(ErrorCodes.REQUEST_PROMPT_INPUT_EMPTY);
    expect(error.message).toBe('Prompt input cannot be empty');
    expect(error.details).toEqual({ hint: 'pass at least one content part' });
    expect(error.cause).toBeUndefined();
  });

  it('serializes remote error details through JSON semantics before crossing the wire', async () => {
    interface RemoteSide {
      fail(payload: {}): Promise<void>;
    }
    const [connectCaller, connectRemote] = createRPC<{}, RemoteSide>();
    const remoteProxyPromise = connectCaller({});
    await connectRemote({
      async fail() {
        const details: Record<string, unknown> = {
          nested: { ok: true },
          at: new Date('2026-05-18T00:00:00.000Z'),
          dropped: undefined,
          notFinite: Number.NaN,
          cause: new Error('detail failed'),
        };
        throw new KimiError(ErrorCodes.INTERNAL, 'Remote failed', {
          details,
        });
      },
    });
    const remoteProxy = await remoteProxyPromise;

    const received = await remoteProxy.fail({}).then(
      () => {
        throw new Error('expected fail() to reject');
      },
      (error: unknown) => error,
    );

    expect(received).toBeInstanceOf(KimiError);
    const error = received as KimiError;
    expect(error.details).toEqual({
      nested: { ok: true },
      at: '2026-05-18T00:00:00.000Z',
      notFinite: null,
      cause: {},
    });
  });

  it('rehydrates provider.* codes as KimiError', async () => {
    interface RemoteSide {
      callProvider(payload: { kind: string }): Promise<void>;
    }
    const [connectCaller, connectRemote] = createRPC<{}, RemoteSide>();
    const remoteProxyPromise = connectCaller({});
    await connectRemote({
      async callProvider() {
        throw new KimiError(ErrorCodes.PROVIDER_RATE_LIMIT, 'Upstream rate limit', {
          details: { retryAfterMs: 1000 },
        });
      },
    });
    const remoteProxy = await remoteProxyPromise;

    const received = await remoteProxy.callProvider({ kind: 'chat' }).then(
      () => {
        throw new Error('expected callProvider() to reject');
      },
      (error: unknown) => error,
    );

    expect(received).toBeInstanceOf(KimiError);
    const error = received as KimiError;
    expect(error.code).toBe(ErrorCodes.PROVIDER_RATE_LIMIT);
    expect(error.details).toEqual({ retryAfterMs: 1000 });
  });

  it('collapses non-Error throws to KimiError(internal)', async () => {
    interface RemoteSide {
      misbehave(payload: {}): Promise<void>;
    }
    const [connectCaller, connectRemote] = createRPC<{}, RemoteSide>();
    const remoteProxyPromise = connectCaller({});
    await connectRemote({
      async misbehave() {
        // oxlint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error
        throw 'not an error object';
      },
    });
    const remoteProxy = await remoteProxyPromise;

    await expect(remoteProxy.misbehave({})).rejects.toMatchObject({
      code: ErrorCodes.INTERNAL,
      message: 'not an error object',
    });
    await expect(remoteProxy.misbehave({})).rejects.toBeInstanceOf(KimiError);
  });

  it('handles a remote method that returns undefined', async () => {
    interface RemoteSide {
      noop(payload: {}): Promise<void>;
    }
    const [connectCaller, connectRemote] = createRPC<{}, RemoteSide>();
    const remoteProxyPromise = connectCaller({});
    await connectRemote({
      async noop() {
        return undefined;
      },
    });
    const remoteProxy = await remoteProxyPromise;

    await expect(remoteProxy.noop({})).resolves.toBeUndefined();
  });

  it('handles very large payloads across the wire', async () => {
    interface RemoteSide {
      echo(payload: { data: string }): Promise<{ data: string }>;
    }
    interface CallerSide {
      echo(payload: { data: string }): Promise<{ data: string }>;
    }
    const [connectCaller, connectRemote] = createRPC<CallerSide, RemoteSide>();
    const callerProxyPromise = connectCaller({
      async echo({ data }) {
        return { data };
      },
    });
    await connectRemote({
      async echo({ data }) {
        return { data };
      },
    });
    const callerProxy = await callerProxyPromise;

    const largeData = 'x'.repeat(100_000);
    const result = await callerProxy.echo({ data: largeData });
    expect(result.data).toBe(largeData);
    expect(result.data.length).toBe(100_000);
  });

  it('multiple concurrent remote calls all resolve correctly', async () => {
    interface RemoteSide {
      add(payload: { a: number; b: number }): Promise<{ sum: number }>;
    }
    const [connectCaller, connectRemote] = createRPC<{}, RemoteSide>();
    const remoteProxyPromise = connectCaller({});
    await connectRemote({
      async add({ a, b }) {
        return { sum: a + b };
      },
    });
    const remoteProxy = await remoteProxyPromise;

    const results = await Promise.all([
      remoteProxy.add({ a: 1, b: 2 }),
      remoteProxy.add({ a: 10, b: 20 }),
      remoteProxy.add({ a: 100, b: 200 }),
    ]);
    expect(results[0].sum).toBe(3);
    expect(results[1].sum).toBe(30);
    expect(results[2].sum).toBe(300);
  });

  it('handles connectCore before connectHost gracefully', async () => {
    const [connectCore, connectHost] = createRPC<CoreSide, HostSide>();
    const hostProxyPromise = connectCore({
      getConfig: ({ sessionId }) => ({ model: `model:${sessionId}` }),
    });
    // hostProxyPromise should not resolve until connectHost is called
    const hostImpl = {
      emitEvent: vi.fn(),
      requestApproval: vi.fn(),
      fail: vi.fn(),
    };
    await connectHost(hostImpl);
    const hostProxy = await hostProxyPromise;
    expect(typeof hostProxy.emitEvent).toBe('function');
  });
});
