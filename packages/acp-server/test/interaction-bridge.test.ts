import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { Interaction } from '@moonshot-ai/agent-core-v2';
import type { SessionHandle } from '@moonshot-ai/klient';
import type { ToolInputDisplay } from '@moonshot-ai/protocol';
import { describe, expect, it } from 'vitest';

import type { AcpClient } from '../src/acp-client';
import { AcpInteractionBridge } from '../src/interaction-bridge';

const SESSION_ID = 'session_test';

const commandDisplay: ToolInputDisplay = {
  kind: 'command',
  command: 'echo hi',
} as unknown as ToolInputDisplay;

interface FakeSession {
  readonly handle: SessionHandle;
  readonly responses: Array<{ id: string; response: unknown }>;
  setPending(pending: readonly Interaction[]): void;
  fire(): void;
}

/**
 * Fake the klient session surface the bridge consumes:
 * `events.on('interactions.changed')` + `interactions.list()` / `respond()`.
 */
function makeFakeSession(): FakeSession {
  let listener: ((pending: readonly Interaction[]) => void) | undefined;
  let pending: readonly Interaction[] = [];
  const responses: Array<{ id: string; response: unknown }> = [];
  const handle = {
    events: {
      on: (_event: string, l: (payload: readonly Interaction[]) => void) => {
        listener = l;
        return {
          dispose: () => {
            listener = undefined;
          },
        };
      },
      onError: () => ({ dispose: () => {} }),
    },
    interactions: {
      list: () => Promise.resolve(pending),
      respond: (id: string, response: unknown) => {
        responses.push({ id, response });
        return Promise.resolve();
      },
    },
  } as unknown as SessionHandle;
  return {
    handle,
    responses,
    setPending: (p) => {
      pending = p;
    },
    fire: () => listener?.(pending),
  };
}

interface FakeConn {
  readonly conn: AcpClient;
  readonly calls: Array<Record<string, unknown>>;
}

function makeFakeConn(
  handler: (params: Record<string, unknown>) => RequestPermissionResponse,
): FakeConn {
  const calls: Array<Record<string, unknown>> = [];
  const conn = {
    requestPermission: async (params: Record<string, unknown>) => {
      calls.push(params);
      return handler(params);
    },
  } as unknown as AcpClient;
  return { conn, calls };
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
    const session = makeFakeSession();
    const { conn, calls } = makeFakeConn(() => ({
      outcome: { outcome: 'selected', optionId: 'approve_once' },
    }));
    session.setPending([approvalInteraction]);
    const bridge = new AcpInteractionBridge(conn, session.handle, SESSION_ID);
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sessionId: SESSION_ID,
      toolCall: { toolCallId: '3:call_1', title: 'Bash' },
    });
    expect(session.responses).toEqual([
      { id: 'approval-1', response: { decision: 'approved', selectedLabel: 'Approve once' } },
    ]);
    bridge.dispose();
  });

  it('maps approve_always to a session-scoped approval', async () => {
    const session = makeFakeSession();
    const { conn } = makeFakeConn(() => ({
      outcome: { outcome: 'selected', optionId: 'approve_always' },
    }));
    session.setPending([approvalInteraction]);
    const bridge = new AcpInteractionBridge(conn, session.handle, SESSION_ID);
    await flush();

    expect(session.responses[0]?.response).toEqual({
      decision: 'approved',
      scope: 'session',
      selectedLabel: 'Approve for this session',
    });
    bridge.dispose();
  });

  it('responds rejected when the client RPC fails', async () => {
    const session = makeFakeSession();
    const conn = {
      requestPermission: async () => {
        throw new Error('transport dropped');
      },
    } as unknown as AcpClient;
    session.setPending([approvalInteraction]);
    const bridge = new AcpInteractionBridge(conn, session.handle, SESSION_ID);
    await flush();

    expect(session.responses).toEqual([{ id: 'approval-1', response: { decision: 'rejected' } }]);
    bridge.dispose();
  });

  it('bridges a plan review interaction and preserves the selected plan label', async () => {
    const session = makeFakeSession();
    const { conn, calls } = makeFakeConn(() => ({
      outcome: { outcome: 'selected', optionId: 'plan_opt_1' },
    }));
    const planInteraction: Interaction = {
      id: 'plan-1',
      kind: 'approval',
      payload: {
        toolName: 'ExitPlanMode',
        action: 'review the plan',
        toolCallId: 'plan-call',
        turnId: 7,
        display: {
          kind: 'plan_review',
          plan: 'step one',
          options: [{ label: 'Fast path' }, { label: 'Safe path' }],
        },
      },
      origin: { turnId: 7 },
      createdAt: 0,
    };
    session.setPending([planInteraction]);
    const bridge = new AcpInteractionBridge(conn, session.handle, SESSION_ID);
    await flush();

    expect(calls[0]?.['options']).toEqual([
      expect.objectContaining({ optionId: 'plan_opt_0', name: 'Fast path' }),
      expect.objectContaining({ optionId: 'plan_opt_1', name: 'Safe path' }),
      expect.objectContaining({ optionId: 'plan_revise' }),
      expect.objectContaining({ optionId: 'plan_reject_and_exit' }),
    ]);
    expect(session.responses).toEqual([
      { id: 'plan-1', response: { decision: 'approved', selectedLabel: 'Safe path' } },
    ]);
    bridge.dispose();
  });

  it('forwards a question request and responds with the answer', async () => {
    const session = makeFakeSession();
    const { conn, calls } = makeFakeConn(() => ({
      outcome: { outcome: 'selected', optionId: 'q0_opt_0' },
    }));
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
    session.setPending([questionInteraction]);
    const bridge = new AcpInteractionBridge(conn, session.handle, SESSION_ID);
    await flush();

    expect(calls[0]).toMatchObject({
      toolCall: { toolCallId: '5:tc_q', title: 'AskUserQuestion' },
    });
    expect(session.responses).toEqual([{ id: 'question-1', response: { 'Pick one': 'A' } }]);
    bridge.dispose();
  });

  it('ignores non-approval/question interactions', async () => {
    const session = makeFakeSession();
    const { conn, calls } = makeFakeConn(() => ({ outcome: { outcome: 'cancelled' } }));
    const userToolInteraction: Interaction = {
      id: 'ut-1',
      kind: 'user_tool',
      payload: {},
      origin: {},
      createdAt: 0,
    };
    session.setPending([userToolInteraction]);
    const bridge = new AcpInteractionBridge(conn, session.handle, SESSION_ID);
    await flush();

    expect(calls).toHaveLength(0);
    expect(session.responses).toEqual([]);
    bridge.dispose();
  });

  it('does not double-handle the same pending id across change events', async () => {
    const session = makeFakeSession();
    const { conn, calls } = makeFakeConn(() => ({
      outcome: { outcome: 'selected', optionId: 'approve_once' },
    }));
    session.setPending([approvalInteraction]);
    const bridge = new AcpInteractionBridge(conn, session.handle, SESSION_ID);
    session.fire();
    session.fire();
    await flush();

    expect(calls).toHaveLength(1);
    bridge.dispose();
  });

  it('settles an approval exactly once when the client answers after cancellation', async () => {
    const session = makeFakeSession();
    let resolvePermission!: (response: RequestPermissionResponse) => void;
    const calls: unknown[] = [];
    const conn = {
      requestPermission: (params: unknown) => {
        calls.push(params);
        return new Promise<RequestPermissionResponse>((resolve) => {
          resolvePermission = resolve;
        });
      },
    } as unknown as AcpClient;
    session.setPending([approvalInteraction]);
    const bridge = new AcpInteractionBridge(conn, session.handle, SESSION_ID);
    await flush();

    session.setPending([]);
    session.fire();
    resolvePermission({ outcome: { outcome: 'selected', optionId: 'approve_once' } });
    await flush();

    expect(calls).toHaveLength(1);
    expect(session.responses).toEqual([
      { id: 'approval-1', response: { decision: 'approved', selectedLabel: 'Approve once' } },
    ]);
    bridge.dispose();
  });

  const questionInteraction: Interaction = {
    id: 'question-el-1',
    kind: 'question',
    payload: {
      toolCallId: 'tc_q',
      turnId: 5,
      questions: [
        { question: 'Pick one', header: 'One', options: [{ label: 'A' }, { label: 'B' }] },
        {
          question: 'Pick many',
          options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }],
          multiSelect: true,
        },
      ],
    },
    origin: { turnId: 5 },
    createdAt: 0,
  };

  it('routes questions through elicitation/create when the client supports form mode', async () => {
    const session = makeFakeSession();
    const elicitationCalls: Array<Record<string, unknown>> = [];
    const { conn, calls: permissionCalls } = makeFakeConn(() => ({
      outcome: { outcome: 'cancelled' },
    }));
    (conn as { createElicitation?: unknown }).createElicitation = async (
      params: Record<string, unknown>,
    ) => {
      elicitationCalls.push(params);
      return { action: 'accept', content: { q0: 'B', q1: ['Z', 'X'] } };
    };
    session.setPending([questionInteraction]);
    const bridge = new AcpInteractionBridge(conn, session.handle, SESSION_ID, true);
    await flush();

    expect(permissionCalls).toHaveLength(0);
    expect(elicitationCalls).toHaveLength(1);
    expect(elicitationCalls[0]).toMatchObject({
      sessionId: SESSION_ID,
      toolCallId: '5:tc_q',
      mode: 'form',
      requestedSchema: {
        required: ['q0', 'q1'],
        properties: {
          q0: { type: 'string', title: 'One' },
          q1: { type: 'array', minItems: 1 },
        },
      },
    });
    // Answers key by question text; multi-select joins in declared option order.
    expect(session.responses).toEqual([
      { id: 'question-el-1', response: { 'Pick one': 'B', 'Pick many': 'X, Z' } },
    ]);
    bridge.dispose();
  });

  it('responds null (dismissed) when the elicitation is declined', async () => {
    const session = makeFakeSession();
    const { conn } = makeFakeConn(() => ({ outcome: { outcome: 'cancelled' } }));
    (conn as { createElicitation?: unknown }).createElicitation = async () => ({
      action: 'decline',
    });
    session.setPending([questionInteraction]);
    const bridge = new AcpInteractionBridge(conn, session.handle, SESSION_ID, true);
    await flush();

    expect(session.responses).toEqual([{ id: 'question-el-1', response: null }]);
    bridge.dispose();
  });

  it('falls back to request_permission when elicitation/create fails', async () => {
    const session = makeFakeSession();
    const { conn, calls: permissionCalls } = makeFakeConn(() => ({
      outcome: { outcome: 'selected', optionId: 'q0_opt_1' },
    }));
    (conn as { createElicitation?: unknown }).createElicitation = async () => {
      throw new Error('method not found');
    };
    session.setPending([questionInteraction]);
    const bridge = new AcpInteractionBridge(conn, session.handle, SESSION_ID, true);
    await flush();

    // The permission bridge degrades to the first question, single-select.
    expect(permissionCalls).toHaveLength(1);
    expect(permissionCalls[0]).toMatchObject({
      toolCall: { toolCallId: '5:tc_q', title: 'AskUserQuestion' },
    });
    expect(session.responses).toEqual([{ id: 'question-el-1', response: { 'Pick one': 'B' } }]);
    bridge.dispose();
  });
});
