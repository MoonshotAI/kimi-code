import { describe, expect, it } from 'vitest';

import {
  abortMessageSchema,
  clientControlMessageSchema,
  clientHelloMessageSchema,
  pingMessageSchema,
  pongMessageSchema,
  resyncRequiredMessageSchema,
  serverHelloMessageSchema,
  serverSystemMessageSchema,
  subscribeMessageSchema,
  unsubscribeMessageSchema,
  watchFsAddMessageSchema,
  watchFsRemoveMessageSchema,
  wsAckEnvelopeSchema,
  wsControlEnvelopeSchema,
  wsErrorMessageSchema,
  wsEventEnvelopeSchema,
} from '../ws-control';
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

describe('ws-control — §3.1 server_hello', () => {
  it('parses a canonical server_hello frame', () => {
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
    expect(result.success).toBe(true);
  });

  it('rejects a server_hello missing capabilities', () => {
    const result = serverHelloMessageSchema.safeParse({
      type: 'server_hello',
      timestamp: TS,
      payload: {
        ws_connection_id: 'conn_local',
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
        last_seq_by_session: { sess_1: 99 },
      },
    });
    expect(result.success).toBe(true);
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

describe('ws-control — §3.6 resync_required', () => {
  it('parses a canonical resync_required', () => {
    const result = resyncRequiredMessageSchema.safeParse({
      type: 'resync_required',
      timestamp: TS,
      payload: { session_id: 'sess_1', reason: 'buffer_overflow', current_seq: 1234 },
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
