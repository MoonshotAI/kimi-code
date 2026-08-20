// packages/app-core/test/mappers.test.ts
// daemon wire ↔ app message mapping for media sources: a `session_media`
// projection (a daemon media reference materialized into the session's own
// media store) must stay distinct from a global-upload `file` source on the
// way in and preserve that session-scoped kind on the way out.
// Run: pnpm exec vitest run packages/app-core/test/mappers.test.ts

import { describe, expect, it } from 'vitest';

import { toAppEvent, toAppMessage, toWireMessageContent } from '../src/api/daemon/mappers';
import type { WireMessage } from '../src/api/daemon/wire';

function wireMessage(content: WireMessage['content']): WireMessage {
  return {
    id: 'm1',
    session_id: 'session-1',
    role: 'user',
    content,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('toAppMessage media sources', () => {
  it('keeps a session_media image source distinct from a global upload', () => {
    const app = toAppMessage(
      wireMessage([
        { type: 'image', source: { kind: 'session_media', file_id: 'f_sess' } },
        { type: 'image', source: { kind: 'file', file_id: 'f_global' } },
      ]),
    );
    expect(app.content).toEqual([
      { type: 'image', source: { kind: 'sessionMedia', fileId: 'f_sess' } },
      { type: 'image', source: { kind: 'file', fileId: 'f_global' } },
    ]);
  });

  it('maps a session_media video source the same way', () => {
    const app = toAppMessage(
      wireMessage([{ type: 'video', source: { kind: 'session_media', file_id: 'f_sess' } }]),
    );
    expect(app.content[0]).toEqual({
      type: 'video',
      source: { kind: 'sessionMedia', fileId: 'f_sess' },
    });
  });
});

describe('toWireMessageContent media sources', () => {
  it('keeps a sessionMedia source in the session-scoped wire namespace', () => {
    expect(
      toWireMessageContent({ type: 'image', source: { kind: 'sessionMedia', fileId: 'f_sess' } }),
    ).toEqual({ type: 'image', source: { kind: 'session_media', file_id: 'f_sess' } });
  });
});

describe('toAppEvent event.session.archived', () => {
  // Global frame: the envelope session_id is the '__global__' watermark, the
  // real session id rides in the payload.
  function archivedFrame(payload: unknown) {
    return {
      type: 'event.session.archived',
      seq: 1,
      session_id: '__global__',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload,
    } as const;
  }

  it('maps the payload session id (camelCase) and workspace_id', () => {
    expect(
      toAppEvent(archivedFrame({ workspace_id: 'wd_1', sessionId: 'sess_1' })),
    ).toEqual({ type: 'sessionArchived', sessionId: 'sess_1', workspaceId: 'wd_1' });
  });

  it('tolerates a snake_case session_id in the payload', () => {
    expect(
      toAppEvent(archivedFrame({ workspace_id: 'wd_1', session_id: 'sess_1' })),
    ).toEqual({ type: 'sessionArchived', sessionId: 'sess_1', workspaceId: 'wd_1' });
  });

  it('omits workspaceId when the payload does not carry one', () => {
    expect(toAppEvent(archivedFrame({ sessionId: 'sess_1' }))).toEqual({
      type: 'sessionArchived',
      sessionId: 'sess_1',
      workspaceId: undefined,
    });
  });

  it('degrades a frame without a usable session id to a silent no-op', () => {
    expect(toAppEvent(archivedFrame({ workspace_id: 'wd_1' }))).toEqual({
      type: 'unknown',
      raw: { _noop: true, _wireType: 'event.session.archived' },
    });
    expect(toAppEvent(archivedFrame({ workspace_id: 'wd_1', sessionId: '' }))).toEqual({
      type: 'unknown',
      raw: { _noop: true, _wireType: 'event.session.archived' },
    });
  });
});
