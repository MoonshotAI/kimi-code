/**
 *   POST   /v1/files                  (multipart upload)
 *   GET    /v1/files/{file_id}        (binary stream)
 *   DELETE /v1/files/{file_id}
 */

import { z } from 'zod';

import { fileMetaSchema } from '@moonshot-ai/agent-core-v2/app/file/fileService';

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
