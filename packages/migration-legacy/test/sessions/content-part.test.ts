import { describe, expect, it } from 'vitest';
import { normalizeContentPart } from '../../src/sessions/content-part.js';

describe('normalizeContentPart', () => {
  it('text part: identity', () => {
    expect(normalizeContentPart({ type: 'text', text: 'hi' })).toEqual({ type: 'text', text: 'hi' });
  });

  it('think part: preserves think text, encrypted becomes undefined if null', () => {
    expect(normalizeContentPart({ type: 'think', think: 'x', encrypted: null })).toEqual({
      type: 'think',
      think: 'x',
    });
    expect(normalizeContentPart({ type: 'think', think: 'y', encrypted: 'sig' })).toEqual({
      type: 'think',
      think: 'y',
      encrypted: 'sig',
    });
  });

  it('image: renames to image_url, packs url and id', () => {
    const part = { type: 'image', url: 'data:...', id: 'img-1' };
    expect(normalizeContentPart(part)).toEqual({
      type: 'image_url',
      imageUrl: { url: 'data:...', id: 'img-1' },
    });
  });

  it('image: missing id is omitted', () => {
    expect(normalizeContentPart({ type: 'image', url: 'data:...' })).toEqual({
      type: 'image_url',
      imageUrl: { url: 'data:...' },
    });
  });

  it('audio/video: same renaming', () => {
    expect(normalizeContentPart({ type: 'audio', url: 'a' })).toEqual({
      type: 'audio_url',
      audioUrl: { url: 'a' },
    });
    expect(normalizeContentPart({ type: 'video', url: 'v' })).toEqual({
      type: 'video_url',
      videoUrl: { url: 'v' },
    });
  });

  it('image with file path that does not exist: falls back to text placeholder', () => {
    const part = { type: 'image', url: '/nonexistent/foo.png' };
    const res = normalizeContentPart(part);
    expect(res.type).toBe('text');
    expect((res as { type: 'text'; text: string }).text).toContain('image expired');
  });

  it('nested image_url (current kimi-cli form): packs url and id', () => {
    const part = { type: 'image_url', image_url: { url: 'data:...', id: 'img-1' } };
    expect(normalizeContentPart(part)).toEqual({
      type: 'image_url',
      imageUrl: { url: 'data:...', id: 'img-1' },
    });
  });

  it('nested image_url: null id is omitted', () => {
    const part = { type: 'image_url', image_url: { url: 'data:...', id: null } };
    expect(normalizeContentPart(part)).toEqual({
      type: 'image_url',
      imageUrl: { url: 'data:...' },
    });
  });

  it('nested audio_url/video_url: same conversion', () => {
    expect(normalizeContentPart({ type: 'audio_url', audio_url: { url: 'a' } })).toEqual({
      type: 'audio_url',
      audioUrl: { url: 'a' },
    });
    expect(normalizeContentPart({ type: 'video_url', video_url: { url: 'v', id: 'vid-1' } })).toEqual({
      type: 'video_url',
      videoUrl: { url: 'v', id: 'vid-1' },
    });
  });

  it('nested media with expired local path: falls back to text placeholder', () => {
    const part = { type: 'image_url', image_url: { url: '/nonexistent/foo.png' } };
    const res = normalizeContentPart(part);
    expect(res.type).toBe('text');
    expect((res as { type: 'text'; text: string }).text).toContain('image expired');
  });

  it('nested media with missing payload: falls back to missing-url text', () => {
    const res = normalizeContentPart({ type: 'image_url' });
    expect(res.type).toBe('text');
    expect((res as { type: 'text'; text: string }).text).toContain('image missing url');
  });

  it('unknown type: falls back to text with stringified content', () => {
    const part = { type: 'weird', payload: { x: 1 } };
    const res = normalizeContentPart(part);
    expect(res.type).toBe('text');
    expect((res as { type: 'text'; text: string }).text).toContain('unsupported content');
  });
});
