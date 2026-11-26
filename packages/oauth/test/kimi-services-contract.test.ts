import { serviceError, startKimiServices, type KimiServices } from '@moonshot-ai/testkit/services';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fetchCompleteFeedbackUpload, fetchCreateFeedbackUploadUrl } from '../src/managed-feedback-upload';
import { fetchSubmitFeedback, fetchUpdateFeedback, kimiCodeFeedbackUrl } from '../src/managed-feedback';
import { fetchChatTitle, kimiCodeToolsUrl } from '../src/managed-tools';

const ACCESS_TOKEN = 'contract-token';

let services: KimiServices;

beforeEach(async () => {
  services = await startKimiServices({ accessToken: ACCESS_TOKEN });
});

afterEach(async () => {
  await services.close();
});

describe('the testkit Kimi services answer the real managed clients', () => {
  it('session titles', async () => {
    services.title('Fix the login bug', serviceError(503, 'title service unavailable'));
    const url = kimiCodeToolsUrl(services.baseUrl);

    const ok = await fetchChatTitle(url, ACCESS_TOKEN, 'user: the login page crashes');
    const failed = await fetchChatTitle(url, ACCESS_TOKEN, 'user: again');

    expect(ok).toEqual({ kind: 'ok', title: 'Fix the login bug' });
    expect(failed).toEqual({ kind: 'error', status: 503, message: 'title service unavailable' });
    expect(services.requests('title')[0]?.json).toEqual({ method: 'chat_title', params: { chat_content: 'user: the login page crashes' } });
    services.verify();
  });

  it('a held session title that the caller aborts', async () => {
    services.title('Too late');
    const controller = new AbortController();
    const hold = services.holdNext('title');

    const pending = fetchChatTitle(kimiCodeToolsUrl(services.baseUrl), ACCESS_TOKEN, 'user: hello', { signal: controller.signal });
    await hold.reached();
    controller.abort();

    expect(await pending).toEqual({ kind: 'error', message: 'Failed to generate session title: request aborted.' });
    hold.release();
    services.verify();
  });

  it('feedback with an uploaded attachment', async () => {
    const feedbackUrl = kimiCodeFeedbackUrl(services.baseUrl);
    const attachment = new Uint8Array([80, 75, 3, 4, 0, 255]);

    const submitted = await fetchSubmitFeedback(feedbackUrl, ACCESS_TOKEN, { content: 'it broke', version: '1.0.0', os: 'darwin', model: null, session_id: 's1' });
    expect(submitted).toEqual({ kind: 'ok', feedbackId: 1 });
    expect(await fetchUpdateFeedback(feedbackUrl, ACCESS_TOKEN, { feedback_id: 1, info: { phase: 'uploading' } })).toEqual({ kind: 'ok' });

    const upload = await fetchCreateFeedbackUploadUrl(
      ACCESS_TOKEN,
      { feedback_id: 1, file_name: 'repo.zip', file_hash: 'hash', file_size: attachment.byteLength },
      { feedbackUrl },
    );
    if (upload.kind !== 'ok') throw new Error(upload.message);
    const [part] = upload.parts;
    if (part === undefined) throw new Error('the upload has no parts');
    const stored = await fetch(part.url, { method: part.method, body: attachment });
    const etag = stored.headers.get('etag') ?? '';

    const completed = await fetchCompleteFeedbackUpload(ACCESS_TOKEN, { upload_id: upload.upload_id, parts: [{ part_number: part.part_number, etag }] }, { feedbackUrl });

    expect(completed).toEqual({ kind: 'ok' });
    const [feedback] = services.feedback();
    expect(feedback?.body).toMatchObject({ content: 'it broke', session_id: 's1' });
    expect(feedback?.updates).toEqual([{ feedback_id: 1, info: { phase: 'uploading' } }]);
    expect(feedback?.uploads[0]?.bytes).toEqual(attachment);
    services.verify();
  });

  it('feedback the caller no longer owns', async () => {
    const result = await fetchUpdateFeedback(kimiCodeFeedbackUrl(services.baseUrl), ACCESS_TOKEN, { feedback_id: 404, content: 'late edit' });

    expect(result).toEqual({ kind: 'error', status: 409, message: 'not owned or expired' });
    services.verify();
  });
});
