// packages/app-core/test/mappers.test.ts
// daemon wire ↔ app message mapping for media sources: a `session_media`
// projection (a daemon media reference materialized into the session's own
// media store) must stay distinct from a global-upload `file` source on the
// way in and preserve that session-scoped kind on the way out.
// Run: pnpm exec vitest run packages/app-core/test/mappers.test.ts

import { describe, expect, it } from 'vitest';

import { toAppMessage, toWireMessageContent } from '../src/api/daemon/mappers';
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
