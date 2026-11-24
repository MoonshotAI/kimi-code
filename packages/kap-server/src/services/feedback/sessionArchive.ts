import { writeFile } from 'node:fs/promises';
import { z } from 'zod';

import { envelopeSchema } from '../../protocol/envelope';
import { ErrorCode } from '../../protocol/error-codes';
import { feedbackSessionArchiveResponseSchema } from '../../protocol/rest-feedback';
import { DEVICE_RPC_MAX_BODY_BYTES } from '../../transport/jsonlRpcStream';
import type { DeviceHttpResponse, DeviceSession } from '../devices/deviceSession';
import { FeedbackError } from './feedbackService';

export const FEEDBACK_ARCHIVE_LIMIT = 500 * 1024 * 1024;

const archiveEnvelope = envelopeSchema(feedbackSessionArchiveResponseSchema.extend({ size: z.unknown() }));
const archiveErrors = [
  ErrorCode.AUTH_TOKEN_MISSING, ErrorCode.AUTH_TOKEN_UNAUTHORIZED, ErrorCode.FEEDBACK_REJECTED,
  ErrorCode.VALIDATION_FAILED, ErrorCode.SESSION_NOT_FOUND, ErrorCode.FILE_TOO_LARGE,
];

function readArchiveReference(response: DeviceHttpResponse) {
  let envelope: z.infer<typeof archiveEnvelope>;
  try {
    envelope = archiveEnvelope.parse(JSON.parse(response.body.toString('utf8')));
  } catch {
    throw new FeedbackError(ErrorCode.INTERNAL_ERROR, 'The device returned an invalid archive response.');
  }
  const { code, data } = envelope;
  if (response.status !== 200 || code !== 0 || data === null) {
    const errorCode = archiveErrors.find(known => known === code) ?? ErrorCode.INTERNAL_ERROR;
    throw new FeedbackError(errorCode, 'The device could not prepare the session archive.');
  }
  return data;
}

async function* readArchiveRanges(session: DeviceSession, path: string, size: number, signal: AbortSignal): AsyncGenerator<Buffer> {
  for (let start = 0; start < size; start += DEVICE_RPC_MAX_BODY_BYTES) {
    signal.throwIfAborted();
    const end = Math.min(start + DEVICE_RPC_MAX_BODY_BYTES, size) - 1;
    const response = await session.request({
      method: 'GET', path, headers: { range: `bytes=${start}-${end}` }, signal, timeoutMs: Infinity,
    });
    signal.throwIfAborted();
    const length = end - start + 1;
    const declaredLength = response.headers['content-length'];
    if (
      response.status !== 206 || response.headers['content-range'] !== `bytes ${start}-${end}/${size}` ||
      response.body.length !== length || (declaredLength !== undefined && Number(declaredLength) !== length)
    ) {
      throw new FeedbackError(ErrorCode.INTERNAL_ERROR, 'The device returned an incomplete session archive.');
    }
    yield response.body;
  }
}

export async function fetchRemoteFeedbackArchive(session: DeviceSession, sessionId: string, outputPath: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const response = await session.request({
    method: 'POST', path: '/api/v1/feedback/session-archives', headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ session_id: sessionId })), signal, timeoutMs: Infinity,
  });
  const archive = readArchiveReference(response);
  const path = `/api/v1/files/${encodeURIComponent(archive.file_id)}`;
  try {
    if (typeof archive.size === 'number' && archive.size > FEEDBACK_ARCHIVE_LIMIT) {
      throw new FeedbackError(ErrorCode.FILE_TOO_LARGE, 'The feedback attachment is too large.');
    }
    const size = feedbackSessionArchiveResponseSchema.shape.size.safeParse(archive.size);
    if (!size.success) throw new FeedbackError(ErrorCode.INTERNAL_ERROR, 'The device returned an invalid archive size.');
    await writeFile(outputPath, readArchiveRanges(session, path, size.data, signal), { flag: 'wx', mode: 0o600, signal });
  } finally {
    await session.request({ method: 'DELETE', path, headers: {} }).catch(() => undefined);
  }
  signal.throwIfAborted();
}
