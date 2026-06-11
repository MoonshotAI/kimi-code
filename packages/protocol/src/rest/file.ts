/**
 *   POST   /v1/files
 *     Request: multipart/form-data with `file` (binary), `name`
 *              (optional override), `expires_in_sec` (optional).
 *     Response data: `FileMeta` (full envelope).
 *     Errors: 41301 (>50MB).
 *
 *   GET    /v1/files/{file_id}
 *     Response: binary stream or envelope (40407 / 41003).
 *
 *   DELETE /v1/files/{file_id}
 *     Response data: `{deleted: true}` (envelope-wrapped).
 *     Errors: 40407.
 */

import { z } from 'zod';

import { fileMetaSchema } from '../file';

export const uploadFileResponseSchema = fileMetaSchema;
export type UploadFileResponse = z.infer<typeof uploadFileResponseSchema>;

export const getFileParamSchema = z.object({
  file_id: z.string().min(1),
});
export type GetFileParam = z.infer<typeof getFileParamSchema>;

export const deleteFileParamSchema = z.object({
  file_id: z.string().min(1),
});
export type DeleteFileParam = z.infer<typeof deleteFileParamSchema>;

export const deleteFileResponseSchema = z.object({
  deleted: z.literal(true),
});
export type DeleteFileResponse = z.infer<typeof deleteFileResponseSchema>;
