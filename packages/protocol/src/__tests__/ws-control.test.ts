import { describe, expect, it } from 'vitest';

import {
  abortMessageSchema,
  abortAckMessageSchema,
  clientControlMessageSchema,
  clientControlOperations,
  clientHelloMessageSchema,
  clientHelloAckMessageSchema,
  getClientControlOperation,
  pingMessageSchema,
  pongMessageSchema,
  resyncRequiredMessageSchema,
  serverHelloMessageSchema,
  serverSystemOperations,
  serverSystemMessageSchema,
  sessionEventMessageSchema,
  subscribeAckMessageSchema,
  subscribeMessageSchema,
  terminalAttachAckMessageSchema,
  terminalAttachMessageSchema,
  terminalCloseAckMessageSchema,
  terminalCloseMessageSchema,
  terminalDetachAckMessageSchema,
  terminalDetachMessageSchema,
  terminalInputAckMessageSchema,
  terminalInputMessageSchema,
  terminalResizeAckMessageSchema,
  terminalResizeMessageSchema,
  terminalOutputMessageSchema,
  terminalExitMessageSchema,
  unsubscribeAckMessageSchema,
  unsubscribeMessageSchema,
  watchFsAckMessageSchema,
  watchFsAddMessageSchema,
  watchFsRemoveMessageSchema,
  wsOperations,
  wsAckEnvelopeSchema,
  wsControlEnvelopeSchema,
  wsErrorMessageSchema,
  wsEventEnvelopeSchema,
} from '../ws-control';
import { createAsyncApiDocument } from '../asyncapi';
import { z } from 'zod';

const TS = '2026-06-04T10:30:00.000Z';

describe('ws-control — generic envelopes', () => {
  it('wsEventEnvelopeSchema accepts a session event frame', () => {
    const schema = wsEventEnvelopeSchema(z.object({ delta: z.string() }));
    const parsed = schema.parse({
      type: 'event.assistant.delta',
      seq: 42,
      session_id: 'sess_1',
      timestamp: TS,
      payload: { delta: 'hi' },
    });
    expect(parsed.seq).toBe(42);
  });

  it('wsEventEnvelopeSchema accepts a volatile frame carrying the watermark', () => {
    const schema = wsEventEnvelopeSchema(z.object({ delta: z.string() }));
    const parsed = schema.parse({
      type: 'assistant.delta',
      seq: 42,
      epoch: 'ep_01ABC',
      volatile: true,
      session_id: 'sess_1',
      timestamp: TS,
      payload: { delta: 'hi' },
    });
    expect(parsed.volatile).toBe(true);
    expect(parsed.epoch).toBe('ep_01ABC');
  });

  it('wsControlEnvelopeSchema accepts an id-less message', () => {
    const schema = wsControlEnvelopeSchema(z.object({}));
    expect(schema.safeParse({ type: 'pong', payload: {} }).success).toBe(true);
  });

  it('wsAckEnvelopeSchema requires type=ack and an id', () => {
    const schema = wsAckEnvelopeSchema(z.object({}));
    expect(
      schema.safeParse({ type: 'ack', id: 'c1', code: 0, msg: 'success', payload: {} }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ type: 'not_ack', id: 'c1', code: 0, msg: 'success', payload: {} }).success,
    ).toBe(false);
    expect(schema.safeParse({ type: 'ack', code: 0, msg: 'x', payload: {} }).success).toBe(false);
  });
});

describe('ws-control — AsyncAPI document', () => {
  it('generates an AsyncAPI document for the daemon WebSocket protocol', () => {
    const doc = createAsyncApiDocument({
      version: '1.2.3',
      serverHost: '127.0.0.1:14567',
      wsPath: '/api/v1/ws',
    });

    expect(doc['asyncapi']).toBe('3.1.0');
    expect(doc['defaultContentType']).toBe('application/json');
    expect(doc['info']).toMatchObject({
      title: 'Kimi Code WebSocket API',
      version: '1.2.3',
    });

    const servers = doc['servers'] as Record<string, unknown>;
    expect(servers['local']).toMatchObject({
      host: '127.0.0.1:14567',
      protocol: 'ws',
      pathname: '/api/v1/ws',
    });

    const channels = doc['channels'] as Record<string, unknown>;
    const wsChannel = channels['kimiCodeWebSocket'] as {
      address: string;
      messages: Record<string, { $ref: string }>;
    };
    expect(wsChannel.address).toBe('/api/v1/ws');
    expect(wsChannel.messages['client_hello']).toEqual({
      $ref: '#/components/messages/client_hello',
    });
    expect(wsChannel.messages['session_event']).toEqual({
      $ref: '#/components/messages/session_event',
    });
    expect(wsChannel.messages['subscribe_ack']).toEqual({
      $ref: '#/components/messages/subscribe_ack',
    });

    const operations = doc['operations'] as Record<string, unknown>;
    expect(operations['receiveClientMessages']).toMatchObject({
      action: 'receive',
      channel: { $ref: '#/channels/kimiCodeWebSocket' },
    });
    expect(operations['sendServerMessages']).toMatchObject({
      action: 'send',
      channel: { $ref: '#/channels/kimiCodeWebSocket' },
    });

    const components = doc['components'] as { messages: Record<string, unknown> };
    expect(components.messages['client_hello']).toMatchObject({
      name: 'client_hello',
      payload: expect.objectContaining({
        type: 'object',
      }),
    });
    expect(components.messages['session_event']).toMatchObject({
      name: 'session_event',
      payload: expect.objectContaining({
        type: 'object',
      }),
    });
  });
});

describe('ws-control — §3.1 server_hello', () => {
  it('parses a canonical server_hello frame', () => {
    const result = serverHelloMessageSchema.safeParse({
      type: 'server_hello',
      timestamp: TS,
      payload: {
        ws_connection_id: 'conn_local',
        protocol_version: 2,
        heartbeat_ms: 30000,
        max_event_buffer_size: 1000,
        capabilities: { event_batching: false, compression: false },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a server_hello missing protocol_version', () => {
    const result = serverHelloMessageSchema.safeParse({
      type: 'server_hello',
      timestamp: TS,
      payload: {
        ws_connection_id: 'conn_local',
        heartbeat_ms: 30000,
        max_event_buffer_size: 1000,
        capabilities: { event_batching: false, compression: false },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a server_hello missing capabilities', () => {
    const result = serverHelloMessageSchema.safeParse({
      type: 'server_hello',
      timestamp: TS,
      payload: {
        ws_connection_id: 'conn_local',
        protocol_version: 2,
        heartbeat_ms: 30000,
        max_event_buffer_size: 1000,
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('ws-control — §3.2 client_hello', () => {
  it('parses a canonical client_hello', () => {
    const result = clientHelloMessageSchema.safeParse({
      type: 'client_hello',
      id: 'c1',
      payload: {
        client_id: 'web_abc',
        subscriptions: ['sess_1', 'sess_2'],
        cursors: { sess_1: { seq: 99, epoch: 'ep_01ABC' } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('client_hello accepts an epoch-less fresh cursor', () => {
    const result = clientHelloMessageSchema.safeParse({
      type: 'client_hello',
      id: 'c1',
      payload: {
        client_id: 'web_abc',
        subscriptions: [],
        cursors: { sess_1: { seq: 0 } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('client_hello rejects the v1 bare-seq cursor map', () => {
    const result = clientHelloMessageSchema.safeParse({
      type: 'client_hello',
      id: 'c1',
      payload: {
        client_id: 'web_abc',
        subscriptions: [],
        cursors: { sess_1: 99 },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a client_hello missing payload.client_id', () => {
    const result = clientHelloMessageSchema.safeParse({
      type: 'client_hello',
      id: 'c1',
      payload: { subscriptions: [] },
    });
    expect(result.success).toBe(false);
  });
});

describe('ws-control — §3.3 subscribe / unsubscribe', () => {
  it('subscribe accepts a watch_fs map', () => {
    const result = subscribeMessageSchema.safeParse({
      type: 'subscribe',
      id: 'c2',
      payload: {
        session_ids: ['sess_1'],
        watch_fs: {
          sess_1: { paths: ['src'], recursive: true },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('subscribe rejects missing session_ids', () => {
    const result = subscribeMessageSchema.safeParse({
      type: 'subscribe',
      id: 'c2',
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it('unsubscribe parses on session_ids', () => {
    const ok = unsubscribeMessageSchema.safeParse({
      type: 'unsubscribe',
      id: 'c3',
      payload: { session_ids: ['sess_1'] },
    });
    expect(ok.success).toBe(true);
  });

  it('unsubscribe rejects bad type literal', () => {
    const bad = unsubscribeMessageSchema.safeParse({
      type: 'unsub',
      id: 'c3',
      payload: { session_ids: [] },
    });
    expect(bad.success).toBe(false);
  });
});

describe('ws-control — §3.3.1 watch_fs_add / watch_fs_remove', () => {
  it('watch_fs_add accepts paths', () => {
    const result = watchFsAddMessageSchema.safeParse({
      type: 'watch_fs_add',
      id: 'c4',
      payload: {
        session_id: 'sess_1',
        paths: ['src/components'],
        recursive: true,
      },
    });
    expect(result.success).toBe(true);
  });

  it('watch_fs_add rejects missing session_id', () => {
    const result = watchFsAddMessageSchema.safeParse({
      type: 'watch_fs_add',
      id: 'c4',
      payload: { paths: [] },
    });
    expect(result.success).toBe(false);
  });

  it('watch_fs_remove requires session_id + paths', () => {
    const ok = watchFsRemoveMessageSchema.safeParse({
      type: 'watch_fs_remove',
      id: 'c5',
      payload: { session_id: 'sess_1', paths: ['src/components'] },
    });
    expect(ok.success).toBe(true);

    const bad = watchFsRemoveMessageSchema.safeParse({
      type: 'watch_fs_remove',
      id: 'c5',
      payload: { paths: ['src/components'] },
    });
    expect(bad.success).toBe(false);
  });
});

describe('ws-control — §3.4 abort', () => {
  it('parses a canonical abort frame', () => {
    const result = abortMessageSchema.safeParse({
      type: 'abort',
      id: 'c6',
      payload: { session_id: 'sess_1', prompt_id: 'prompt_1' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an abort missing prompt_id', () => {
    const result = abortMessageSchema.safeParse({
      type: 'abort',
      id: 'c6',
      payload: { session_id: 'sess_1' },
    });
    expect(result.success).toBe(false);
  });
});

describe('ws-control — §3.5 ping / pong', () => {
  it('ping (S→C) requires timestamp + nonce', () => {
    const ok = pingMessageSchema.safeParse({
      type: 'ping',
      timestamp: TS,
      payload: { nonce: 'n_1' },
    });
    expect(ok.success).toBe(true);

    const bad = pingMessageSchema.safeParse({
      type: 'ping',
      payload: { nonce: 'n_1' },
    });
    expect(bad.success).toBe(false);
  });

  it('pong (C→S) requires nonce in payload', () => {
    const ok = pongMessageSchema.safeParse({
      type: 'pong',
      payload: { nonce: 'n_1' },
    });
    expect(ok.success).toBe(true);

    const bad = pongMessageSchema.safeParse({
      type: 'pong',
      payload: {},
    });
    expect(bad.success).toBe(false);
  });
});

describe('ws-control — terminal controls', () => {
  it('parses terminal attach, input, resize, detach, and close controls', () => {
    expect(
      terminalAttachMessageSchema.safeParse({
        type: 'terminal_attach',
        id: 't1',
        payload: { session_id: 'sess_1', terminal_id: 'term_1', since_seq: 2 },
      }).success,
    ).toBe(true);
    expect(
      terminalInputMessageSchema.safeParse({
        type: 'terminal_input',
        id: 't2',
        payload: { session_id: 'sess_1', terminal_id: 'term_1', data: 'ls\r' },
      }).success,
    ).toBe(true);
    expect(
      terminalResizeMessageSchema.safeParse({
        type: 'terminal_resize',
        id: 't3',
        payload: { session_id: 'sess_1', terminal_id: 'term_1', cols: 120, rows: 32 },
      }).success,
    ).toBe(true);
    expect(
      terminalDetachMessageSchema.safeParse({
        type: 'terminal_detach',
        id: 't4',
        payload: { session_id: 'sess_1', terminal_id: 'term_1' },
      }).success,
    ).toBe(true);
    expect(
      terminalCloseMessageSchema.safeParse({
        type: 'terminal_close',
        id: 't5',
        payload: { session_id: 'sess_1', terminal_id: 'term_1' },
      }).success,
    ).toBe(true);
  });

  it('parses terminal output and exit server frames without renderer-specific fields', () => {
    expect(
      terminalOutputMessageSchema.safeParse({
        type: 'terminal_output',
        seq: 3,
        session_id: 'sess_1',
        terminal_id: 'term_1',
        timestamp: TS,
        payload: { data: 'hello\r\n' },
      }).success,
    ).toBe(true);
    expect(
      terminalExitMessageSchema.safeParse({
        type: 'terminal_exit',
        session_id: 'sess_1',
        terminal_id: 'term_1',
        timestamp: TS,
        payload: { exit_code: 0 },
      }).success,
    ).toBe(true);
  });
});

describe('ws-control — §3.6 resync_required', () => {
  it('parses a canonical resync_required', () => {
    const result = resyncRequiredMessageSchema.safeParse({
      type: 'resync_required',
      timestamp: TS,
      payload: { session_id: 'sess_1', reason: 'buffer_overflow', current_seq: 1234 },
    });
    expect(result.success).toBe(true);
  });

  it('parses an epoch_changed resync with the new epoch', () => {
    const result = resyncRequiredMessageSchema.safeParse({
      type: 'resync_required',
      timestamp: TS,
      payload: {
        session_id: 'sess_1',
        reason: 'epoch_changed',
        current_seq: 12,
        epoch: 'ep_01DEF',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown reason', () => {
    const result = resyncRequiredMessageSchema.safeParse({
      type: 'resync_required',
      timestamp: TS,
      payload: { session_id: 'sess_1', reason: 'nope', current_seq: 0 },
    });
    expect(result.success).toBe(false);
  });
});

describe('ws-control — §3.7 error', () => {
  it('parses a canonical error frame', () => {
    const result = wsErrorMessageSchema.safeParse({
      type: 'error',
      timestamp: TS,
      payload: { code: 40001, msg: 'validation failed', fatal: false },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an error missing fatal flag', () => {
    const result = wsErrorMessageSchema.safeParse({
      type: 'error',
      timestamp: TS,
      payload: { code: 40001, msg: 'x' },
    });
    expect(result.success).toBe(false);
  });
});

describe('ws-control — discriminated unions', () => {
  it('clientControlMessageSchema dispatches by type', () => {
    const ok = clientControlMessageSchema.safeParse({
      type: 'abort',
      id: 'c7',
      payload: { session_id: 'sess_1', prompt_id: 'prompt_1' },
    });
    expect(ok.success).toBe(true);
  });

  it('clientControlMessageSchema rejects an unknown control type', () => {
    const result = clientControlMessageSchema.safeParse({
      type: 'launch_missiles',
      id: 'c8',
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it('serverSystemMessageSchema accepts server_hello / ping / resync / error', () => {
    expect(
      serverSystemMessageSchema.safeParse({
        type: 'ping',
        timestamp: TS,
        payload: { nonce: 'n_1' },
      }).success,
    ).toBe(true);
    expect(
      serverSystemMessageSchema.safeParse({
        type: 'error',
        timestamp: TS,
        payload: { code: 50001, msg: 'boom', fatal: true },
      }).success,
    ).toBe(true);
  });
});

describe('ws-control — operation registry', () => {
  it('covers every client control frame with a message schema and ack schema', () => {
    expect(clientControlOperations.map((op) => op.type)).toEqual([
      'client_hello',
      'subscribe',
      'unsubscribe',
      'watch_fs_add',
      'watch_fs_remove',
      'abort',
      'terminal_attach',
      'terminal_detach',
      'terminal_input',
      'terminal_resize',
      'terminal_close',
      'pong',
    ]);

    for (const op of clientControlOperations) {
      expect(op.direction).toBe('client_to_server');
      expect(op.messageSchema).toBeDefined();
      if (op.type !== 'pong') {
        expect(op.ackSchema).toBeDefined();
      }
    }
  });

  it('looks up client control operations by frame type', () => {
    expect(getClientControlOperation('subscribe')?.messageSchema).toBe(subscribeMessageSchema);
    expect(getClientControlOperation('launch_missiles')).toBeUndefined();
  });

  it('defines typed ack message schemas for control responses', () => {
    expect(
      clientHelloAckMessageSchema.safeParse({
        type: 'ack',
        id: 'c1',
        code: 0,
        msg: 'success',
        payload: { accepted_subscriptions: ['sess_1'], resync_required: [] },
      }).success,
    ).toBe(true);
    expect(
      subscribeAckMessageSchema.safeParse({
        type: 'ack',
        id: 'c2',
        code: 0,
        msg: 'success',
        payload: { accepted: ['sess_1'], not_found: [], resync_required: [] },
      }).success,
    ).toBe(true);
    expect(
      unsubscribeAckMessageSchema.safeParse({
        type: 'ack',
        id: 'c3',
        code: 0,
        msg: 'success',
        payload: { accepted: ['sess_1'], not_found: [], resync_required: [] },
      }).success,
    ).toBe(true);
    expect(
      watchFsAckMessageSchema.safeParse({
        type: 'ack',
        id: 'c4',
        code: 0,
        msg: 'success',
        payload: { watched_paths: ['src'], current_count: 1 },
      }).success,
    ).toBe(true);
    expect(
      abortAckMessageSchema.safeParse({
        type: 'ack',
        id: 'c5',
        code: 0,
        msg: 'success',
        payload: { aborted: true, at_seq: 10 },
      }).success,
    ).toBe(true);
    expect(
      terminalAttachAckMessageSchema.safeParse({
        type: 'ack',
        id: 't1',
        code: 0,
        msg: 'success',
        payload: { attached: true, replayed: 2 },
      }).success,
    ).toBe(true);
    expect(
      terminalDetachAckMessageSchema.safeParse({
        type: 'ack',
        id: 't2',
        code: 0,
        msg: 'success',
        payload: { detached: true },
      }).success,
    ).toBe(true);
    expect(
      terminalInputAckMessageSchema.safeParse({
        type: 'ack',
        id: 't3',
        code: 0,
        msg: 'success',
        payload: { accepted: true },
      }).success,
    ).toBe(true);
    expect(
      terminalResizeAckMessageSchema.safeParse({
        type: 'ack',
        id: 't4',
        code: 0,
        msg: 'success',
        payload: { resized: true },
      }).success,
    ).toBe(true);
    expect(
      terminalCloseAckMessageSchema.safeParse({
        type: 'ack',
        id: 't5',
        code: 0,
        msg: 'success',
        payload: { closed: true },
      }).success,
    ).toBe(true);
  });

  it('covers server system frames and the session event stream', () => {
    expect(serverSystemOperations.map((op) => op.type)).toEqual([
      'server_hello',
      'ping',
      'resync_required',
      'error',
    ]);

    expect(
      sessionEventMessageSchema.safeParse({
        type: 'assistant.delta',
        seq: 1,
        session_id: 'sess_1',
        timestamp: TS,
        payload: {
          type: 'assistant.delta',
          agentId: 'agent_1',
          sessionId: 'sess_1',
          turnId: 1,
          delta: 'hello',
        },
      }).success,
    ).toBe(true);

    expect(wsOperations.some((op) => op.type === 'session_event')).toBe(true);
  });
});
