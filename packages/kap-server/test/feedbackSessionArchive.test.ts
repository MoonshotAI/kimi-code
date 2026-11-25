import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errEnvelope, okEnvelope } from '../src/protocol/envelope';
import { ErrorCode } from '../src/protocol/error-codes';
import { fetchRemoteFeedbackArchive } from '../src/services/feedback/sessionArchive';
import type { DeviceHttpRequest, DeviceHttpResponse, DeviceSession } from '../src/services/devices/deviceSession';
import { DEVICE_RPC_MAX_BODY_BYTES } from '../src/transport/jsonlRpcStream';

const fileId = 'f_example';
const filePath = `/api/v1/files/${fileId}`;

function jsonResponse(value: unknown): DeviceHttpResponse {
  return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(value)) };
}

function device(request: DeviceSession['request']): DeviceSession {
  return { request, openWebSocket: () => { throw new Error('Unexpected WebSocket'); } };
}

describe('SSH feedback session archives', () => {
  let scratch: string;
  let outputPath: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'feedback-archive-test-'));
    outputPath = join(scratch, 'session.zip');
  });
  afterEach(() => rm(scratch, { recursive: true, force: true }));

  it('reads archives larger than one SSH response in bounded ranges and removes the remote file', async () => {
    const source = randomBytes(DEVICE_RPC_MAX_BODY_BYTES + 19);
    const requests: DeviceHttpRequest[] = [];
    const signal = new AbortController().signal;
    const session = device(async req => {
      requests.push(req);
      if (req.method === 'POST') {
        return jsonResponse(okEnvelope({ file_id: fileId, size: source.length }, 'example-request'));
      }
      if (req.method === 'DELETE') return jsonResponse(okEnvelope({ deleted: true }, 'example-request'));
      const match = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range));
      if (!match) throw new Error('Expected a byte range');
      const start = Number(match[1]);
      const end = Number(match[2]);
      const body = source.subarray(start, end + 1);
      if (body.length > DEVICE_RPC_MAX_BODY_BYTES) throw new Error('SSH response too large');
      return { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${source.length}`, 'content-length': body.length }, body };
    });

    await fetchRemoteFeedbackArchive(session, 'example-session', outputPath, signal);

    expect((await readFile(outputPath)).equals(source)).toBe(true);
    expect(requests[0]).toMatchObject({ method: 'POST', path: '/api/v1/feedback/session-archives', signal });
    expect(JSON.parse(requests[0]!.body!.toString())).toEqual({ session_id: 'example-session' });
    const reads = requests.slice(1, -1);
    expect(reads.length).toBeGreaterThan(1);
    expect(reads.every(req => req.method === 'GET' && req.path === filePath && req.signal === signal)).toBe(true);
    expect(requests.at(-1)).toMatchObject({ method: 'DELETE', path: filePath });
  });

  it.each([
    { status: 200, headers: { 'content-range': 'bytes 0-2/3' }, body: Buffer.from('abc') },
    { status: 206, headers: { 'content-range': 'bytes 1-3/4' }, body: Buffer.from('abc') },
    { status: 206, headers: { 'content-range': 'bytes 0-2/3' }, body: Buffer.from('ab') },
    { status: 206, headers: { 'content-range': 'bytes 0-2/3', 'content-length': '9' }, body: Buffer.from('abc') },
  ])('rejects an inconsistent range and removes the remote file', async response => {
    const request = vi.fn<DeviceSession['request']>()
      .mockResolvedValueOnce(jsonResponse(okEnvelope({ file_id: fileId, size: 3 }, 'example-request')))
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(jsonResponse(okEnvelope({ deleted: true }, 'example-request')));

    await expect(fetchRemoteFeedbackArchive(device(request), 'example-session', outputPath, new AbortController().signal))
      .rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR });
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'DELETE', path: filePath }));
  });

  it('deletes an oversized remote archive before downloading any part', async () => {
    const request = vi.fn<DeviceSession['request']>()
      .mockResolvedValueOnce(jsonResponse(okEnvelope({ file_id: fileId, size: 500 * 1024 * 1024 + 1 }, 'example-request')))
      .mockResolvedValueOnce(jsonResponse(okEnvelope({ deleted: true }, 'example-request')));

    await expect(fetchRemoteFeedbackArchive(device(request), 'example-session', outputPath, new AbortController().signal))
      .rejects.toMatchObject({ code: ErrorCode.FILE_TOO_LARGE });
    expect(request.mock.calls.map(([req]) => req.method)).toEqual(['POST', 'DELETE']);
  });

  it('rejects an invalid file ID before contacting the file service', async () => {
    const request = vi.fn<DeviceSession['request']>().mockResolvedValue(
      jsonResponse(okEnvelope({ file_id: 'example', size: 3 }, 'example-request')),
    );
    await expect(fetchRemoteFeedbackArchive(device(request), 'example-session', outputPath, new AbortController().signal))
      .rejects.toMatchObject({ code: ErrorCode.INTERNAL_ERROR });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('honors cancellation and still releases the remote archive', async () => {
    const cancel = new AbortController();
    const request = vi.fn<DeviceSession['request']>()
      .mockResolvedValueOnce(jsonResponse(okEnvelope({ file_id: fileId, size: 3 }, 'example-request')))
      .mockImplementationOnce(async req => {
        expect(req.signal).toBe(cancel.signal);
        cancel.abort();
        return { status: 206, headers: { 'content-range': 'bytes 0-2/3', 'content-length': '3' }, body: Buffer.from('abc') };
      })
      .mockResolvedValueOnce(jsonResponse(okEnvelope({ deleted: true }, 'example-request')));

    await expect(fetchRemoteFeedbackArchive(device(request), 'example-session', outputPath, cancel.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(request.mock.lastCall?.[0]).toMatchObject({ method: 'DELETE', path: filePath });
    expect(request.mock.lastCall?.[0].signal?.aborted).not.toBe(true);
  });

  it.each([ErrorCode.AUTH_TOKEN_MISSING, ErrorCode.FEEDBACK_REJECTED, ErrorCode.SESSION_NOT_FOUND])(
    'preserves the remote archive error code %d and omits upstream details', async code => {
      const detail = 'Example upstream detail';
      const request = vi.fn<DeviceSession['request']>().mockResolvedValue(jsonResponse(errEnvelope(code, detail, 'example-request')));
      await expect(fetchRemoteFeedbackArchive(device(request), 'example-session', outputPath, new AbortController().signal))
        .rejects.toMatchObject({ code, message: expect.not.stringContaining(detail) });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
});
