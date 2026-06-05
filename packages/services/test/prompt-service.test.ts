/**
 * `PromptServiceImpl` (Chain 4 / P1.4, W7.2) unit tests.
 *
 * Hermetic: a fake `IHarnessBridge` returns canned session list + records
 * the `prompt` / `cancel` payloads. A stub `IEventBus` collects published
 * events into an array we can inspect.
 *
 * Coverage:
 *   - submit(sid, body) returns {prompt_id, user_message_id}
 *   - submit registers an active prompt → busy detection on second submit
 *   - submit translates protocol content → kosong content (text + image_url)
 *   - submit on unknown sid → SessionNotFoundError
 *   - submit on a session with an active completed/aborted prompt succeeds
 *   - observeEvent on `turn.started` captures turnId
 *   - observeEvent on `turn.ended` (top-level, completed) synthesizes
 *     prompt.completed
 *   - observeEvent on `turn.ended` with reason=cancelled synthesizes
 *     prompt.aborted
 *   - observeEvent ignores non-top-level (nested) turn.ended events
 *   - observeEvent on events for an unknown session is a no-op
 *   - abort() rejects PromptNotFoundError when no active prompt
 *   - abort() returns {aborted: true} + publishes prompt.aborted
 *   - second abort() → PromptAlreadyCompletedError (40903)
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  Event,
  SessionSummary,
} from '@moonshot-ai/agent-core';

import {
  type IAuthSummaryService,
  type IEventBus,
  type IHarnessBridge,
  type HarnessRPC,
  PromptAlreadyCompletedError,
  PromptNotFoundError,
  PromptServiceImpl,
  SessionBusyError,
  SessionNotFoundError,
} from '../src';

const SID = 'sess_01PT';
const SESSION_CREATED_AT = 1_700_000_000_000;

function mkSummary(id = SID): SessionSummary {
  return {
    id,
    workDir: '/tmp/ws',
    sessionDir: `/tmp/sessions/${id}`,
    createdAt: SESSION_CREATED_AT,
    updatedAt: SESSION_CREATED_AT,
  };
}

interface RpcRecord {
  promptCalls: unknown[];
  cancelCalls: unknown[];
}

function makeBridge(
  sessions: SessionSummary[] = [mkSummary()],
): { bridge: IHarnessBridge; record: RpcRecord } {
  const record: RpcRecord = { promptCalls: [], cancelCalls: [] };
  const rpc: Partial<HarnessRPC> = {
    listSessions: vi.fn().mockImplementation(async () => sessions),
    prompt: vi.fn().mockImplementation(async (payload) => {
      record.promptCalls.push(payload);
    }),
    cancel: vi.fn().mockImplementation(async (payload) => {
      record.cancelCalls.push(payload);
    }),
  };
  const bridge: IHarnessBridge = {
    rpc: rpc as HarnessRPC,
    ready: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };
  return { bridge, record };
}

function makeBus(): { bus: IEventBus; events: Event[] } {
  const events: Event[] = [];
  const bus: IEventBus = {
    publish: (e: Event) => {
      events.push(e);
    },
  };
  return { bus, events };
}

/**
 * Stub `IAuthSummaryService` for hermetic prompt-service tests. Default
 * `ensureReady()` resolves; tests that need to exercise the readiness gate
 * can pass `{ ensureReadyError }` and assert the error surfaces.
 */
function makeAuth(opts: { ensureReadyError?: Error } = {}): IAuthSummaryService {
  return {
    get: vi.fn().mockResolvedValue({
      ready: true,
      providers_count: 1,
      default_model: 'kimi-k2',
      managed_provider: null,
    }),
    ensureReady: vi.fn().mockImplementation(async () => {
      if (opts.ensureReadyError) throw opts.ensureReadyError;
    }),
  };
}

describe('PromptServiceImpl.submit (W7.2)', () => {
  it('returns ULID-shaped prompt_id + user_message_id derived from it', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = new PromptServiceImpl(bridge, bus, makeAuth());
    const result = await impl.submit(SID, {
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(result.prompt_id).toMatch(/^prompt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.user_message_id).toMatch(/^msg_sess_01PT_pending_prompt_/);
  });

  it('translates text + image content to kosong ContentParts', async () => {
    const { bridge, record } = makeBridge();
    const { bus } = makeBus();
    const impl = new PromptServiceImpl(bridge, bus, makeAuth());
    await impl.submit(SID, {
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', source: { kind: 'url', url: 'https://a.png' } },
      ],
    });
    expect(record.promptCalls).toHaveLength(1);
    const payload = record.promptCalls[0] as {
      sessionId: string;
      agentId: string;
      input: Array<Record<string, unknown>>;
    };
    expect(payload.sessionId).toBe(SID);
    expect(payload.agentId).toBe('main');
    expect(payload.input).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'image_url', imageUrl: { url: 'https://a.png' } },
    ]);
  });

  it('throws SessionBusyError when a non-terminal prompt is already active', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = new PromptServiceImpl(bridge, bus, makeAuth());
    await impl.submit(SID, { content: [{ type: 'text', text: 'one' }] });
    await expect(
      impl.submit(SID, { content: [{ type: 'text', text: 'two' }] }),
    ).rejects.toBeInstanceOf(SessionBusyError);
  });

  it('throws SessionNotFoundError on unknown session id', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = new PromptServiceImpl(bridge, bus, makeAuth());
    await expect(
      impl.submit('sess_missing', { content: [{ type: 'text', text: 'hi' }] }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('clears active state if bridge.prompt() rejects', async () => {
    const sessions = [mkSummary()];
    const promptMock = vi
      .fn<(...args: unknown[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const rpc: Partial<HarnessRPC> = {
      listSessions: vi.fn().mockResolvedValue(sessions),
      prompt: promptMock,
      cancel: vi.fn().mockImplementation(async () => undefined),
    };
    const bridge: IHarnessBridge = {
      rpc: rpc as HarnessRPC,
      ready: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    };
    const { bus } = makeBus();
    const impl = new PromptServiceImpl(bridge, bus, makeAuth());
    await expect(
      impl.submit(SID, { content: [{ type: 'text', text: 'x' }] }),
    ).rejects.toThrowError(/boom/);
    // A second submit must succeed (state was cleared).
    await impl.submit(SID, { content: [{ type: 'text', text: 'x' }] });
  });
});

describe('PromptServiceImpl.observeEvent (lifecycle synthesis)', () => {
  it('captures turnId on the first turn.started after submit', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = new PromptServiceImpl(bridge, bus, makeAuth());
    await impl.submit(SID, { content: [{ type: 'text', text: 'hi' }] });
    impl.observeEvent({
      type: 'turn.started',
      turnId: 42,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(impl._activeForTest(SID)?.turnId).toBe(42);
  });

  it('ignores subsequent turn.started events (treated as nested turns)', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = new PromptServiceImpl(bridge, bus, makeAuth());
    await impl.submit(SID, { content: [{ type: 'text', text: 'hi' }] });
    impl.observeEvent({
      type: 'turn.started',
      turnId: 42,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    impl.observeEvent({
      type: 'turn.started',
      turnId: 99,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(impl._activeForTest(SID)?.turnId).toBe(42);
  });

  it('synthesizes prompt.completed on top-level turn.ended (reason=completed)', async () => {
    const { bridge } = makeBridge();
    const { bus, events } = makeBus();
    const impl = new PromptServiceImpl(bridge, bus, makeAuth());
    const submit = await impl.submit(SID, { content: [{ type: 'text', text: 'hi' }] });
    impl.observeEvent({
      type: 'turn.started',
      turnId: 7,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    const derived = impl.observeEvent({
      type: 'turn.ended',
      turnId: 7,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(derived).toHaveLength(1);
    const synth = derived[0] as unknown as {
      type: string;
      promptId: string;
      reason: string;
    };
    expect(synth.type).toBe('prompt.completed');
    expect(synth.promptId).toBe(submit.prompt_id);
    expect(synth.reason).toBe('completed');
    // The bus.publish wasn't called from observeEvent itself — the bus is the
    // caller and is responsible for republishing the derived events.
    expect(events).toHaveLength(0);
    // Active state cleared.
    expect(impl._activeForTest(SID)).toBeUndefined();
  });

  it('synthesizes prompt.aborted on top-level turn.ended (reason=cancelled)', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = new PromptServiceImpl(bridge, bus, makeAuth());
    await impl.submit(SID, { content: [{ type: 'text', text: 'hi' }] });
    impl.observeEvent({
      type: 'turn.started',
      turnId: 8,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    const derived = impl.observeEvent({
      type: 'turn.ended',
      turnId: 8,
      reason: 'cancelled',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(derived).toHaveLength(1);
    expect((derived[0] as unknown as { type: string }).type).toBe('prompt.aborted');
  });

  it('ignores nested turn.ended (different turnId) so prompt stays active', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = new PromptServiceImpl(bridge, bus, makeAuth());
    await impl.submit(SID, { content: [{ type: 'text', text: 'hi' }] });
    impl.observeEvent({
      type: 'turn.started',
      turnId: 1,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    const derived = impl.observeEvent({
      type: 'turn.ended',
      turnId: 99,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(derived).toEqual([]);
    expect(impl._activeForTest(SID)?.completed).toBe(false);
  });

  it('is a no-op for events on a session with no active prompt', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = new PromptServiceImpl(bridge, bus, makeAuth());
    const derived = impl.observeEvent({
      type: 'turn.ended',
      turnId: 1,
      reason: 'completed',
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    expect(derived).toEqual([]);
  });
});

describe('PromptServiceImpl.abort (W7.3)', () => {
  it('throws PromptNotFoundError when no active prompt for the session', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = new PromptServiceImpl(bridge, bus, makeAuth());
    await expect(impl.abort(SID, 'prompt_xyz')).rejects.toBeInstanceOf(
      PromptNotFoundError,
    );
  });

  it('returns {aborted: true} and publishes prompt.aborted', async () => {
    const { bridge, record } = makeBridge();
    const { bus, events } = makeBus();
    const impl = new PromptServiceImpl(bridge, bus, makeAuth());
    const submit = await impl.submit(SID, {
      content: [{ type: 'text', text: 'hi' }],
    });
    impl.observeEvent({
      type: 'turn.started',
      turnId: 5,
      origin: { kind: 'user' },
      sessionId: SID,
      agentId: 'main',
    } as unknown as Event);
    const result = await impl.abort(SID, submit.prompt_id);
    expect(result.aborted).toBe(true);
    // bridge.rpc.cancel called with the captured turnId.
    expect(record.cancelCalls).toHaveLength(1);
    expect(record.cancelCalls[0]).toEqual({
      sessionId: SID,
      agentId: 'main',
      turnId: 5,
    });
    // prompt.aborted published.
    expect(events).toHaveLength(1);
    expect((events[0] as unknown as { type: string }).type).toBe('prompt.aborted');
  });

  it('throws PromptAlreadyCompletedError on the second abort', async () => {
    const { bridge } = makeBridge();
    const { bus } = makeBus();
    const impl = new PromptServiceImpl(bridge, bus, makeAuth());
    const submit = await impl.submit(SID, {
      content: [{ type: 'text', text: 'hi' }],
    });
    await impl.abort(SID, submit.prompt_id);
    await expect(impl.abort(SID, submit.prompt_id)).rejects.toBeInstanceOf(
      PromptAlreadyCompletedError,
    );
  });
});
