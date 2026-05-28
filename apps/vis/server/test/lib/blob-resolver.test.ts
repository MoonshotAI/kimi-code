import { describe, it, expect } from 'vitest';
import { resolveBlobRefUrl, isSafeBlobHash, rehydrateWireEntries } from '../../src/lib/blob-resolver';

describe('blob-resolver', () => {
  describe('resolveBlobRefUrl', () => {
    it('converts a well-formed blobref into a relative route by default', () => {
      const url = resolveBlobRefUrl(
        'blobref:image/png;abc123def456',
        'sess-1',
        'main',
      );
      expect(url).toBe(
        '/api/sessions/sess-1/blobs/abc123def456?agent=main&mime=image%2Fpng',
      );
    });

    it('returns an absolute URL when baseUrl is provided', () => {
      const url = resolveBlobRefUrl(
        'blobref:image/png;abc123def456',
        'sess-1',
        'main',
        'http://localhost:3001',
      );
      expect(url).toBe(
        'http://localhost:3001/api/sessions/sess-1/blobs/abc123def456?agent=main&mime=image%2Fpng',
      );
    });

    it('returns non-blobref URLs unchanged', () => {
      expect(resolveBlobRefUrl('https://example.com/x.png', 's', 'a')).toBe(
        'https://example.com/x.png',
      );
      expect(resolveBlobRefUrl('data:image/png;base64,abc', 's', 'a')).toBe(
        'data:image/png;base64,abc',
      );
    });

    it('returns malformed blobrefs unchanged', () => {
      expect(resolveBlobRefUrl('blobref:nosemicolon', 's', 'a')).toBe(
        'blobref:nosemicolon',
      );
      expect(resolveBlobRefUrl('blobref:image/png;', 's', 'a')).toBe(
        'blobref:image/png;',
      );
    });
  });

  describe('isSafeBlobHash', () => {
    it('accepts a 64-char hex string', () => {
      expect(isSafeBlobHash('a'.repeat(64))).toBe(true);
      expect(isSafeBlobHash('0'.repeat(64))).toBe(true);
      expect(isSafeBlobHash('f'.repeat(64))).toBe(true);
    });

    it('rejects non-hex, wrong length, and path-traversal strings', () => {
      expect(isSafeBlobHash('')).toBe(false);
      expect(isSafeBlobHash('a'.repeat(63))).toBe(false);
      expect(isSafeBlobHash('a'.repeat(65))).toBe(false);
      expect(isSafeBlobHash('x'.repeat(64))).toBe(false);
      expect(isSafeBlobHash('../etc/passwd')).toBe(false);
      expect(isSafeBlobHash('a'.repeat(64) + '\n')).toBe(false);
    });
  });

  describe('rehydrateWireEntries', () => {
    it('mutates entry.data but leaves entry.raw untouched', () => {
      const data: Record<string, unknown> = {
        type: 'turn.prompt',
        input: [
          {
            type: 'image_url',
            imageUrl: { url: 'blobref:image/png;hashA' },
          },
        ],
      };
      const raw = JSON.parse(JSON.stringify(data));
      const entries = [{ lineNo: 1, data: data as any, raw }];

      rehydrateWireEntries(entries, 'sess-1', 'main');

      expect((entries[0]!.data as any).input[0].imageUrl.url).toBe(
        '/api/sessions/sess-1/blobs/hashA?agent=main&mime=image%2Fpng',
      );
      expect((entries[0]!.raw as any).input[0].imageUrl.url).toBe(
        'blobref:image/png;hashA',
      );
    });

    it('handles audio_url, video_url, and nested tool result parts', () => {
      const data: Record<string, unknown> = {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          result: {
            output: [
              {
                type: 'audio_url',
                audioUrl: { url: 'blobref:audio/wav;hashB' },
              },
            ],
          },
        },
      };
      const entries = [{ lineNo: 1, data: data as any, raw: {} }];

      rehydrateWireEntries(entries, 'sess-2', 'sub-1');

      const parts = (entries[0]!.data as any).event.result.output;
      expect(parts[0].audioUrl.url).toBe(
        '/api/sessions/sess-2/blobs/hashB?agent=sub-1&mime=audio%2Fwav',
      );
    });

    it('resolves blobrefs to absolute URLs when baseUrl is provided', () => {
      const data: Record<string, unknown> = {
        type: 'turn.prompt',
        input: [
          {
            type: 'image_url',
            imageUrl: { url: 'blobref:image/png;hashC' },
          },
        ],
      };
      const entries = [{ lineNo: 1, data: data as any, raw: {} }];

      rehydrateWireEntries(entries, 'sess-3', 'main', 'http://localhost:3001');

      expect((entries[0]!.data as any).input[0].imageUrl.url).toBe(
        'http://localhost:3001/api/sessions/sess-3/blobs/hashC?agent=main&mime=image%2Fpng',
      );
    });

    it('ignores records without media URLs', () => {
      const data = { type: 'config.update', cwd: '/tmp' };
      const entries = [{ lineNo: 1, data: data as any, raw: {} }];
      rehydrateWireEntries(entries, 's', 'a');
      expect(entries[0]!.data).toEqual(data);
    });
  });
});
