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
});
