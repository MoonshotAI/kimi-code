/**
 * Live-server invariant for uploaded image files in prompt content (v1 REST
 * surface only — file upload has no `/api/v2` equivalent):
 *   - a missing prompt image `file_id` returns `FILE_NOT_FOUND`;
 *   - a non-image uploaded file used as image content returns `VALIDATION_FAILED`;
 *   - an uploaded PNG can be referenced by a prompt submission, and the
 *     prompt can be aborted (or was already terminal).
 *
 * Converted from the retired scenario `09-image-file-prompts.ts`. Skips when
 * no server is reachable at `KIMI_SERVER_URL`.
 */
import { describe, expect, it } from 'vitest';

import { ErrorCode } from '@moonshot-ai/protocol';

import { DaemonClient, EnvelopeError } from '../harness/index.js';
import { fetchWithReport } from '../harness/report.js';
import { createCaseLogger } from './log.js';

const BASE_URL = process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58627';
const API_PREFIX = '/api/v1';
const SHORT_TIMEOUT_MS = 15_000;

const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

async function daemonReachable(): Promise<boolean> {
  try {
    const res = await fetchWithReport(`${BASE_URL}${API_PREFIX}/meta`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const reachable = await daemonReachable();
const describeLive = reachable ? describe : describe.skip;

describeLive('legacy: image file prompts', () => {
  it('missing/non-image files rejected, PNG accepted, prompt abortable', async () => {
    const log = createCaseLogger('legacy: image file prompts');
    const client = new DaemonClient({ baseUrl: BASE_URL });
    const files: string[] = [];
    let sid: string | undefined;

    async function expectEnvelopeCode(
      action: () => Promise<unknown>,
      code: ErrorCode,
      label: string,
    ): Promise<void> {
      let caught: unknown;
      try {
        await action();
      } catch (error) {
        caught = error;
      }
      expect(caught, label).toBeInstanceOf(EnvelopeError);
      expect((caught as EnvelopeError).code, label).toBe(code);
      log(label, { code: (caught as EnvelopeError).code });
    }

    try {
      const session = await client.createSession({
        title: 'klient-e2e image file prompts',
        metadata: { cwd: process.cwd(), scenario: 'image-file-prompts' },
      });
      sid = session.id;
      log('session created', { session_id: sid });

      await expectEnvelopeCode(
        () =>
          client.submitPrompt(sid!, {
            content: [{ type: 'image', source: { kind: 'file', file_id: 'file_missing_e2e' } }],
          }),
        ErrorCode.FILE_NOT_FOUND,
        'missing prompt image file_id',
      );

      const textFile = await client.uploadFile({
        name: 'not-an-image.txt',
        data: 'not an image',
        mediaType: 'text/plain',
      });
      files.push(textFile.id);
      await expectEnvelopeCode(
        () =>
          client.submitPrompt(sid!, {
            content: [{ type: 'image', source: { kind: 'file', file_id: textFile.id } }],
          }),
        ErrorCode.VALIDATION_FAILED,
        'non-image prompt file_id',
      );

      const png = await client.uploadFile({
        name: 'tiny.png',
        data: ONE_BY_ONE_PNG,
        mediaType: 'image/png',
      });
      files.push(png.id);
      expect(png.media_type).toBe('image/png');
      expect(png.size).toBe(ONE_BY_ONE_PNG.length);

      const submit = await client.submitPrompt(sid, {
        content: [
          { type: 'text', text: 'Reply with the single word "OK" after reading this image.' },
          { type: 'image', source: { kind: 'file', file_id: png.id } },
        ],
      });
      expect(submit.prompt_id.length).toBeGreaterThan(0);
      log('prompt submitted', { file_id: png.id, prompt_id: submit.prompt_id });

      try {
        await client.abortPrompt(sid, submit.prompt_id);
        log('prompt aborted', { prompt_id: submit.prompt_id });
      } catch (error) {
        if (
          error instanceof EnvelopeError &&
          (error.code === ErrorCode.PROMPT_ALREADY_COMPLETED ||
            error.code === ErrorCode.PROMPT_NOT_FOUND)
        ) {
          log('prompt already terminal before abort', { prompt_id: submit.prompt_id });
        } else {
          throw error;
        }
      }
      await client.waitForSessionBusy(sid, false, { timeoutMs: SHORT_TIMEOUT_MS });
    } finally {
      for (const fileId of files.toReversed()) {
        try {
          await client.deleteFile(fileId);
        } catch {
          // ignore
        }
      }
      try {
        if (sid) await client.archiveSession(sid);
      } catch {
        // ignore
      }
      await client.close();
    }
  }, 120_000);
});
