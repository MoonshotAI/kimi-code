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
  type ToolCallContent,
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
  attachSelectedLabel,
  approvalRequestToPermissionOptions,
  buildPermissionToolCallUpdate,
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

function makeApprovalSession(sessionId: string): {
  session: Session;
  emit: (event: Event) => void;
  invokeHandler: (req: ApprovalRequest) => Promise<ApprovalResponse> | ApprovalResponse;
  resolvePrompt: () => void;
} {
  const listeners = new Set<(event: Event) => void>();
  let approvalHandler: ApprovalHandler | undefined;
  let releasePrompt: (() => void) | undefined;

  const session = {
    id: sessionId,
    prompt: async (_input: unknown) => {
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
    resolvePrompt: () => releasePrompt?.(),
  };
}

class ApprovalDisplayClient implements Client {
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
    throw new Error('not used in approval-display test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('not used in approval-display test');
  }
}

const textBlock = (text: string): ContentBlock => ({ type: 'text', text });

describe('buildPermissionToolCallUpdate (Phase 5.2 content shape)', () => {
  const baseReq = (display: ToolInputDisplay): ApprovalRequest => ({
    toolCallId: 'tc-1',
    toolName: 'Edit',
    action: 'edit file',
    display,
  });

  it('includes a diff entry + action summary when display.kind === "diff"', () => {
    const update = buildPermissionToolCallUpdate(
      3,
      baseReq({
        kind: 'diff',
        path: '/tmp/x.ts',
        before: 'old',
        after: 'new',
      }),
    );
    expect(update.toolCallId).toBe('3:tc-1');
    expect(update.title).toBe('Edit');
    expect(update.content).toHaveLength(2);
    const [diff, action] = update.content as [ToolCallContent, ToolCallContent];
    expect(diff).toEqual({
      type: 'diff',
      path: '/tmp/x.ts',
      oldText: 'old',
      newText: 'new',
    });
    expect(action).toEqual({
      type: 'content',
      content: { type: 'text', text: 'Requesting approval to edit file' },
    });
  });

  it('includes a diff entry for file_io with both before+after (Edit/Write payload)', () => {
    const update = buildPermissionToolCallUpdate(
      4,
      baseReq({
        kind: 'file_io',
        operation: 'edit',
        path: '/tmp/y.ts',
        before: 'before',
        after: 'after',
      }),
    );
    expect(update.content).toHaveLength(2);
    const [diff] = update.content as [ToolCallContent, ToolCallContent];
    expect(diff).toEqual({
      type: 'diff',
      path: '/tmp/y.ts',
      oldText: 'before',
      newText: 'after',
    });
  });

  it('emits only the action summary for non-diff display kinds (e.g. command)', () => {
    const update = buildPermissionToolCallUpdate(
      5,
      {
        toolCallId: 'tc-cmd',
        toolName: 'Bash',
        action: 'run shell command',
        display: { kind: 'command', command: 'ls -la' },
      },
    );
    expect(update.content).toHaveLength(1);
    const [only] = update.content as [ToolCallContent];
    expect(only).toEqual({
      type: 'content',
      content: { type: 'text', text: 'Requesting approval to run shell command' },
    });
  });

  it('drops the diff for file_io without both before and after', () => {
    // Read-only file_io (e.g. Read tool) doesn't carry a diff hunk —
    // the display block has only `content`, not `before`/`after`. The
    // approval prompt should fall back to the action summary alone.
    const update = buildPermissionToolCallUpdate(
      6,
      {
        toolCallId: 'tc-read',
        toolName: 'Read',
        action: 'read file',
        display: {
          kind: 'file_io',
          operation: 'read',
          path: '/tmp/z.ts',
          content: 'file contents...',
        },
      },
    );
    expect(update.content).toHaveLength(1);
  });
});

describe('attachSelectedLabel', () => {
  const options = approvalRequestToPermissionOptions();

  it('returns the input unchanged when the outcome is cancelled', () => {
    const approval: ApprovalResponse = { decision: 'cancelled' };
    const result = attachSelectedLabel(
      { outcome: { outcome: 'cancelled' } },
      approval,
      options,
    );
    expect(result).toEqual({ decision: 'cancelled' });
    expect(result.selectedLabel).toBeUndefined();
  });

  it('attaches "Approve once" when approve_once is selected', () => {
    const approval: ApprovalResponse = { decision: 'approved' };
    const result = attachSelectedLabel(
      { outcome: { outcome: 'selected', optionId: APPROVE_ONCE_OPTION_ID } },
      approval,
      options,
    );
    expect(result).toEqual({ decision: 'approved', selectedLabel: 'Approve once' });
  });

  it('attaches "Approve for this session" when approve_always is selected', () => {
    const approval: ApprovalResponse = { decision: 'approved', scope: 'session' };
    const result = attachSelectedLabel(
      { outcome: { outcome: 'selected', optionId: APPROVE_ALWAYS_OPTION_ID } },
      approval,
      options,
    );
    expect(result).toEqual({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    });
  });

  it('attaches "Reject" when reject is selected', () => {
    const approval: ApprovalResponse = { decision: 'rejected' };
    const result = attachSelectedLabel(
      { outcome: { outcome: 'selected', optionId: REJECT_OPTION_ID } },
      approval,
      options,
    );
    expect(result).toEqual({ decision: 'rejected', selectedLabel: 'Reject' });
  });

  it('returns the input unchanged when the optionId is unknown', () => {
    const approval: ApprovalResponse = { decision: 'rejected' };
    const result = attachSelectedLabel(
      { outcome: { outcome: 'selected', optionId: 'never-heard-of-it' } },
      approval,
      options,
    );
    expect(result).toEqual({ decision: 'rejected' });
    expect(result.selectedLabel).toBeUndefined();
  });

  it('does not mutate the input approval object', () => {
    const approval: ApprovalResponse = { decision: 'approved' };
    attachSelectedLabel(
      { outcome: { outcome: 'selected', optionId: APPROVE_ONCE_OPTION_ID } },
      approval,
      options,
    );
    expect(approval.selectedLabel).toBeUndefined();
  });
});

describe('AcpSession ↔ requestPermission bridge (selectedLabel end-to-end)', () => {
  it('attaches the matched option name as ApprovalResponse.selectedLabel and forwards a diff entry in toolCall.content', async () => {
    const sessionId = 'sess-approval-display';
    const turnId = 11;
    const handle = makeApprovalSession(sessionId);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => handle.session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const client = new ApprovalDisplayClient();
    client.reply = {
      outcome: { outcome: 'selected', optionId: APPROVE_ALWAYS_OPTION_ID },
    };
    const clientConn = new ClientSideConnection(() => client, clientStream);

    await clientConn.newSession({ cwd: '/tmp/x', mcpServers: [] });

    const pending = clientConn.prompt({
      sessionId,
      prompt: [textBlock('approve me')],
    });
    // Let the agent-side subscribe before we emit events.
    await new Promise((r) => setTimeout(r, 5));

    handle.emit({
      type: 'tool.call.started',
      sessionId,
      agentId: 'main',
      turnId,
      toolCallId: 'edit-1',
      name: 'Edit',
      args: { path: '/tmp/x.ts' },
    } as Event);

    const decision = await handle.invokeHandler({
      toolCallId: 'edit-1',
      toolName: 'Edit',
      action: 'edit file',
      display: {
        kind: 'diff',
        path: '/tmp/x.ts',
        before: 'old',
        after: 'new',
      },
    });

    expect(decision).toEqual({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    });

    expect(client.permissionRequests).toHaveLength(1);
    const req = client.permissionRequests[0]!;
    expect(req.toolCall.toolCallId).toBe(`${turnId}:edit-1`);
    expect(req.toolCall.title).toBe('Edit');
    // Content carries the diff entry first then the action summary.
    expect(req.toolCall.content).toHaveLength(2);
    const [diff, action] = req.toolCall.content as [ToolCallContent, ToolCallContent];
    expect(diff).toEqual({
      type: 'diff',
      path: '/tmp/x.ts',
      oldText: 'old',
      newText: 'new',
    });
    expect(action).toEqual({
      type: 'content',
      content: { type: 'text', text: 'Requesting approval to edit file' },
    });

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
});
