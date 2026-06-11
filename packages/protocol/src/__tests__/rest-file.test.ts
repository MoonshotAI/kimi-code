import { describe, expect, it } from 'vitest';

import {
  deleteFileParamSchema,
  deleteFileResponseSchema,
  getFileParamSchema,
  uploadFileResponseSchema,
  type DeleteFileResponse,
  type UploadFileResponse,
} from '../rest/file';

describe('uploadFileResponseSchema (POST /api/v1/files)', () => {
  it('round-trips a FileMeta payload', () => {
    const payload: UploadFileResponse = {
      id: '01JABCDEFGHJKMNPQRSTVWXYZ0',
      name: 'note.txt',
      media_type: 'text/plain',
      size: 12,
      created_at: '2026-06-04T10:00:00.000Z',
    };
    expect(uploadFileResponseSchema.parse(payload)).toEqual(payload);
  });
});

describe('getFileParamSchema (GET /api/v1/files/{file_id})', () => {
  it('accepts a non-empty file_id', () => {
    expect(getFileParamSchema.parse({ file_id: 'f_abc' }).file_id).toBe('f_abc');
  });

  it('rejects an empty file_id', () => {
    expect(getFileParamSchema.safeParse({ file_id: '' }).success).toBe(false);
  });
});

describe('deleteFileParamSchema + deleteFileResponseSchema (DELETE /api/v1/files/{file_id})', () => {
  it('accepts a non-empty file_id', () => {
    expect(deleteFileParamSchema.parse({ file_id: 'f_abc' }).file_id).toBe(
      'f_abc',
    );
  });

  it('rejects an empty file_id', () => {
    expect(deleteFileParamSchema.safeParse({ file_id: '' }).success).toBe(false);
  });

  it('response shape is exactly `{deleted: true}`', () => {
    const ok: DeleteFileResponse = { deleted: true };
    expect(deleteFileResponseSchema.parse(ok)).toEqual({ deleted: true });
  });

  it('rejects `{deleted: false}` (false-positive defence)', () => {
    expect(
      deleteFileResponseSchema.safeParse({ deleted: false }).success,
    ).toBe(false);
  });
});
