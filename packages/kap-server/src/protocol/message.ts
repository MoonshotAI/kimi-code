import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

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
  z.object({ kind: z.literal('session_media'), file_id: z.string().min(1) }),
  z.object({ kind: z.literal('path'), path: z.string().min(1) }),
]);
export type ImageSource = z.infer<typeof imageSourceSchema>;

export const imageContentSchema = z.object({
  type: z.literal('image'),
  source: imageSourceSchema,
});
export type ImageContent = z.infer<typeof imageContentSchema>;

export const videoContentSchema = z.object({
  type: z.literal('video'),
  source: imageSourceSchema,
});
export type VideoContent = z.infer<typeof videoContentSchema>;

export const fileContentSchema = z
  .object({
    type: z.literal('file'),
    file_id: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    name: z.string().optional(),
    media_type: z.string().min(1).optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .superRefine((part, ctx) => {
    const hasFileId = part.file_id !== undefined;
    const hasPath = part.path !== undefined;
    if (hasFileId === hasPath) {
      ctx.addIssue({
        code: 'custom',
        message: 'exactly one of file_id or path is required',
        path: hasFileId ? ['path'] : ['file_id'],
      });
      return;
    }
    if (hasPath) return;
    for (const key of ['name', 'media_type', 'size'] as const) {
      if (part[key] === undefined) {
        ctx.addIssue({ code: 'custom', message: `${key} is required with file_id`, path: [key] });
      }
    }
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
