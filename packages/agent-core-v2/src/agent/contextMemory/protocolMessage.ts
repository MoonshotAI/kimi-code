/**
 * The wire `Message` shape — the legacy REST/streaming message format served
 * on the `messages`, `snapshot`, and `sessions` (`:undo`) edge surfaces.
 * Defined next to `messageProjection.ts`, which projects `ContextMessage`
 * into this shape; consumed by the `messageLegacy` edge adapter and the
 * transports.
 *
 * Media sources come in three kinds: `url`, `base64`, and `file` (a daemon
 * upload id). The `url` kind optionally pairs an `id` — the provider-issued
 * file id behind a reference such as `ms://…` — forwarded on the wire when
 * the provider keys media by id.
 */

import { z } from 'zod';

import { isoDateTimeSchema } from '#/_base/utils/isoDateTime';

export const messageRoleSchema = z.enum(['user', 'assistant', 'tool', 'system']);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const textContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});
export type TextContent = z.infer<typeof textContentSchema>;

export const toolUseContentSchema = z.object({
  type: z.literal('tool_use'),
  tool_call_id: z.string().min(1),
  tool_name: z.string().min(1),
  input: z.unknown(),
});
export type ToolUseContent = z.infer<typeof toolUseContentSchema>;

export const toolResultContentSchema = z.object({
  type: z.literal('tool_result'),
  tool_call_id: z.string().min(1),
  output: z.unknown(),
  is_error: z.boolean().optional(),
});
export type ToolResultContent = z.infer<typeof toolResultContentSchema>;

export const imageSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('url'),
    url: z.string().min(1),
    id: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('base64'),
    media_type: z.string().min(1),
    data: z.string().min(1),
  }),
  z.object({ kind: z.literal('file'), file_id: z.string().min(1) }),
]);
export type ImageSource = z.infer<typeof imageSourceSchema>;

export const imageContentSchema = z.object({
  type: z.literal('image'),
  source: imageSourceSchema,
});
export type ImageContent = z.infer<typeof imageContentSchema>;

// Video uses the same source shape as image (url / base64 / uploaded file id).
export const videoContentSchema = z.object({
  type: z.literal('video'),
  source: imageSourceSchema,
});
export type VideoContent = z.infer<typeof videoContentSchema>;

export const fileContentSchema = z.object({
  type: z.literal('file'),
  file_id: z.string().min(1),
  name: z.string(),
  media_type: z.string().min(1),
  size: z.number().int().nonnegative(),
});
export type FileContent = z.infer<typeof fileContentSchema>;

export const thinkingContentSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string().optional(),
});
export type ThinkingContent = z.infer<typeof thinkingContentSchema>;

export const messageContentSchema = z.discriminatedUnion('type', [
  textContentSchema,
  toolUseContentSchema,
  toolResultContentSchema,
  imageContentSchema,
  videoContentSchema,
  fileContentSchema,
  thinkingContentSchema,
]);
export type MessageContent = z.infer<typeof messageContentSchema>;

export const messageSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  role: messageRoleSchema,
  content: z.array(messageContentSchema),
  created_at: isoDateTimeSchema,
  prompt_id: z.string().min(1).optional(),
  parent_message_id: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type Message = z.infer<typeof messageSchema>;
