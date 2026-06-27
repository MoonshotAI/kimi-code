import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchCompleteFeedbackUpload,
  fetchCreateFeedbackUploadUrl,
  kimiCodeFeedbackUploadCompleteUrl,
  kimiCodeFeedbackUploadUrl,
  type CreateFeedbackUploadUrlBody,
} from '../src/managed-feedback-upload';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const SAMPLE_BODY: CreateFeedbackUploadUrlBody = {
  file_hash: 'e4d649659ca70729a510ef58f4cd062890020a1038eead5f411451fce62df415',
  file_name: 'repo.zip',
  file_size: 123,
  feedback_id: 3,
};

describe('kimiCodeFeedbackUploadUrl', () => {
  it('uses the feedback upload_url path', () => {
    expect(kimiCodeFeedbackUploadUrl()).toBe('https://api.kimi.com/coding/v1/feedback/upload_url');
  });
});

describe('kimiCodeFeedbackUploadCompleteUrl', () => {
  it('uses the feedback upload_complete path', () => {
    expect(kimiCodeFeedbackUploadCompleteUrl()).toBe(
      'https://api.kimi.com/coding/v1/feedback/upload_complete',
    );
  });
});

describe('fetchCreateFeedbackUploadUrl', () => {
  it('POSTs JSON body with bearer auth and parses upload parts', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 0,
          upload: {
            id: 28,
            upload_id: 'tos-multipart-id',
            part_size: 8,
            total_parts: 1,
            parts: [
              { part_number: 1, url: 'https://example.test/part1', method: 'PUT', size: 123 },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchCreateFeedbackUploadUrl('access-token', SAMPLE_BODY);

    expect(result).toEqual({
      kind: 'ok',
      upload_id: 28,
      parts: [{ part_number: 1, url: 'https://example.test/part1', method: 'PUT', size: 123 }],
    });

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit?][];
    const [calledUrl, init] = calls[0]!;
    expect(calledUrl).toBe('https://api.kimi.com/coding/v1/feedback/upload_url');
    expect(init?.method).toBe('POST');

    const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
    expect(headers.get('authorization')).toBe('Bearer access-token');
    expect(JSON.parse(init?.body as string)).toEqual(SAMPLE_BODY);
  });

  it('returns an error when the response omits parts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ code: 0, upload: { id: 28 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const result = await fetchCreateFeedbackUploadUrl('access-token', SAMPLE_BODY);

    expect(result).toEqual({
      kind: 'error',
      message: 'Feedback upload request failed: missing upload id or parts.',
    });
  });

  it('returns an error when a part is missing required fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            code: 0,
            upload: { id: 28, parts: [{ part_number: 1 }] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const result = await fetchCreateFeedbackUploadUrl('access-token', SAMPLE_BODY);

    expect(result).toEqual({
      kind: 'error',
      message: 'Feedback upload request failed: missing upload id or parts.',
    });
  });

  it('returns an error with status when the server responds 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));

    const result = await fetchCreateFeedbackUploadUrl('access-token', SAMPLE_BODY);

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.status).toBe(401);
    expect(result.message).toMatch(/401/);
  });
});

describe('fetchCompleteFeedbackUpload', () => {
  it('POSTs upload_id and parts with bearer auth', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchCompleteFeedbackUpload('access-token', {
      upload_id: 28,
      parts: [
        { part_number: 1, etag: '"etag-1"' },
        { part_number: 2, etag: '"etag-2"' },
      ],
    });

    expect(result).toEqual({ kind: 'ok' });
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit?][];
    const [calledUrl, init] = calls[0]!;
    expect(calledUrl).toBe('https://api.kimi.com/coding/v1/feedback/upload_complete');
    expect(JSON.parse(init?.body as string)).toEqual({
      upload_id: 28,
      parts: [
        { part_number: 1, etag: '"etag-1"' },
        { part_number: 2, etag: '"etag-2"' },
      ],
    });
  });
});
