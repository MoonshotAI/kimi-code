import { describe, expect, it } from 'vitest';

import { kimiFiles } from '#/llm/builtin/provider/kimi/files';

describe('Kimi file uploads', () => {
  it('rejects failed or incomplete extraction and returns ready file references', async () => {
    const failures = [
      {
        body: {
          id: 'img-1',
          extract_status: 'error',
          extract_error: 'Formula image could not be decoded',
        },
        expected: /img-1.*extract_status=error.*Formula image could not be decoded/,
      },
      {
        body: { id: 'img-2', status: 'error', status_details: 'Invalid image format' },
        expected: /img-2.*status=error.*Invalid image format/,
      },
      {
        body: { id: 'img-3', extract_status: 'error', error: { message: 'Unsupported color profile' } },
        expected: /img-3.*extract_status=error.*Unsupported color profile/,
      },
      {
        body: { id: 'img-4', extract_status: 'processing' },
        expected: /img-4.*not ready.*extract_status=processing/,
      },
      {
        body: { id: 'img-5', status: 'uploaded' },
        expected: /img-5.*not ready.*status=uploaded/,
      },
      {
        body: { id: ' ', extract_status: 'ready' },
        expected: /empty file id/,
      },
    ];
    const responses = [
      ...failures.map(({ body }) => Response.json(body)),
      Response.json({ id: 'img-ready', extract_status: 'ready', status: 'uploaded' }),
    ];
    const mockFetch: typeof fetch = async (input) => {
      if (new Request(input).url === 'data:,') return new Response();
      return responses.shift()!;
    };
    const upload = () =>
      kimiFiles.upload(
        { data: new Uint8Array([1]), kind: 'image', mimeType: 'image/png' },
        {
          endpoint: { baseUrl: 'https://example.test/v1', fetch: mockFetch },
          signal: new AbortController().signal,
        },
      );

    for (const { expected } of failures) {
      await expect(upload()).rejects.toThrow(expected);
    }
    await expect(upload()).resolves.toEqual({ url: 'ms://img-ready', id: 'img-ready' });
    expect(responses).toHaveLength(0);
  });
});
