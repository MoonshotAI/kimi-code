import { afterEach, describe, expect, it } from 'vitest';

import { TestkitError } from '#/errors';
import { createKimiServices, serviceError, startKimiServices, type KimiServices } from '#/services/index';

const opened: KimiServices[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((services) => services.close()));
});

function track(services: KimiServices): KimiServices {
  opened.push(services);
  return services;
}

function postJson(services: KimiServices, path: string, body: unknown, token = 'token'): Promise<Response> {
  return services.fetch(`${services.baseUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function askTitle(services: KimiServices, chatContent: string, init: RequestInit = {}): Promise<Response> {
  return services.fetch(`${services.baseUrl}/tools`, {
    method: 'POST',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'chat_title', params: { chat_content: chatContent } }),
    ...init,
  });
}

describe('fake Kimi services: session titles', () => {
  it('answers chat_title calls with the scripted titles in order and records each call', async () => {
    const services = track(createKimiServices());
    services.title('First title', 'Second title');

    const first = await askTitle(services, 'user: hello');
    const second = await askTitle(services, 'user: again');

    expect(await first.json()).toEqual({ title: 'First title' });
    expect(await second.json()).toEqual({ title: 'Second title' });
    expect(services.requests('title').map((request) => request.json)).toEqual([
      { method: 'chat_title', params: { chat_content: 'user: hello' } },
      { method: 'chat_title', params: { chat_content: 'user: again' } },
    ]);
    expect(services.requests('title')[0]?.authorization).toBe('Bearer token');
    expect(() => services.verify()).not.toThrow();
  });

  it('answers a scripted service error with its status and message', async () => {
    const services = track(createKimiServices());
    services.title(serviceError(503, 'title service unavailable'));

    const response = await askTitle(services, 'user: hello');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: 'title service unavailable' });
    expect(() => services.verify()).not.toThrow();
  });

  it('fails verify for an unscripted title request and for scripted titles nobody asked for', async () => {
    const unscripted = track(createKimiServices());
    const response = await askTitle(unscripted, 'user: hello');
    expect(response.status).toBe(500);
    expect(() => unscripted.verify()).toThrow(/no title was scripted/);

    const unused = track(createKimiServices());
    unused.title('Never asked');
    expect(() => unused.verify()).toThrow(TestkitError);
    expect(() => unused.verify()).toThrow(/1 scripted title reply was never requested/);
  });

  it('rejects a tools call that is not chat_title', async () => {
    const services = track(createKimiServices());
    services.title('Unused');

    const response = await postJson(services, '/tools', { method: 'web_search', params: {} });

    expect(response.status).toBe(400);
    expect(services.problems()).toEqual([expect.stringMatching(/not a chat_title call/)]);
  });

  it('holds the next title request until the test releases it', async () => {
    const services = track(createKimiServices());
    services.title('Late title');
    const hold = services.holdNext('title');

    const pending = askTitle(services, 'user: hello');
    const reached = await hold.reached();
    expect(reached.json).toEqual({ method: 'chat_title', params: { chat_content: 'user: hello' } });
    expect(hold.isReached).toBe(true);
    expect(() => services.verify()).toThrow(/a hold on title request #0 was reached but never released/);

    hold.release();

    expect(await (await pending).json()).toEqual({ title: 'Late title' });
    expect(() => services.verify()).not.toThrow();
  });

  it('lets a held request go when the client aborts it', async () => {
    const services = track(createKimiServices());
    services.title('Never delivered');
    const hold = services.holdNext('title');
    const controller = new AbortController();

    const pending = askTitle(services, 'user: hello', { signal: controller.signal });
    await hold.reached();
    controller.abort(new Error('client gave up'));

    await expect(pending).rejects.toThrow('client gave up');
    expect(services.requests('title')).toHaveLength(1);
    expect(() => services.verify()).not.toThrow();
  });

  it('fails verify for a hold that no request reached', () => {
    const services = track(createKimiServices());
    services.holdNext('storage');

    expect(() => services.verify()).toThrow(/a hold on the next storage request was never reached/);
  });

  it('checks the bearer token when one is configured', async () => {
    const services = track(createKimiServices({ accessToken: 'expected' }));

    const response = await postJson(services, '/tools', { method: 'chat_title', params: { chat_content: 'x' } }, 'wrong');

    expect(response.status).toBe(401);
    expect(services.problems()).toEqual([expect.stringMatching(/wrong access token/)]);
  });
});

describe('fake Kimi services: feedback', () => {
  it('runs submit, update, upload and completion over real HTTP and keeps the uploaded bytes', async () => {
    const services = track(await startKimiServices({ accessToken: 'token' }));
    expect(services.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/coding\/v1$/);

    const submitted = await postJson(services, '/feedback', { content: 'it broke', session_id: 's1' });
    expect(await submitted.json()).toEqual({ feedback_id: 1 });

    expect((await postJson(services, '/feedback/update', { feedback_id: 1, phase: 'uploading' })).status).toBe(200);

    const uploadUrl = await postJson(services, '/feedback/upload_url', { feedback_id: 1, file_size: 3 });
    const { upload } = (await uploadUrl.json()) as { upload: { id: number; parts: Array<{ part_number: number; url: string; size: number; method: string }> } };
    expect(upload.parts).toEqual([{ part_number: 1, url: `${services.origin}/storage/1`, size: 3, method: 'PUT' }]);

    const stored = await fetch(upload.parts[0]!.url, { method: 'PUT', body: new Uint8Array([0, 255, 7]) });
    expect(stored.status).toBe(200);
    expect(stored.headers.get('etag')).toBe('"testkit-etag-1"');

    expect((await postJson(services, '/feedback/upload_complete', { upload_id: 1, parts: [{ part_number: 1, etag: '"testkit-etag-1"' }] })).status).toBe(200);

    const [feedback] = services.feedback();
    expect(feedback?.body).toEqual({ content: 'it broke', session_id: 's1' });
    expect(feedback?.updates).toEqual([{ feedback_id: 1, phase: 'uploading' }]);
    expect(feedback?.uploads[0]?.bytes).toEqual(new Uint8Array([0, 255, 7]));
    expect(feedback?.uploads[0]?.completion).toEqual({ upload_id: 1, parts: [{ part_number: 1, etag: '"testkit-etag-1"' }] });
    expect(() => services.verify()).not.toThrow();
  });

  it('flags an upload completed before storage, with the wrong etag, or for an unknown upload', async () => {
    const services = track(createKimiServices());
    await postJson(services, '/feedback', { content: 'x' });
    await postJson(services, '/feedback/upload_url', { feedback_id: 1, file_size: 1 });
    await postJson(services, '/feedback/upload_complete', { upload_id: 1, parts: [{ part_number: 1, etag: '"testkit-etag-1"' }] });
    await services.fetch(`${services.origin}/storage/1`, { method: 'PUT', body: 'x' });
    await postJson(services, '/feedback/upload_complete', { upload_id: 1, parts: [{ part_number: 1, etag: '"other"' }] });
    const unknown = await postJson(services, '/feedback/upload_complete', { upload_id: 9, parts: [] });

    expect(unknown.status).toBe(409);
    expect(services.problems()).toEqual([
      'upload 1 was completed before its bytes reached storage',
      'upload_complete for upload 1 sent etags ["\\"other\\""], expected ["\\"testkit-etag-1\\""]',
      'upload_complete names upload 9, which no upload_url request created',
    ]);
  });

  it('answers 409 for feedback the caller does not own, without recording a problem', async () => {
    const services = track(createKimiServices());

    const response = await postJson(services, '/feedback/update', { feedback_id: 42 });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: 'not owned or expired' });
    expect(services.problems()).toEqual([]);
  });

  it('refuses storage requests that carry an Authorization header or use the wrong method', async () => {
    const services = track(createKimiServices());
    services.uploadMethod('POST');
    await postJson(services, '/feedback', { content: 'x' });
    const { upload } = (await (await postJson(services, '/feedback/upload_url', { feedback_id: 1, file_size: 1 })).json()) as { upload: { parts: Array<{ url: string; method: string }> } };
    const part = upload.parts[0]!;
    expect(part.method).toBe('POST');

    const withToken = await services.fetch(part.url, { method: 'POST', headers: { authorization: 'Bearer token' }, body: 'x' });
    const wrongMethod = await services.fetch(part.url, { method: 'PUT', body: 'x' });

    expect(withToken.status).toBe(403);
    expect(wrongMethod.status).toBe(405);
    expect(services.problems()).toEqual([
      expect.stringMatching(/carried an Authorization header/),
      expect.stringMatching(/used PUT, but the upload URL was signed for POST/),
    ]);
  });
});

describe('fake Kimi services: unknown requests', () => {
  it('answers unknown requests with 404 and fails verify', async () => {
    const services = track(createKimiServices());

    const response = await services.fetch(`${services.baseUrl}/usages`);

    expect(response.status).toBe(404);
    expect(() => services.verify()).toThrow(/unexpected request GET \/coding\/v1\/usages/);
  });
});
