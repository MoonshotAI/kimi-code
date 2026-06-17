/**
 * `MessageService` (Chain 3 / P1.3, W7.1) unit tests.
 *
 * Hermetic: a fake `ICoreProcessService` returns canned `SessionSummary[]` from
 * `listSessions` and a canned `AgentContextData.history` from `getContext`.
 *
 * Coverage:
 *   - list pagination (default/before_id/after_id/page_size; has_more)
 *   - role filter
 *   - kosong ContentPart → SCHEMAS MessageContent adapter (text / think /
 *     image_url / audio_url / video_url)
 *   - assistant message with toolCalls → tool_use content parts appended
 *   - tool role message → tool_result single content part with output text
 *   - tool message with isError=true → tool_result.is_error: true
 *   - get(sid, mid) round-trip + MessageNotFoundError on invalid id
 *   - SessionNotFoundError on unknown sid
 *   - deriveMessageId / parseMessageId round-trip
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentContextData,
  ContextMessage,
  CoreRPC,
  SessionSummary,
} from '../../src';

import {
  type ICoreProcessService,
  MessageNotFoundError,
  MessageService,
  SessionNotFoundError,
  deriveMessageId,
  parseMessageId,
  toProtocolMessage,
} from '../../src/services';

const SESSION_ID = 'sess_01HZTEST';
const SESSION_CREATED_AT = 1_700_000_000_000;

function makeFakeBridge(
  sessions: SessionSummary[],
  history: ContextMessage[],
): ICoreProcessService {
  const rpc: Partial<CoreRPC> = {
    listSessions: vi.fn().mockImplementation(async () => sessions),
    resumeSession: vi.fn().mockResolvedValue(undefined as unknown as never),
    getContext: vi.fn().mockImplementation(async (): Promise<AgentContextData> => {
      return { history, tokenCount: 0 };
    }),
  };
  return {
    rpc: rpc as CoreRPC,
    ready: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    _serviceBrand: undefined,
  };
}

function mkSummary(id = SESSION_ID): SessionSummary {
  return {
    id,
    workDir: '/tmp/ws',
    sessionDir: `/tmp/sessions/${id}`,
    createdAt: SESSION_CREATED_AT,
    updatedAt: SESSION_CREATED_AT,
  };
}

function mkUserMessage(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
  } as ContextMessage;
}

function mkAssistantMessage(text: string, toolCalls: ContextMessage['toolCalls'] = []): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    toolCalls,
  } as ContextMessage;
}

describe('deriveMessageId / parseMessageId', () => {
  it('round-trips a derived id', () => {
    const id = deriveMessageId('sess_01HABC', 3);
    expect(id).toBe('msg_sess_01HABC_000003');
    expect(parseMessageId(id)).toEqual({ sessionId: 'sess_01HABC', index: 3 });
  });

  it('parses preserves the full session id including underscores', () => {
    const id = deriveMessageId('sess_with_under_score', 12);
    expect(parseMessageId(id)).toEqual({
      sessionId: 'sess_with_under_score',
      index: 12,
    });
  });

  it('returns undefined for malformed ids', () => {
    expect(parseMessageId('not_a_message_id')).toBeUndefined();
    expect(parseMessageId('msg_no_index_here_')).toBeUndefined();
    expect(parseMessageId('msg_sess_-1')).toBeUndefined();
  });
});

describe('toProtocolMessage content adapter', () => {
  it('maps text content', () => {
    const m = mkUserMessage('hello');
    const out = toProtocolMessage(SESSION_ID, 0, m, SESSION_CREATED_AT);
    expect(out.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(out.created_at).toBe(new Date(SESSION_CREATED_AT).toISOString());
  });

  it('maps think → thinking with optional signature', () => {
    const m: ContextMessage = {
      role: 'assistant',
      content: [{ type: 'think', think: 'I am thinking', encrypted: 'sig' }],
      toolCalls: [],
    } as ContextMessage;
    const out = toProtocolMessage(SESSION_ID, 1, m, SESSION_CREATED_AT);
    expect(out.content[0]).toEqual({
      type: 'thinking',
      thinking: 'I am thinking',
      signature: 'sig',
    });
  });

  it('maps image_url → image source kind=url', () => {
    const m: ContextMessage = {
      role: 'user',
      content: [{ type: 'image_url', imageUrl: { url: 'https://a.png' } }],
      toolCalls: [],
    } as ContextMessage;
    const out = toProtocolMessage(SESSION_ID, 0, m, SESSION_CREATED_AT);
    expect(out.content[0]).toEqual({
      type: 'image',
      source: { kind: 'url', url: 'https://a.png' },
    });
  });

  it('flattens audio_url and video_url to text markers', () => {
    const m: ContextMessage = {
      role: 'user',
      content: [
        { type: 'audio_url', audioUrl: { url: 'https://a.mp3' } },
        { type: 'video_url', videoUrl: { url: 'https://a.mp4' } },
      ],
      toolCalls: [],
    } as ContextMessage;
    const out = toProtocolMessage(SESSION_ID, 0, m, SESSION_CREATED_AT);
    expect(out.content).toEqual([
      { type: 'text', text: '[audio:https://a.mp3]' },
      { type: 'text', text: '[video:https://a.mp4]' },
    ]);
  });

  it('appends tool_use content parts for assistant toolCalls', () => {
    const m: ContextMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'using tool' }],
      toolCalls: [
        {
          type: 'function',
          id: 'call_1',
          name: 'Bash',
          arguments: '{"command":"ls"}',
        },
      ],
    } as ContextMessage;
    const out = toProtocolMessage(SESSION_ID, 2, m, SESSION_CREATED_AT);
    expect(out.content).toHaveLength(2);
    expect(out.content[1]).toEqual({
      type: 'tool_use',
      tool_call_id: 'call_1',
      tool_name: 'Bash',
      input: { command: 'ls' },
    });
  });

  it('treats tool-role messages as a single tool_result content part', () => {
    const m: ContextMessage = {
      role: 'tool',
      content: [{ type: 'text', text: 'output' }],
      toolCalls: [],
      toolCallId: 'call_1',
    } as ContextMessage;
    const out = toProtocolMessage(SESSION_ID, 3, m, SESSION_CREATED_AT);
    expect(out.role).toBe('tool');
    expect(out.content).toEqual([
      { type: 'tool_result', tool_call_id: 'call_1', output: 'output' },
    ]);
  });

  it('marks isError=true tool messages with is_error: true', () => {
    const m: ContextMessage = {
      role: 'tool',
      content: [{ type: 'text', text: 'fail' }],
      toolCalls: [],
      toolCallId: 'call_1',
      isError: true,
    } as ContextMessage;
    const out = toProtocolMessage(SESSION_ID, 4, m, SESSION_CREATED_AT);
    expect(out.content[0]).toMatchObject({
      type: 'tool_result',
      tool_call_id: 'call_1',
      is_error: true,
    });
  });
});

describe('MessageService', () => {
  let impl: MessageService;
  let bridge: ICoreProcessService;

  beforeEach(() => {
    bridge = makeFakeBridge(
      [mkSummary()],
      [
        mkUserMessage('one'),
        mkAssistantMessage('two'),
        mkUserMessage('three'),
        mkAssistantMessage('four'),
        mkUserMessage('five'),
      ],
    );
    impl = new MessageService(bridge);
  });

  afterEach(() => {
    impl.dispose();
  });

  it('list defaults: returns history in desc order (newest first)', async () => {
    const page = await impl.list(SESSION_ID, {});
    expect(page.items.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'five',
      'four',
      'three',
      'two',
      'one',
    ]);
    expect(page.has_more).toBe(false);
  });

  it('list page_size = 2 returns first 2 newest + has_more=true', async () => {
    const page = await impl.list(SESSION_ID, { page_size: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.has_more).toBe(true);
  });

  it('list before_id returns OLDER entries', async () => {
    // before_id = third-newest entry, which is "three" (index 2 in history)
    const id = deriveMessageId(SESSION_ID, 2);
    const page = await impl.list(SESSION_ID, { before_id: id, page_size: 10 });
    expect(page.items.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'two',
      'one',
    ]);
    expect(page.has_more).toBe(false);
  });

  it('list after_id returns NEWER entries', async () => {
    // after_id = third-newest entry "three"
    const id = deriveMessageId(SESSION_ID, 2);
    const page = await impl.list(SESSION_ID, { after_id: id, page_size: 10 });
    expect(page.items.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'five',
      'four',
    ]);
    expect(page.has_more).toBe(false);
  });

  it('list filters by role AFTER pagination', async () => {
    const page = await impl.list(SESSION_ID, { role: 'user' });
    expect(page.items.every((m) => m.role === 'user')).toBe(true);
  });

  it('list throws SessionNotFoundError for unknown sid', async () => {
    await expect(impl.list('sess_missing', {})).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it('get returns the right message', async () => {
    // index 0 = "one", id of which is deriveMessageId(SESSION_ID, 0)
    const id = deriveMessageId(SESSION_ID, 0);
    const m = await impl.get(SESSION_ID, id);
    expect(m.id).toBe(id);
    expect((m.content[0] as { text: string }).text).toBe('one');
  });

  it('get throws MessageNotFoundError for an id that points to a missing index', async () => {
    const fake = deriveMessageId(SESSION_ID, 999);
    await expect(impl.get(SESSION_ID, fake)).rejects.toBeInstanceOf(
      MessageNotFoundError,
    );
  });

  it('get throws MessageNotFoundError for a malformed id', async () => {
    await expect(impl.get(SESSION_ID, 'msg_garbage')).rejects.toBeInstanceOf(
      MessageNotFoundError,
    );
  });

  it('get throws MessageNotFoundError when mid points at a DIFFERENT session', async () => {
    const otherSessionId = deriveMessageId('sess_other', 0);
    await expect(impl.get(SESSION_ID, otherSessionId)).rejects.toBeInstanceOf(
      MessageNotFoundError,
    );
  });

  it('get throws SessionNotFoundError for unknown sid', async () => {
    const id = deriveMessageId('sess_unknown', 0);
    await expect(impl.get('sess_unknown', id)).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it('page_size 0 falls back to safety minimum 1', async () => {
    // The route layer is supposed to reject page_size=0 via 40001; if it
    // somehow reaches the impl (e.g. internal call) we clamp to 1 rather
    // than divide-by-zero or return nothing for an empty page.
    const page = await impl.list(SESSION_ID, { page_size: 0 });
    expect(page.items).toHaveLength(1);
  });

  it('list calls resumeSession before getContext so cross-restart sessions resolve', async () => {
    await impl.list(SESSION_ID, {});
    const resumeMock = bridge.rpc.resumeSession as ReturnType<typeof vi.fn>;
    const getContextMock = bridge.rpc.getContext as ReturnType<typeof vi.fn>;
    expect(resumeMock).toHaveBeenCalledWith({ sessionId: SESSION_ID });
    const resumeOrder = resumeMock.mock.invocationCallOrder[0];
    const getContextOrder = getContextMock.mock.invocationCallOrder[0];
    expect(resumeOrder).toBeDefined();
    expect(getContextOrder).toBeDefined();
    expect(resumeOrder!).toBeLessThan(getContextOrder!);
  });

  it('maps resumeSession failure to SessionNotFoundError (wire-compat 40401)', async () => {
    const sessions = [mkSummary()];
    const rpc: Partial<CoreRPC> = {
      listSessions: vi.fn().mockResolvedValue(sessions),
      resumeSession: vi.fn().mockRejectedValue(new Error('state.json corrupted')),
      getContext: vi.fn(),
    };
    const failingBridge: ICoreProcessService = {
      rpc: rpc as CoreRPC,
      ready: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      _serviceBrand: undefined,
    };
    const failingImpl = new MessageService(failingBridge);
    await expect(failingImpl.list(SESSION_ID, {})).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
    failingImpl.dispose();
  });
});
