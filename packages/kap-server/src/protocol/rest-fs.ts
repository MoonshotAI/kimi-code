/**
 * The `fs:open` / `fs:open_in` / `fs:reveal` request schemas — the only fs
 * wire shapes the engine does not own (the `sessionFs` domain in agent-core-v2
 * holds the rest). Also home of `fsOpenInAppIdSchema`, referenced by the
 * `/v1/meta` capabilities document.
 */

import { z } from 'zod';

export const fsOpenRequestSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
});
export type FsOpenRequest = z.infer<typeof fsOpenRequestSchema>;

export const fsOpenResponseSchema = z.object({
  opened: z.literal(true),
});
export type FsOpenResponse = z.infer<typeof fsOpenResponseSchema>;

export const fsRevealRequestSchema = z.object({
  path: z.string().min(1),
});
export type FsRevealRequest = z.infer<typeof fsRevealRequestSchema>;

export const fsRevealResponseSchema = z.object({
  revealed: z.literal(true),
});
export type FsRevealResponse = z.infer<typeof fsRevealResponseSchema>;

export const fsOpenInAppIdSchema = z.enum([
  'finder',
  'cursor',
  'vscode',
  'iterm',
  'terminal',
]);
export type FsOpenInAppId = z.infer<typeof fsOpenInAppIdSchema>;

export const fsOpenInRequestSchema = z.object({
  app_id: fsOpenInAppIdSchema,
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
});
export type FsOpenInRequest = z.infer<typeof fsOpenInRequestSchema>;

export const fsOpenInResponseSchema = z.object({
  opened: z.literal(true),
});
export type FsOpenInResponse = z.infer<typeof fsOpenInResponseSchema>;

export const fsDownloadParamsSchema = z.object({
  path: z.string().min(1),
  range: z.string().optional(),
  if_none_match: z.string().optional(),
});
export type FsDownloadParams = z.infer<typeof fsDownloadParamsSchema>;
