import { describe, expect, it } from 'vitest';

import { AcpInteractionBridge } from '../src/interaction-bridge';

import type { AgentSideConnection, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import {
  type Interaction,
  type ISessionInteractionService,
  type ISessionScopeHandle,
  ISessionInteractionService as ISessionInteractionServiceId,
} from '@moonshot-ai/agent-core-v2';
import type { ToolInputDisplay } from '@moonshot-ai/protocol';

const SESSION_ID = 'session_test';

const commandDisplay: ToolInputDisplay = {
  kind: 'command',
  command: 'echo hi',
} as unknown as ToolInputDisplay;

interface FakeInteraction {
  readonly svc: ISessionInteractionService;
  readonly responses: Array<{ id: string; response: unknown }>;
  setPending(pending: readonly Interaction[]): void;
  fire(): void;
}

function makeFakeInteraction(): FakeInteraction {
  let listener: (() => void) | undefined;
  let pending: readonly Interaction[] = [];
  const responses: Array<{ id: string; response: unknown }> = [];
  const svc = {
    onDidChangePending: (l: () => void) => {
      listener = l;
      return { dispose: () => { listener = undefined; } };
    },
    listPending: () => pending,
    respond: (id: string, response: unknown) => {
      responses.push({ id, response });
    },
    // Unused interface members stubbed for completeness.
    request: () => Promise.resolve(undefined),
    enqueue: () => ({ id: '', kind: 'approval', payload: undefined, origin: {}, createdAt: 0 }),
    isRecentlyResolved: () => false,
    onDidResolve: () => ({ dispose: () => {} }),
  } as unknown as ISessionInteractionService;
  return {
    svc,
    responses,
    setPending: (p) => { pending = p; },
    fire: () => listener?.(),
  };
}

interface FakeConn {
  readonly conn: AgentSideConnection;
  readonly calls: Array<Record<string, unknown>>;
}

function makeFakeConn(handler: (params: Record<string, unknown>) => RequestPermissionResponse): FakeConn {
  const calls: Array<Record<string, unknown>> = [];
  const conn = {
    requestPermission: async (params: Record<string, unknown>) => {
      calls.push(params);
      return handler(params);
    },
  } as unknown as AgentSideConnection;
  return { conn, calls };
}

function makeSessionHandle(svc: ISessionInteractionService): ISessionScopeHandle {
  return {
    accessor: {
      get: (id: unknown) => {
        if (id === ISessionInteractionServiceId) return svc;
        throw new Error(`unexpected service request: ${String(id)}`);
      },
    },
  } as unknown as ISessionScopeHandle;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const approvalInteraction: Interaction = {
  id: 'approval-1',
  kind: 'approval',
  payload: {
    toolName: 'Bash',
    action: 'run `echo hi`',
    toolCallId: 'call_1',
    turnId: 3,
    display: commandDisplay,
  },
  origin: { turnId: 3 },
  createdAt: 0,
};

describe('AcpInteractionBridge', () => {
  it('forwards an approval request to the client and responds with the decision', async () => {
    const interaction = makeFakeInteraction();
    const { conn, calls } = makeFakeConn(() => ({ outcome: { outcome: 'selected', optionId: 'approve_once' } }));
    interaction.setPending([approvalInteraction]);
    const bridge = new AcpInteractionBridge(conn, makeSessionHandle(interaction.svc), SESSION_ID);
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sessionId: SESSION_ID,
      toolCall: { toolCallId: '3:call_1', title: 'Bash' },
    });
    expect(interaction.responses).toEqual([{ id: 'approval-1', response: { decision: 'approved', selectedLabel: 'Approve once' } }]);
    bridge.dispose();
  });

  it('maps approve_always to a session-scoped approval', async () => {
    const interaction = makeFakeInteraction();
    const { conn } = makeFakeConn(() => ({ outcome: { outcome: 'selected', optionId: 'approve_always' } }));
    interaction.setPending([approvalInteraction]);
    const bridge = new AcpInteractionBridge(conn, makeSessionHandle(interaction.svc), SESSION_ID);
    await flush();

    expect(interaction.responses[0]?.response).toEqual({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    });
    bridge.dispose();
  });

  it('responds rejected when the client RPC fails', async () => {
    const interaction = makeFakeInteraction();
    const conn = {
      requestPermission: async () => { throw new Error('transport dropped'); },
    } as unknown as AgentSideConnection;
    interaction.setPending([approvalInteraction]);
    const bridge = new AcpInteractionBridge(conn, makeSessionHandle(interaction.svc), SESSION_ID);
    await flush();

    expect(interaction.responses).toEqual([{ id: 'approval-1', response: { decision: 'rejected' } }]);
    bridge.dispose();
  });

  it('forwards a question request and responds with the answer', async () => {
    const interaction = makeFakeInteraction();
    const { conn, calls } = makeFakeConn(() => ({ outcome: { outcome: 'selected', optionId: 'q0_opt_0' } }));
    const questionInteraction: Interaction = {
      id: 'question-1',
      kind: 'question',
      payload: {
        toolCallId: 'tc_q',
        turnId: 5,
        questions: [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }],
      },
      origin: { turnId: 5 },
      createdAt: 0,
    };
    interaction.setPending([questionInteraction]);
    const bridge = new AcpInteractionBridge(conn, makeSessionHandle(interaction.svc), SESSION_ID);
    await flush();

    expect(calls[0]).toMatchObject({ toolCall: { toolCallId: '5:tc_q', title: 'AskUserQuestion' } });
    expect(interaction.responses).toEqual([{ id: 'question-1', response: { 'Pick one': 'A' } }]);
    bridge.dispose();
  });

  it('ignores non-approval/question interactions', async () => {
    const interaction = makeFakeInteraction();
    const { conn, calls } = makeFakeConn(() => ({ outcome: { outcome: 'cancelled' } }));
    const userToolInteraction: Interaction = {
      id: 'ut-1',
      kind: 'user_tool',
      payload: {},
      origin: {},
      createdAt: 0,
    };
    interaction.setPending([userToolInteraction]);
    const bridge = new AcpInteractionBridge(conn, makeSessionHandle(interaction.svc), SESSION_ID);
    await flush();

    expect(calls).toHaveLength(0);
    expect(interaction.responses).toEqual([]);
    bridge.dispose();
  });

  it('does not double-handle the same pending id across change events', async () => {
    const interaction = makeFakeInteraction();
    const { conn, calls } = makeFakeConn(() => ({ outcome: { outcome: 'selected', optionId: 'approve_once' } }));
    interaction.setPending([approvalInteraction]);
    const bridge = new AcpInteractionBridge(conn, makeSessionHandle(interaction.svc), SESSION_ID);
    interaction.fire();
    interaction.fire();
    await flush();

    expect(calls).toHaveLength(1);
    bridge.dispose();
  });
});
