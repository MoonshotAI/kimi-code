import { describe, expect, it } from 'vitest';

import { toDisposable } from '#/_base/di/lifecycle';
import { type IAgentScopeHandle, type ISessionScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { ContentPart } from '#/kosong/contract/message';
import { type IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IWireService } from '#/wire/wire';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionCronService } from '#/session/cron/sessionCronService';

import { MessageLegacyService } from '#/app/messageLegacy/messageLegacyService';

function textMessage(role: ContextMessage['role'], text: string): ContextMessage {
  return { role, content: [{ type: 'text', text }], toolCalls: [] };
}

function buildService(opts: {
  readonly summary: SessionSummary;
  readonly records: readonly Record<string, unknown>[];
  readonly contextMessages: readonly ContextMessage[];
  readonly loadParts?: (parts: readonly ContentPart[]) => Promise<readonly ContentPart[]>;
}): MessageLegacyService {
  const mainHandle = {
    id: MAIN_AGENT_ID,
    kind: LifecycleScope.Agent,
    accessor: {
      get: (token: unknown): unknown => {
        if (token === IWireService) {
          return { flush: async () => {} };
        }
        if (token === IAgentScopeContext) {
          return { scope: () => 'sessions/wd/s1/agents/main' };
        }
        if (token === IAgentContextMemoryService) {
          return { get: () => opts.contextMessages };
        }
        if (token === IAgentBlobService) {
          return {
            loadParts:
              opts.loadParts ??
              ((parts: readonly ContentPart[]) => Promise.resolve(parts)),
          };
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
            create: async () => mainHandle,
            get: (id: string) => (id === MAIN_AGENT_ID ? mainHandle : undefined),
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

  const appendLog: IAppendLogStore = {
    _serviceBrand: undefined,
    append: () => {},
    read: async function* <R>() {
      for (const record of opts.records) yield record as R;
    },
    rewrite: async () => {},
    flush: async () => {},
    close: async () => {},
    acquire: () => toDisposable(() => {}),
  };

  return new MessageLegacyService(lifecycle, index, appendLog);
}

describe('MessageLegacyService', () => {
  const summary: SessionSummary = {
    id: 's1',
    workspaceId: 'wd',
    createdAt: 1_000,
    updatedAt: 1_000,
    archived: false,
  };

  it('reduces the transcript from the streamed append log', async () => {
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

    const page = await svc.list('s1', {});

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

  it('rehydrates blobref media URLs from restored journal records', async () => {
    const blobRefPart = {
      type: 'image_url',
      imageUrl: { url: 'blobref:image/png;deadbeef' },
    } as unknown as ContentPart;
    const hydratedPart = {
      type: 'image_url',
      imageUrl: { url: 'data:image/png;base64,AAAA' },
    } as unknown as ContentPart;
    const svc = buildService({
      summary,
      records: [
        {
          type: 'context.append_message',
          message: { role: 'user', content: [blobRefPart], toolCalls: [] },
        },
      ],
      contextMessages: [],
      loadParts: async (parts) => parts.map((p) => (p === blobRefPart ? hydratedPart : p)),
    });

    const page = await svc.list('s1', {});

    // The restored `blobref:` URL is served inline, the same shape live
    // emissions carry — not as a broken blobref: link.
    expect(page.items[0]?.content[0]).toEqual({
      type: 'image',
      source: { kind: 'url', url: 'data:image/png;base64,AAAA' },
    });
  });

  it('passes media tool results through as raw content parts instead of flattening', async () => {
    const mediaPart = {
      type: 'image_url',
      imageUrl: { url: 'data:image/png;base64,AAAA' },
    } as unknown as ContentPart;
    const svc = buildService({
      summary,
      records: [
        { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'st1' } },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'tool.call',
            stepUuid: 'st1',
            toolCallId: 'call_1',
            name: 'ReadMediaFile',
            args: {},
          },
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'tool.result',
            toolCallId: 'call_1',
            result: { output: [mediaPart], isError: false },
          },
        },
        { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'st1' } },
      ],
      contextMessages: [],
    });

    const page = await svc.list('s1', {});

    const toolMessage = page.items.find((m) => m.role === 'tool');
    expect(toolMessage?.content[0]).toEqual({
      type: 'tool_result',
      tool_call_id: 'call_1',
      output: [mediaPart],
    });
  });

  it('flattens text-only tool results to joined text', async () => {
    const svc = buildService({
      summary,
      records: [
        { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'st1' } },
        {
          type: 'context.append_loop_event',
          event: { type: 'tool.call', stepUuid: 'st1', toolCallId: 'call_1', name: 'Bash' },
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'tool.result',
            toolCallId: 'call_1',
            result: { output: 'command output', isError: false },
          },
        },
        { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'st1' } },
      ],
      contextMessages: [],
    });

    const page = await svc.list('s1', {});

    const toolMessage = page.items.find((m) => m.role === 'tool');
    expect(toolMessage?.content[0]).toEqual({
      type: 'tool_result',
      tool_call_id: 'call_1',
      output: 'command output',
    });
  });

  it('uses wire record times for created_at, nudged to stay strictly increasing', async () => {
    const svc = buildService({
      summary, // createdAt: 1000
      records: [
        { type: 'context.append_message', message: textMessage('user', 'u1'), time: 5000 },
        // Same record time → the second is nudged one ms forward.
        { type: 'context.append_message', message: textMessage('assistant', 'a1'), time: 5000 },
        // No record time → falls back to session createdAt + index, then nudged.
        { type: 'context.append_message', message: textMessage('user', 'u2') },
      ],
      contextMessages: [],
    });

    const page = await svc.list('s1', {});

    // Newest first: u2 (nudged 5002), a1 (nudged 5001), u1 (5000).
    const created = page.items.map((m) => new Date(m.created_at).getTime());
    expect(created).toEqual([5002, 5001, 5000]);
  });
});
