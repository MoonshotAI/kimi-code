#!/usr/bin/env node
/**
 * Scenario 09 — uploaded image files in prompt content.
 *
 * Exercises:
 *   - missing prompt image file_id returns FILE_NOT_FOUND
 *   - non-image uploaded file used as image content returns VALIDATION_FAILED
 *   - uploaded PNG can be referenced by a prompt submission
 */
import assert from 'node:assert/strict';

import { ErrorCode } from '@moonshot-ai/protocol';

import { DaemonClient, EnvelopeError } from '../src/index';

const KIMI_SERVER_URL = process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58627';
const SHORT_TIMEOUT_MS = 15_000;

const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

async function main() {
  console.log(`▶ server at ${KIMI_SERVER_URL}`);
  const client = new DaemonClient({ baseUrl: KIMI_SERVER_URL });
  const files: string[] = [];
  let sid: string | undefined;

  try {
    const session = await client.createSession({
      title: 'server-e2e image file prompts',
      metadata: { cwd: process.cwd(), scenario: '09-image-file-prompts' },
    });
    sid = session.id;
    console.log(`▶ image-file: session ${sid} created`);

    await expectEnvelopeCode(
      () =>
        client.submitPrompt(sid!, {
          content: [
            {
              type: 'image',
              source: { kind: 'file', file_id: 'file_missing_daemon_e2e' },
            },
          ],
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
          content: [
            {
              type: 'image',
              source: { kind: 'file', file_id: textFile.id },
            },
          ],
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
    assert.equal(png.media_type, 'image/png');
    assert.equal(png.size, ONE_BY_ONE_PNG.length);

    const submit = await client.submitPrompt(sid, {
      content: [
        { type: 'text', text: 'Reply with the single word "OK" after reading this image.' },
        { type: 'image', source: { kind: 'file', file_id: png.id } },
      ],
    });
    assert.ok(submit.prompt_id.length > 0, 'image file prompt returns a prompt_id');
    console.log(`▶ image-file: uploaded ${png.id} and submitted prompt ${submit.prompt_id}`);

    let terminalStatus: 'idle' | 'aborted' = 'idle';
    try {
      await client.abortPrompt(sid, submit.prompt_id);
      terminalStatus = 'aborted';
      console.log(`▶ image-file: prompt ${submit.prompt_id} aborted after submit`);
    } catch (error) {
      if (
        error instanceof EnvelopeError &&
        (error.code === ErrorCode.PROMPT_ALREADY_COMPLETED ||
          error.code === ErrorCode.PROMPT_NOT_FOUND)
      ) {
        console.log(`▶ image-file: prompt ${submit.prompt_id} was already terminal before abort`);
      } else {
        throw error;
      }
    }
    await client.waitForSessionStatus(sid, terminalStatus, { timeoutMs: SHORT_TIMEOUT_MS });

    console.log('✓ 09-image-file-prompts: image file prompt references round-tripped');
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
}

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
  assert.ok(caught instanceof EnvelopeError, `${label}: expected EnvelopeError`);
  assert.equal(caught.code, code, `${label}: expected code ${code}, got ${caught.code}`);
  console.log(`▶ image-file: ${label} returned code=${caught.code}`);
}

main().catch((err) => {
  console.error('✗ 09-image-file-prompts failed:', err);
  process.exit(1);
});
