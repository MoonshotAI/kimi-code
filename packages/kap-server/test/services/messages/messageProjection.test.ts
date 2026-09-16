import { describe, expect, it } from 'vitest';

import type { HistoryMessage, UserEntry } from '@moonshot-ai/agent-core-v2';

import { projectPromptContentParts, toProtocolMessage } from '../../../src/services/messages/messageProjection';

const SESSION_ID = 'session_1';
const CREATED_AT = 1_700_000_000_000;

function userText(text: string): UserEntry {
  return { message: { role: 'user', content: [{ type: 'text', text }] }, meta: {} };
}

describe('toProtocolMessage', () => {
  it('maps text/think/image/audio/video content parts', () => {
    const msg: HistoryMessage = {
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'think', think: 'hmm', encrypted: 'sig-1' },
          { type: 'image_url', imageUrl: { url: 'https://example.com/a.png' } },
          { type: 'audio_url', audioUrl: { url: 'https://example.com/a.mp3' } },
          { type: 'video_url', videoUrl: { url: 'https://example.com/a.mp4' } },
        ],
      },
      meta: {},
    };

    expect(toProtocolMessage(SESSION_ID, 0, msg, CREATED_AT).content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'thinking', thinking: 'hmm', signature: 'sig-1' },
      { type: 'image', source: { kind: 'url', url: 'https://example.com/a.png' } },
      { type: 'text', text: '[audio:https://example.com/a.mp3]' },
      { type: 'video', source: { kind: 'url', url: 'https://example.com/a.mp4' } },
    ]);
  });

  it('projects a daemon-ref image part to a session_media source', () => {
    const msg: HistoryMessage = {
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', imageUrl: { url: 'kimi-file://file_9?path=%2Fcache%2Fpic.png' } },
        ],
      },
      meta: {},
    };

    expect(toProtocolMessage(SESSION_ID, 0, msg, CREATED_AT).content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', source: { kind: 'session_media', file_id: 'file_9' } },
    ]);
  });

  it('preserves media names in live and prompt projections', () => {
    const part = {
      type: 'image_url' as const,
      imageUrl: { url: 'kimi-file://file_9', id: 'file_9', name: 'photo.png' },
    };
    const msg: HistoryMessage = { message: { role: 'user', content: [part] }, meta: {} };

    expect(toProtocolMessage(SESSION_ID, 0, msg, CREATED_AT).content).toEqual([
      { type: 'image', source: { kind: 'session_media', file_id: 'file_9' }, name: 'photo.png' },
    ]);
    expect(projectPromptContentParts([part])).toEqual([
      { type: 'image', source: { kind: 'session_media', file_id: 'file_9' }, name: 'photo.png' },
    ]);
  });

  it('keeps a legacy tag+ref pair as text plus the ref projection', () => {
    const msg: HistoryMessage = {
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<image path="/cache/pic.png"></image>' },
          { type: 'image_url', imageUrl: { url: 'kimi-file://file_9?path=%2Fcache%2Fpic.png' } },
        ],
      },
      meta: {},
    };

    expect(toProtocolMessage(SESSION_ID, 0, msg, CREATED_AT).content).toEqual([
      { type: 'text', text: '<image path="/cache/pic.png"></image>' },
      { type: 'image', source: { kind: 'session_media', file_id: 'file_9' } },
    ]);
  });

  it('keeps a bare <media path> tag as text in user messages', () => {
    const msg: HistoryMessage = {
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<video path="/cache/clip.mp4">' },
          { type: 'text', text: 'watch this' },
        ],
      },
      meta: {},
    };

    expect(toProtocolMessage(SESSION_ID, 0, msg, CREATED_AT).content).toEqual([
      { type: 'text', text: '<video path="/cache/clip.mp4">' },
      { type: 'text', text: 'watch this' },
    ]);
  });

  it('passes assistant tag-shaped text through verbatim', () => {
    const msg: HistoryMessage = {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '<image path="/cache/out.png"></image>' }],
        toolCalls: [],
      },
      meta: {},
    };

    expect(toProtocolMessage(SESSION_ID, 0, msg, CREATED_AT).content).toEqual([
      { type: 'text', text: '<image path="/cache/out.png"></image>' },
    ]);
  });

  it('projects a kimi-file video reference to a structured file source without leaking the path', () => {
    const msg: HistoryMessage = {
      message: {
        role: 'user',
        content: [
          { type: 'video_url', videoUrl: { url: 'kimi-file://file_9?path=%2Fcache%2Fclip.mp4' } },
        ],
      },
      meta: {},
    };

    expect(toProtocolMessage(SESSION_ID, 0, msg, CREATED_AT).content).toEqual([
      { type: 'video', source: { kind: 'session_media', file_id: 'file_9' } },
    ]);
  });

  it('projects a provider video url to a structured url source carrying its id', () => {
    const msg: HistoryMessage = {
      message: {
        role: 'user',
        content: [{ type: 'video_url', videoUrl: { url: 'ms://prov-7', id: 'prov-7' } }],
      },
      meta: {},
    };

    expect(toProtocolMessage(SESSION_ID, 0, msg, CREATED_AT).content).toEqual([
      { type: 'video', source: { kind: 'url', url: 'ms://prov-7', id: 'prov-7' } },
    ]);
  });

  it('appends assistant tool calls as tool_use parts with parsed input', () => {
    const msg: HistoryMessage = {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'running' }],
        toolCalls: [
          { type: 'function', id: 'call_1', name: 'Bash', arguments: '{"cmd":"ls"}' },
          { type: 'function', id: 'call_2', name: 'Broken', arguments: '{not json' },
        ],
      },
      meta: {},
    };

    expect(toProtocolMessage(SESSION_ID, 0, msg, CREATED_AT).content).toEqual([
      { type: 'text', text: 'running' },
      { type: 'tool_use', tool_call_id: 'call_1', tool_name: 'Bash', input: { cmd: 'ls' } },
      { type: 'tool_use', tool_call_id: 'call_2', tool_name: 'Broken', input: '{not json' },
    ]);
  });

  it('flattens a plain-text tool result into the tool_result output', () => {
    const result: HistoryMessage = {
      message: {
        role: 'tool',
        content: [{ type: 'text', text: 'image result' }],
        toolCallId: 'call_image',
      },
      meta: { note: '<system>Image compressed.</system>' },
    };

    expect(toProtocolMessage(SESSION_ID, 0, result, 0).content).toEqual([
      { type: 'tool_result', tool_call_id: 'call_image', output: 'image result' },
    ]);
  });

  it('passes raw media parts through as the tool_result output', () => {
    const result: HistoryMessage = {
      message: {
        role: 'tool',
        content: [
          { type: 'text', text: 'image result' },
          { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
        ],
        toolCallId: 'call_media',
      },
      meta: {},
    };

    expect(toProtocolMessage(SESSION_ID, 0, result, 0).content).toEqual([
      { type: 'tool_result', tool_call_id: 'call_media', output: result.message.content },
    ]);
  });

  it('marks failed tool results with is_error', () => {
    const result: HistoryMessage = {
      message: {
        role: 'tool',
        content: [{ type: 'text', text: 'boom' }],
        toolCallId: 'call_err',
      },
      meta: { isError: true },
    };

    expect(toProtocolMessage(SESSION_ID, 0, result, 0).content).toEqual([
      { type: 'tool_result', tool_call_id: 'call_err', output: 'boom', is_error: true },
    ]);
  });

  it('prefers the stored message id and falls back to the transcript index', () => {
    const withId: HistoryMessage = {
      message: userText('a').message,
      meta: { promptId: 'msg_custom' },
    };
    expect(toProtocolMessage(SESSION_ID, 7, withId, CREATED_AT).id).toBe('msg_custom');
    expect(toProtocolMessage(SESSION_ID, 7, userText('a'), CREATED_AT).id).toBe(
      `msg_${SESSION_ID}_000007`,
    );
  });

  it('stamps created_at from the override or the session-created fallback', () => {
    const msg = userText('a');
    expect(toProtocolMessage(SESSION_ID, 3, msg, CREATED_AT, CREATED_AT + 999).created_at).toBe(
      new Date(CREATED_AT + 999).toISOString(),
    );
    expect(toProtocolMessage(SESSION_ID, 3, msg, CREATED_AT).created_at).toBe(
      new Date(CREATED_AT + 3).toISOString(),
    );
  });

  it('carries origin into metadata and omits metadata otherwise', () => {
    const withOrigin: HistoryMessage = {
      message: userText('a').message,
      meta: { origin: { kind: 'user' } },
    };
    expect(toProtocolMessage(SESSION_ID, 0, withOrigin, CREATED_AT).metadata).toEqual({
      origin: { kind: 'user' },
    });
    expect(toProtocolMessage(SESSION_ID, 0, userText('a'), CREATED_AT)).not.toHaveProperty(
      'metadata',
    );
  });
});
