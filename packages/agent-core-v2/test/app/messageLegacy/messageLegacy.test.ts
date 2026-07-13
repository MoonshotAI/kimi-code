import { describe, expect, it } from 'vitest';

import { type IAgentScopeHandle, type ISessionScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentWireRecordService } from '#/agent/wireRecord/wireRecord';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/mainAgent';
import { ISessionCronService } from '#/session/cron/sessionCronService';

import { MessageLegacyService } from '#/app/messageLegacy/messageLegacyService';

function textMessage(role: ContextMessage['role'], text: string): ContextMessage {
  return { role, content: [{ type: 'text', text }], toolCalls: [] };
}

function buildService(opts: {
  readonly summary: SessionSummary;
  readonly records: readonly Record<string, unknown>[];
  readonly contextMessages: readonly ContextMessage[];
}): MessageLegacyService {
  const mainHandle = {
    id: MAIN_AGENT_ID,
    kind: LifecycleScope.Agent,
    accessor: {
      get: (token: unknown): unknown => {
        if (token === IAgentWireRecordService) {
          return { getRecords: () => opts.records };
        }
        if (token === IAgentContextMemoryService) {
          return { get: () => opts.contextMessages };
        }
        throw new Error('unexpected main agent service access');
      },
    },
    dispose: () => {},
  } as unknown as IAgentScopeHandle;

  const sessionHandle = {
    id: opts.summary.id,
    kind: LifecycleScope.Session,
    accessor: {
      get: (token: unknown): unknown => {
        if (token === IAgentLifecycleService) {
          return {
            getHandle: (id: string) => (id === MAIN_AGENT_ID ? mainHandle : undefined),
            whenReady: (id: string) => Promise.resolve(id === MAIN_AGENT_ID ? mainHandle : undefined),
          };
        }
        if (token === ISessionCronService) return {};
        throw new Error('unexpected session service access');
      },
    },
    dispose: () => {},
  } as unknown as ISessionScopeHandle;

  const lifecycle = {
    resume: (sessionId: string) =>
      Promise.resolve(sessionId === opts.summary.id ? sessionHandle : undefined),
  } as unknown as ISessionLifecycleService;

  const index = {
    get: (sessionId: string) => Promise.resolve(sessionId === opts.summary.id ? opts.summary : undefined),
  } as unknown as ISessionIndex;

  return new MessageLegacyService(lifecycle, index);
}

describe('MessageLegacyService', () => {
  const summary: SessionSummary = {
    id: 's1',
    workspaceId: 'wd',
    createdAt: 1_000,
    updatedAt: 1_000,
    archived: false,
  };

  it('reduces the transcript from the in-memory record journal (no disk read)', async () => {
    const user = textMessage('user', 'hi');
    const assistant = textMessage('assistant', 'hello');
    const svc = buildService({
      summary,
      records: [
        { type: 'context.append_message', message: user },
        { type: 'context.append_message', message: assistant },
      ],
      // Folded context length matches the journal-derived foldedLength, so the
      // live-tail merge is a no-op and the output is purely the journal.
      contextMessages: [user, assistant],
    });

    const page = await svc.list('s1', {});

    // Newest first; both entries come from the journal, not from wire.jsonl.
    expect(page.items.map((m) => m.role)).toEqual(['assistant', 'user']);
    expect(page.items[1]?.content[0]).toEqual({ type: 'text', text: 'hi' });
    expect(page.has_more).toBe(false);
  });

  it('throws session.not_found for an unknown session id', async () => {
    const svc = buildService({ summary, records: [], contextMessages: [] });
    await expect(svc.list('missing', {})).rejects.toMatchObject({ code: 'session.not_found' });
  });

  it('resolves a single message by derived id', async () => {
    const user = textMessage('user', 'hi');
    const assistant = textMessage('assistant', 'hello');
    const svc = buildService({
      summary,
      records: [
        { type: 'context.append_message', message: user },
        { type: 'context.append_message', message: assistant },
      ],
      contextMessages: [user, assistant],
    });

    const message = await svc.get('s1', 'msg_s1_000001');

    expect(message.role).toBe('assistant');
    expect(message.content[0]).toEqual({ type: 'text', text: 'hello' });
  });
});
