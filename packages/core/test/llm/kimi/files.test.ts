import { describe, expect, it } from 'vitest';

import { kimiFiles } from '#/llm/builtin/provider/kimi/files';
import { MediaUploadFailedError } from '#/llm/request';

describe('Kimi file uploads', () => {
  it('as a Kimi user, I want failed or incomplete file extraction rejected and ready file references returned', async () => {
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

  it('reports definitive upload failures as MediaUploadFailedError and keeps intermediate states ordinary', async () => {
    const responses = [
      Response.json({ id: 'img-1', status: 'error', status_details: 'Invalid image format' }),
      Response.json({ id: 'img-2', extract_status: 'error', extract_error: 'decode failed' }),
      Response.json({ id: 'img-3', extract_status: 'processing' }),
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

    const statusFailure = await upload().catch((error: unknown) => error);
    expect(statusFailure).toBeInstanceOf(MediaUploadFailedError);
    expect((statusFailure as Error).message).toMatch(/img-1.*status=error.*Invalid image format/);
    const extractFailure = await upload().catch((error: unknown) => error);
    expect(extractFailure).toBeInstanceOf(MediaUploadFailedError);
    expect((extractFailure as Error).message).toMatch(/img-2.*extract_status=error.*decode failed/);
    const pendingFailure = await upload().catch((error: unknown) => error);
    expect(pendingFailure).toBeInstanceOf(Error);
    expect(pendingFailure).not.toBeInstanceOf(MediaUploadFailedError);
    expect(responses).toHaveLength(0);
  });

  it('queries file status through the upload endpoint and credentials', async () => {
    const seen: string[] = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url === 'data:,') return new Response();
      const { pathname } = new URL(request.url);
      seen.push(`${request.method} ${pathname}`);
      const id = pathname.slice('/v1/files/'.length);
      if (id === 'bad-status') return Response.json({ id, status: 'error' });
      if (id === 'bad-extract') return Response.json({ id, status: 'ready', extract_status: 'error' });
      return Response.json({ id, status: 'ready' });
    };
    const hasFailed = kimiFiles.hasFailed;
    if (hasFailed === undefined) throw new Error('kimiFiles.hasFailed is not implemented');
    const ctx = {
      endpoint: { baseUrl: 'https://example.test/v1', fetch: mockFetch },
      signal: new AbortController().signal,
    };

    await expect(hasFailed('bad-status', ctx)).resolves.toBe(true);
    await expect(hasFailed('bad-extract', ctx)).resolves.toBe(true);
    await expect(hasFailed('ok', ctx)).resolves.toBe(false);
    expect(seen).toEqual([
      'GET /v1/files/bad-status',
      'GET /v1/files/bad-extract',
      'GET /v1/files/ok',
    ]);
  });
});
