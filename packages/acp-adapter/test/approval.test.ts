import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type ContentBlock,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import type {
  ApprovalHandler,
  ApprovalRequest,
  ApprovalResponse,
  Event,
  KimiHarness,
  Session,
  ToolInputDisplay,
} from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import {
  APPROVE_ALWAYS_OPTION_ID,
  APPROVE_ONCE_OPTION_ID,
  REJECT_OPTION_ID,
  approvalRequestToPermissionOptions,
  buildPermissionToolCallUpdate,
  permissionResponseToApprovalResponse,
} from '../src/approval';
import { AcpServer } from '../src/server';
import { AUTHED_STATUS } from './_helpers/harness-stubs';

function makeInMemoryStreamPair(): {
  agentStream: ReturnType<typeof ndJsonStream>;
  clientStream: ReturnType<typeof ndJsonStream>;
} {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable);
  const clientStream = ndJsonStream(clientToAgent.writable, agentToClient.readable);
  return { agentStream, clientStream };
}

/**
 * Stub Session that captures the registered approval handler and lets
 * the test fire arbitrary events through any `onEvent` subscriber.
 *
 * Mirrors the pattern from `session-prompt.test.ts` but exposes the
 * captured handler so the test can drive the reverse-RPC end-to-end.
 */
function makeApprovalSession(sessionId: string): {
  session: Session;
  emit: (event: Event) => void;
  invokeHandler: (req: ApprovalRequest) => Promise<ApprovalResponse> | ApprovalResponse;
  promptStarted: () => boolean;
  resolvePrompt: () => void;
} {
  const listeners = new Set<(event: Event) => void>();
  let approvalHandler: ApprovalHandler | undefined;
  let started = false;
  let releasePrompt: (() => void) | undefined;

  const session = {
    id: sessionId,
    prompt: async (_input: unknown) => {
      started = true;
      // Park the prompt so the test can drive events and invoke the
      // approval handler before the turn settles. The test resolves
      // this promise explicitly via `resolvePrompt`.
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
    },
    cancel: async () => undefined,
    onEvent: (fn: (event: Event) => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    setApprovalHandler: (handler: ApprovalHandler | undefined) => {
      approvalHandler = handler;
    },
  } as unknown as Session;

  return {
    session,
    emit: (event: Event) => {
      for (const fn of listeners) fn(event);
    },
    invokeHandler: (req: ApprovalRequest) => {
      if (!approvalHandler) {
        throw new Error('approval handler was not registered by AcpSession');
      }
      return approvalHandler(req);
    },
    promptStarted: () => started,
    resolvePrompt: () => releasePrompt?.(),
  };
}

class ApprovalClient implements Client {
  readonly updates: SessionNotification[] = [];
  readonly permissionRequests: RequestPermissionRequest[] = [];
  reply: RequestPermissionResponse = {
    outcome: { outcome: 'selected', optionId: APPROVE_ONCE_OPTION_ID },
  };

  async requestPermission(
    p: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    this.permissionRequests.push(p);
    return this.reply;
  }
  async sessionUpdate(n: SessionNotification): Promise<void> {
    this.updates.push(n);
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('not used in approval test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('not used in approval test');
  }
}

const textBlock = (text: string): ContentBlock => ({ type: 'text', text });

describe('approvalRequestToPermissionOptions', () => {
  it('returns three options in the canonical order with documented kinds', () => {
    const options = approvalRequestToPermissionOptions();
    expect(options).toHaveLength(3);

    expect(options[0]).toEqual({
      optionId: APPROVE_ONCE_OPTION_ID,
      name: 'Approve once',
      kind: 'allow_once',
    });
    expect(options[1]).toEqual({
      optionId: APPROVE_ALWAYS_OPTION_ID,
      name: 'Approve for this session',
      kind: 'allow_always',
    });
    expect(options[2]).toEqual({
      optionId: REJECT_OPTION_ID,
      name: 'Reject',
      kind: 'reject_once',
    });
  });
});

describe('permissionResponseToApprovalResponse', () => {
  it('maps approve_once → { decision: approved } with no scope', () => {
    const result = permissionResponseToApprovalResponse(undefined, {
      outcome: { outcome: 'selected', optionId: APPROVE_ONCE_OPTION_ID },
    });
    expect(result).toEqual({ decision: 'approved' });
    expect(result.scope).toBeUndefined();
  });

  it('maps approve_always → { decision: approved, scope: session }', () => {
    const result = permissionResponseToApprovalResponse(undefined, {
      outcome: { outcome: 'selected', optionId: APPROVE_ALWAYS_OPTION_ID },
    });
    expect(result).toEqual({ decision: 'approved', scope: 'session' });
  });

  it('maps reject → { decision: rejected }', () => {
    const result = permissionResponseToApprovalResponse(undefined, {
      outcome: { outcome: 'selected', optionId: REJECT_OPTION_ID },
    });
    expect(result).toEqual({ decision: 'rejected' });
  });

  it('maps legacy "approve" → { decision: approved } (Python kimi-cli compat)', () => {
    const result = permissionResponseToApprovalResponse(undefined, {
      outcome: { outcome: 'selected', optionId: 'approve' },
    });
    expect(result).toEqual({ decision: 'approved' });
    expect(result.scope).toBeUndefined();
  });

  it('maps legacy "approve_for_session" → { decision: approved, scope: session } (Python kimi-cli compat)', () => {
    const result = permissionResponseToApprovalResponse(undefined, {
      outcome: { outcome: 'selected', optionId: 'approve_for_session' },
    });
    expect(result).toEqual({ decision: 'approved', scope: 'session' });
  });

  it('defensively maps an unknown optionId to { decision: rejected }', () => {
    const result = permissionResponseToApprovalResponse(undefined, {
      outcome: { outcome: 'selected', optionId: 'unknown_option_id' },
    });
    expect(result).toEqual({ decision: 'rejected' });
  });

  it('maps cancelled → { decision: cancelled }', () => {
    const result = permissionResponseToApprovalResponse(undefined, {
      outcome: { outcome: 'cancelled' },
    });
    expect(result).toEqual({ decision: 'cancelled' });
  });
});

describe('buildPermissionToolCallUpdate (Phase 5.1 minimal shape)', () => {
  const fakeDisplay: ToolInputDisplay = { kind: 'command', command: 'ls -la' };
  const baseReq: ApprovalRequest = {
    toolCallId: 'abc',
    toolName: 'Bash',
    action: 'run command',
    display: fakeDisplay,
  };

  it('prefixes the toolCallId with the turnId when one is known', () => {
    const update = buildPermissionToolCallUpdate(42, baseReq);
    expect(update.toolCallId).toBe('42:abc');
    expect(update.title).toBe('Bash');
  });

  it('falls back to the raw SDK toolCallId when no turnId is tracked yet', () => {
    const update = buildPermissionToolCallUpdate(undefined, baseReq);
    expect(update.toolCallId).toBe('abc');
    expect(update.title).toBe('Bash');
  });
});

describe('AcpSession ↔ requestPermission bridge (end-to-end via wire)', () => {
  it('emits a request_permission with options length 3 and prefixed toolCallId when the SDK invokes the registered handler, and resolves it to { decision: approved }', async () => {
    const sessionId = 'sess-approval-wire';
    const turnId = 7;
    const handle = makeApprovalSession(sessionId);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => handle.session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ApprovalClient();
    client.reply = {
      outcome: { outcome: 'selected', optionId: APPROVE_ONCE_OPTION_ID },
    };
    const clientConn = new ClientSideConnection(() => client, clientStream);

    // Open the session so AcpServer constructs the AcpSession (which
    // registers our approval handler).
    await clientConn.newSession({ cwd: '/tmp/x', mcpServers: [] });

    // Kick off a prompt so the in-prompt onEvent subscription is live.
    // The scripted session's `prompt()` parks until we call
    // `resolvePrompt`, giving us a window to drive events + approval.
    const pending = clientConn.prompt({
      sessionId,
      prompt: [textBlock('hi')],
    });

    // Wait one tick for prompt() to subscribe via onEvent.
    await new Promise((r) => setTimeout(r, 5));

    // Fire a tool-call-started event so the adapter learns the
    // current turnId (any event with `turnId` advances it).
    handle.emit({
      type: 'tool.call.started',
      sessionId,
      agentId: 'main',
      turnId,
      toolCallId: 'tc-1',
      name: 'Bash',
      args: { command: 'echo hi' },
    } as Event);

    // Now invoke the captured approval handler exactly as the SDK
    // reverse-RPC layer would.
    const approvalReq: ApprovalRequest = {
      toolCallId: 'tc-1',
      toolName: 'Bash',
      action: 'run command',
      display: { kind: 'command', command: 'echo hi' },
    };
    const decision = await handle.invokeHandler(approvalReq);

    // Phase 5.2 lifts `selectedLabel` from the matched option name.
    // The 5.1 contract (decision discriminator) is preserved.
    expect(decision.decision).toBe('approved');
    expect(decision.scope).toBeUndefined();
    expect(client.permissionRequests).toHaveLength(1);
    const req = client.permissionRequests[0]!;
    expect(req.sessionId).toBe(sessionId);
    expect(req.options).toHaveLength(3);
    expect(req.options.map((o) => o.optionId)).toEqual([
      APPROVE_ONCE_OPTION_ID,
      APPROVE_ALWAYS_OPTION_ID,
      REJECT_OPTION_ID,
    ]);
    expect(req.toolCall.toolCallId).toBe(`${turnId}:tc-1`);
    expect(req.toolCall.title).toBe('Bash');

    // Settle the parked prompt with a turn.ended so the test exits
    // cleanly.
    handle.emit({
      type: 'turn.ended',
      sessionId,
      agentId: 'main',
      turnId,
      reason: 'completed',
    } as Event);
    handle.resolvePrompt();
    await pending;
  });

  it('returns { decision: rejected } when the client throws', async () => {
    const sessionId = 'sess-approval-fail';
    const handle = makeApprovalSession(sessionId);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => handle.session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ApprovalClient();
    // Override to throw so the bridge falls into the catch branch.
    client.requestPermission = async (_p: RequestPermissionRequest) => {
      throw new Error('client unreachable');
    };
    const clientConn = new ClientSideConnection(() => client, clientStream);

    await clientConn.newSession({ cwd: '/tmp/x', mcpServers: [] });
    const pending = clientConn.prompt({
      sessionId,
      prompt: [textBlock('x')],
    });
    await new Promise((r) => setTimeout(r, 5));

    const decision = await handle.invokeHandler({
      toolCallId: 'tc-x',
      toolName: 'Bash',
      action: 'run command',
      display: { kind: 'command', command: 'echo x' },
    });
    expect(decision).toEqual({ decision: 'rejected' });

    handle.emit({
      type: 'turn.ended',
      sessionId,
      agentId: 'main',
      turnId: 1,
      reason: 'completed',
    } as Event);
    handle.resolvePrompt();
    await pending;
  });
});
