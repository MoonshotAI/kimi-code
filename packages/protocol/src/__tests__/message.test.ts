import { describe, expect, it } from 'vitest';

import {
  fileContentSchema,
  imageContentSchema,
  messageContentSchema,
  messageRoleSchema,
  messageSchema,
  textContentSchema,
  thinkingContentSchema,
  toolResultContentSchema,
  toolUseContentSchema,
  videoContentSchema,
} from '../message';

describe('messageRoleSchema', () => {
  it.each(['user', 'assistant', 'tool', 'system'] as const)('accepts %s', (role) => {
    expect(messageRoleSchema.parse(role)).toBe(role);
  });

  it('rejects an unknown role', () => {
    expect(messageRoleSchema.safeParse('cat').success).toBe(false);
  });
});

describe('messageContentSchema variants', () => {
  it('parses text content', () => {
    const parsed = textContentSchema.parse({ type: 'text', text: 'hello' });
    expect(parsed.text).toBe('hello');
  });

  it('parses tool_use content', () => {
    const parsed = toolUseContentSchema.parse({
      type: 'tool_use',
      tool_call_id: 'call_1',
      tool_name: 'Bash',
      input: { command: 'ls' },
    });
    expect(parsed.tool_name).toBe('Bash');
  });

  it('parses tool_result content with is_error', () => {
    const parsed = toolResultContentSchema.parse({
      type: 'tool_result',
      tool_call_id: 'call_1',
      output: 'error',
      is_error: true,
    });
    expect(parsed.is_error).toBe(true);
  });

  it('parses image url source', () => {
    const parsed = imageContentSchema.parse({
      type: 'image',
      source: { kind: 'url', url: 'https://example.com/a.png' },
    });
    expect(parsed.source.kind).toBe('url');
  });

  it('parses image base64 source', () => {
    const parsed = imageContentSchema.parse({
      type: 'image',
      source: { kind: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
    });
    expect(parsed.source.kind).toBe('base64');
  });

  it('parses video url source', () => {
    const parsed = videoContentSchema.parse({
      type: 'video',
      source: { kind: 'url', url: 'https://example.com/a.mp4' },
    });
    expect(parsed.source.kind).toBe('url');
  });

  it('parses video base64 source', () => {
    const parsed = videoContentSchema.parse({
      type: 'video',
      source: { kind: 'base64', media_type: 'video/mp4', data: 'aGVsbG8=' },
    });
    expect(parsed.source.kind).toBe('base64');
  });

  it('parses video file source', () => {
    const parsed = videoContentSchema.parse({
      type: 'video',
      source: { kind: 'file', file_id: 'file_video_01' },
    });
    expect(parsed.source.kind).toBe('file');
  });

  it('parses file content', () => {
    const parsed = fileContentSchema.parse({
      type: 'file',
      file_id: 'file_01',
      name: 'doc.pdf',
      media_type: 'application/pdf',
      size: 12345,
    });
    expect(parsed.size).toBe(12345);
  });

  it('parses thinking content', () => {
    const parsed = thinkingContentSchema.parse({
      type: 'thinking',
      thinking: 'pondering',
    });
    expect(parsed.thinking).toBe('pondering');
  });

  it('messageContentSchema discriminates by type', () => {
    const parsed = messageContentSchema.parse({ type: 'text', text: 'hi' });
    expect(parsed.type).toBe('text');
  });

  it('messageContentSchema accepts mixed text and video content', () => {
    const parsed = messageContentSchema.parse({
      type: 'video',
      source: { kind: 'url', url: 'https://example.com/a.mp4' },
    });
    expect(parsed.type).toBe('video');
  });

  it('rejects unknown content type', () => {
    expect(messageContentSchema.safeParse({ type: 'audio', text: '' }).success).toBe(false);
  });
});

describe('messageSchema', () => {
  const validMessage = {
    id: 'msg_01HZZZZ',
    session_id: 'sess_01',
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: 'hi' }],
    created_at: '2026-06-04T10:30:00.000Z',
  };

  it('parses a minimal assistant message', () => {
    const parsed = messageSchema.parse(validMessage);
    expect(parsed.id).toBe('msg_01HZZZZ');
    expect(parsed.role).toBe('assistant');
    expect(parsed.content[0]?.type).toBe('text');
  });

  it('parses with optional fields', () => {
    const parsed = messageSchema.parse({
      ...validMessage,
      prompt_id: 'prompt_01',
      parent_message_id: 'msg_parent',
      metadata: { tag: 'demo' },
    });
    expect(parsed.prompt_id).toBe('prompt_01');
    expect(parsed.parent_message_id).toBe('msg_parent');
    expect(parsed.metadata).toEqual({ tag: 'demo' });
  });

  it('rejects empty id', () => {
    expect(messageSchema.safeParse({ ...validMessage, id: '' }).success).toBe(false);
  });

  it('rejects bad ISO timestamp', () => {
    expect(
      messageSchema.safeParse({ ...validMessage, created_at: 'yesterday' }).success,
    ).toBe(false);
  });

  it('accepts tool message with tool_result content', () => {
    const parsed = messageSchema.parse({
      ...validMessage,
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          tool_call_id: 'call_1',
          output: 'done',
        },
      ],
    });
    expect(parsed.role).toBe('tool');
  });
});
