import { describe, expect, it } from 'vitest';

import { NativeSessionAdapter } from '#/cli/native-session-adapter';
import type { NativeServerClientLike } from '#/cli/native-server-client';

/** A fake `kimi-server-serve` client capturing RPC calls + wired sinks so a
 *  test can drive events and approvals without a live server process. */
class FakeServerClient implements NativeServerClientLike {
  calls: Array<[string, unknown]> = [];
  prompts: Array<{ sessionId: string; input: unknown; agentId?: string }> = [];
  resolves: Array<{ id: string; allow: boolean; reason?: string }> = [];
  cancellations: string[] = [];
  saves = 0;
  loads = 0;
  permissionModes: string[] = [];
  private listeners = new Set<(event: Record<string, unknown>) => void>();

  constructor(private readonly sessionId = 's1') {}

  call(method: string, params: unknown = null): Promise<unknown> {
    this.calls.push([method, params]);
    switch (method) {
      case 'session/save':
        this.saves += 1;
        return Promise.resolve({ ok: true });
      case 'session/load':
        this.loads += 1;
        return Promise.resolve({ found: true });
      case 'session/list':
        return Promise.resolve({ sessions: [] });
      case 'session/run_shell':
        return Promise.resolve({ output: 'hello\n', is_error: false });
      case 'session/get_status':
        return Promise.resolve({
          model: 'kimi-k2',
          thinking_effort: 'high',
          permission: 'manual',
          plan_mode: false,
          swarm_mode: false,
          goal_enabled: true,
          context_tokens: 10,
          max_context_tokens: 100,
          context_usage: 0.1,
        });
      default:
        return Promise.resolve({ ok: true });
    }
  }

  sessionCreate(_options: { sessionId?: string }): Promise<{ session_id: string }> {
    this.calls.push(['session/create', _options]);
    return Promise.resolve({ session_id: this.sessionId });
  }

  sessionPrompt(
    sessionId: string,
    input: unknown,
    agentId?: string,
  ): Promise<unknown> {
    this.prompts.push({ sessionId, input, agentId });
    return Promise.resolve({ stop_reason: 'EndTurn', steps: 1, usage: { total: { total_tokens: 3 } } });
  }

  sessionCancel(sessionId: string): Promise<{ cancelled: boolean } | null> {
    this.cancellations.push(sessionId);
    return Promise.resolve({ cancelled: true });
  }

  approvalList(_sessionId?: string): Promise<unknown[]> {
    return Promise.resolve([]);
  }

  approvalResolve(id: string, allow: boolean, reason?: string): Promise<boolean> {
    this.resolves.push({ id, allow, reason });
    return Promise.resolve(true);
  }

  onEvent(listener: (event: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onSessionEvent(
    sessionId: string,
    listener: (event: Record<string, unknown>) => void,
  ): () => void {
    return this.onEvent((event) => {
      if (event['session_id'] === sessionId) listener(event);
    });
  }

  close(): void {}

  /** Test hook: deliver a raw engine wire event to every subscriber. */
  emitEvent(event: Record<string, unknown>): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** Raw engine wire event; the adapter passes it through as `llm.delta`. */
function rawTextDelta(text: string, sessionId = 's1'): Record<string, unknown> {
  return { type: 'llm.delta', session_id: sessionId, part: { type: 'text', text } };
}

/** Raw engine approval request event (approval store wire shape). */
function rawApprovalRequest(
  id: string,
  toolName: string,
  sessionId = 's1',
): Record<string, unknown> {
  return {
    type: 'session.approval.requested',
    session_id: sessionId,
    approval_id: id,
    tool_call_id: `c-${id}`,
    tool_name: toolName,
    arguments: { path: '/tmp/x' },
  };
}

describe('NativeSessionAdapter', () => {
  it('fans out events to dynamic subscribers and supports unsubscribe', async () => {
    const fake = new FakeServerClient();
    const adapter = new NativeSessionAdapter({ client: fake });
    await adapter.start({ sessionId: 's1' });

    const a: string[] = [];
    const b: string[] = [];
    const collect = (into: string[]) => (e: { type: string; part?: { type?: string; text?: string } }) => {
      if (e.type === 'llm.delta' && e.part?.type === 'text' && e.part.text !== undefined) {
        into.push(e.part.text);
      }
    };
    const offA = adapter.onEvent(collect(a) as never);
    adapter.onEvent(collect(b) as never);

    fake.emitEvent(rawTextDelta('one'));
    offA(); // A unsubscribes
    fake.emitEvent(rawTextDelta('two'));

    expect(a).toEqual(['one']); // stopped after unsubscribe
    expect(b).toEqual(['one', 'two']); // still receiving
  });

  it('filters out events for other sessions', async () => {
    const fake = new FakeServerClient();
    const adapter = new NativeSessionAdapter({ client: fake });
    await adapter.start({ sessionId: 's1' });

    const seen: string[] = [];
    adapter.onEvent(
      (e: { type: string; part?: { type?: string; text?: string } }) =>
        e.type === 'llm.delta' && e.part?.type === 'text' && seen.push(e.part?.text ?? ''),
    );

    fake.emitEvent(rawTextDelta('mine'));
    fake.emitEvent(rawTextDelta('other', 's2')); // different session → dropped
    fake.emitEvent({ type: 'cron.fired' }); // no session id → routed to this session

    expect(seen).toEqual(['mine']);
  });

  it('delegates prompt/cancel/save to the server client', async () => {
    const fake = new FakeServerClient();
    const adapter = new NativeSessionAdapter({ client: fake });
    await adapter.start({ sessionId: 's1' });

    const outcome = await adapter.prompt('do it');
    expect(fake.prompts).toEqual([{ sessionId: 's1', input: [{ type: 'text', text: 'do it' }] }]);
    expect(outcome).toEqual({ stopReason: 'EndTurn', steps: 1, totalTokens: 3 });
    expect(await adapter.cancel()).toBe(true);
    expect(fake.cancellations).toEqual(['s1']);
    expect(await adapter.save()).toBe(true);
    expect(fake.saves).toBe(1);
  });

  it('routes approvals to the current handler (event-driven resolve), and allows when none is set', async () => {
    const fake = new FakeServerClient();
    const adapter = new NativeSessionAdapter({ client: fake });
    await adapter.start({ sessionId: 's1' });
    // Approval resolution is asynchronous (event → handler → resolve RPC);
    // flush the microtask queue before asserting.
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    // No handler yet → allow (auto-like default for the pre-handler window).
    fake.emitEvent(rawApprovalRequest('a1', 'Write'));
    await flush();
    expect(fake.resolves).toEqual([{ id: 'a1', allow: true, reason: undefined }]);

    // Set a denying handler → the decision feeds back as deny.
    const seen: string[] = [];
    adapter.setApprovalHandler((req) => {
      seen.push(req.toolName);
      return Promise.resolve(false);
    });
    fake.emitEvent(rawApprovalRequest('a2', 'Bash'));
    await flush();
    expect(seen).toEqual(['Bash']);
    expect(fake.resolves.at(-1)).toEqual({ id: 'a2', allow: false, reason: undefined });

    // Clear the handler → back to allow.
    adapter.setApprovalHandler(undefined);
    fake.emitEvent(rawApprovalRequest('a3', 'Write'));
    await flush();
    expect(fake.resolves.at(-1)).toEqual({ id: 'a3', allow: true, reason: undefined });

    // A throwing handler fails closed (deny), never leaving the tool waiting.
    adapter.setApprovalHandler(() => Promise.reject(new Error('UI died')));
    fake.emitEvent(rawApprovalRequest('a4', 'Edit'));
    await flush();
    expect(fake.resolves.at(-1)).toEqual({ id: 'a4', allow: false, reason: undefined });
  });

  it('approval events are not delivered to the event stream', async () => {
    const fake = new FakeServerClient();
    const adapter = new NativeSessionAdapter({ client: fake });
    await adapter.start({ sessionId: 's1' });

    const types: string[] = [];
    adapter.onEvent((e) => types.push(e.type));
    fake.emitEvent(rawApprovalRequest('a1', 'Write'));
    fake.emitEvent(rawTextDelta('hi'));

    expect(types).toEqual(['llm.delta']);
  });

  it('start wires permission mode onto the process-wide gate', async () => {
    const fake = new FakeServerClient();
    const adapter = new NativeSessionAdapter({ client: fake });
    await adapter.start({ sessionId: 's1', permissionMode: 'manual' });
    expect(fake.calls).toContainEqual(['permission/set_mode', { mode: 'manual' }]);
    expect(adapter.isStarted).toBe(true);
    expect(adapter.id).toBe('s1');

    // Runtime setPermission drives the same gate.
    await adapter.setPermission('yolo');
    expect(fake.calls).toContainEqual(['permission/set_mode', { mode: 'yolo' }]);
  });

  it('setModel/setThinking forward to the session RPCs', async () => {
    const fake = new FakeServerClient();
    const adapter = new NativeSessionAdapter({ client: fake });
    await adapter.start({ sessionId: 's1' });
    await adapter.setModel('kimi-k2');
    await adapter.setThinking('high');
    await adapter.setThinking(null);
    expect(fake.calls).toContainEqual(['session/set_model', { session_id: 's1', model: 'kimi-k2' }]);
    expect(fake.calls).toContainEqual(['session/set_thinking', { session_id: 's1', effort: 'high' }]);
    expect(fake.calls).toContainEqual(['session/set_thinking', { session_id: 's1', effort: null }]);
  });

  it('runShellCommand delegates to session/run_shell, and reports unavailable before start', async () => {
    const fake = new FakeServerClient();
    const adapter = new NativeSessionAdapter({ client: fake });
    await adapter.start({ sessionId: 's1' });
    const out = await adapter.runShellCommand('echo hello', 30, 'cmd1');
    expect(out).toEqual({ output: 'hello\n', isError: false, unavailable: false });
    expect(fake.calls).toContainEqual([
      'session/run_shell',
      { session_id: 's1', command: 'echo hello', timeout_s: 30, command_id: 'cmd1' },
    ]);

    // Unstarted adapter → unavailable (host should run it).
    const bare = new NativeSessionAdapter({ client: new FakeServerClient() });
    expect(await bare.runShellCommand('ls')).toEqual({
      output: null,
      isError: false,
      unavailable: true,
    });
  });

  it('reloadSession and steer drive the load RPC + steer queue', async () => {
    const fake = new FakeServerClient('R1');
    const adapter = new NativeSessionAdapter({ client: fake });
    await adapter.start({ sessionId: 'R1' });
    expect(await adapter.reloadSession()).toBe(true); // load RPC → found
    expect(fake.loads).toBe(1);
    await adapter.steer('redirect now');
    expect(fake.calls).toContainEqual([
      'session/steer',
      { session_id: 'R1', input: [{ type: 'text', text: 'redirect now' }] },
    ]);
  });

  it('listSessions forwards to session/list and returns [] when unstarted', async () => {
    const fake = new FakeServerClient();
    const adapter = new NativeSessionAdapter({ client: fake });
    await adapter.start({ sessionId: 's1' });
    expect(await adapter.listSessions()).toEqual([]);

    const bare = new NativeSessionAdapter({ client: new FakeServerClient() });
    expect(await bare.listSessions()).toEqual([]);
  });

  it('session-scoped RPCs carry the engine-assigned session id', async () => {
    // The server may assign a different id than the one requested; the
    // adapter must bind every subsequent call to the assigned id.
    const fake = new FakeServerClient('S-42');
    const adapter = new NativeSessionAdapter({ client: fake });
    await adapter.start({ sessionId: 'requested-id' });

    await adapter.setModel('m1');
    await adapter.getStatus();
    await adapter.startBtw();
    expect(fake.calls).toContainEqual(['session/set_model', { session_id: 'S-42', model: 'm1' }]);
    expect(fake.calls).toContainEqual(['session/get_status', { session_id: 'S-42' }]);
    expect(fake.calls).toContainEqual(['session/start_btw', { session_id: 'S-42' }]);
    expect(adapter.id).toBe('S-42');
  });

  it('btw lifecycle forwards to start_btw/end_btw', async () => {
    const fake = new FakeServerClient();
    const adapter = new NativeSessionAdapter({ client: fake });
    await adapter.start({ sessionId: 's1' });
    fake.calls.length = 0;

    expect(await adapter.startBtw()).toBe(null); // default response has no btw_id
    expect(fake.calls).toContainEqual(['session/start_btw', { session_id: 's1' }]);
    expect(await adapter.endBtw()).toBe(false);
    expect(fake.calls).toContainEqual(['session/end_btw', { session_id: 's1' }]);
  });
});
