/**
 *   POST   /v1/files                  (multipart upload)
 *   GET    /v1/files/{file_id}        (binary stream)
 *   DELETE /v1/files/{file_id}
 */

import { z } from 'zod';

import { isoDateTimeSchema } from './message';

/**
 * Locally-owned file-meta schema (stage 4: protocol localisation) — copied
 * from the v2 `app/file/fileService` so kap-server no longer imports it.
 */
export const fileMetaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  media_type: z.string().min(1),
  size: z.number().int().nonnegative(),
  created_at: isoDateTimeSchema,
  expires_at: isoDateTimeSchema.optional(),
});
export type FileMeta = z.infer<typeof fileMetaSchema>;

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
