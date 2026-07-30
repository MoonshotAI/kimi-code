/**
 *   POST /v1/feedback
 *   POST /v1/feedback/upload_url
 *   POST /v1/feedback/upload_complete
 *
 * Wire shapes for the user feedback endpoint. The wire uses snake_case (REST
 * convention in this repo). Submissions are forwarded to the managed
 * collection backend with the managed provider's OAuth token (see
 * `src/services/feedback/`); `content` / `contact` / `info` / `session_id`
 * match the backend's metadata contract, and the attachment routes mirror
 * its presigned-upload flow verbatim.
 */

import { z } from 'zod';

/** Feedback category: bug report, feature request, or anything else. */
export const feedbackTypeSchema = z.enum(['bug', 'feature', 'other']);
export type FeedbackType = z.infer<typeof feedbackTypeSchema>;

/** Attached diagnostics: nothing extra, local logs, or local logs plus the codebase. */
export const feedbackDiagnosticsSchema = z.enum(['none', 'logs', 'logs_and_codebase']);
export type FeedbackDiagnostics = z.infer<typeof feedbackDiagnosticsSchema>;

const feedbackInfoReservedKeys = ['type', 'title', 'diagnostics', 'agent_id'] as const;
const feedbackInfoSchema = z.record(z.string(), z.unknown()).superRefine((info, ctx) => {
  for (const key of feedbackInfoReservedKeys) {
    if (Object.hasOwn(info, key)) {
      ctx.addIssue({
        code: 'custom',
        message: `${key} is reserved; use the top-level field instead`,
        path: [key],
      });
    }
  }
});

export const feedbackSubmitBodySchema = z.object({
  content: z.string().min(1).max(20000),
  session_id: z.string().min(1).max(256),
  type: feedbackTypeSchema.optional(),
  title: z.string().min(1).max(256).optional(),
  contact: z.string().min(1).max(256).optional(),
  diagnostics: feedbackDiagnosticsSchema.optional(),
  agent_id: z.string().min(1).max(256).optional(),
  info: feedbackInfoSchema.optional(),
});
export type FeedbackSubmitBody = z.infer<typeof feedbackSubmitBodySchema>;

export const feedbackSubmitResponseSchema = z.object({
  feedback_id: z.number().int(),
});
export type FeedbackSubmitResponse = z.infer<typeof feedbackSubmitResponseSchema>;

export const feedbackUploadUrlBodySchema = z.object({
  feedback_id: z.number().int(),
  file_name: z.string().min(1).max(256),
  file_size: z.number().int().nonnegative(),
  file_hash: z.string().min(1).max(128),
});
export type FeedbackUploadUrlBody = z.infer<typeof feedbackUploadUrlBodySchema>;

export const feedbackUploadPartSchema = z.object({
  part_number: z.number().int(),
  url: z.string(),
  method: z.string(),
  size: z.number().int(),
});

export const feedbackUploadUrlResponseSchema = z.object({
  upload_id: z.number().int(),
  parts: z.array(feedbackUploadPartSchema),
});
export type FeedbackUploadUrlResponse = z.infer<typeof feedbackUploadUrlResponseSchema>;

export const feedbackUploadCompleteBodySchema = z.object({
  upload_id: z.number().int(),
  parts: z.array(z.object({ part_number: z.number().int(), etag: z.string().min(1) })).min(1),
});
export type FeedbackUploadCompleteBody = z.infer<typeof feedbackUploadCompleteBodySchema>;
