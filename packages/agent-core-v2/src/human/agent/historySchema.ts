import { z } from 'zod';

import type { HistoryMessage } from './turn';

const textPartSchema = z.object({ type: z.literal('text'), text: z.string() });
const thinkPartSchema = z.object({
  type: z.literal('think'),
  think: z.string(),
  encrypted: z.string().optional(),
  detailsIndex: z.number().optional(),
});
const imageUrlPartSchema = z.object({
  type: z.literal('image_url'),
  imageUrl: z.object({ url: z.string(), id: z.string().optional(), name: z.string().optional() }),
});
const audioUrlPartSchema = z.object({
  type: z.literal('audio_url'),
  audioUrl: z.object({ url: z.string(), id: z.string().optional() }),
});
const videoUrlPartSchema = z.object({
  type: z.literal('video_url'),
  videoUrl: z.object({ url: z.string(), id: z.string().optional(), name: z.string().optional() }),
});

export const contentPartSchema = z.discriminatedUnion('type', [
  textPartSchema,
  thinkPartSchema,
  imageUrlPartSchema,
  audioUrlPartSchema,
  videoUrlPartSchema,
]);

const toolDescriptionSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  deferred: z.literal(true).optional(),
});

const toolCallSchema = z.object({
  type: z.literal('function'),
  id: z.string(),
  name: z.string(),
  arguments: z.string().nullable(),
  extras: z.record(z.string(), z.unknown()).optional(),
  rawId: z.string().optional(),
  _streamIndex: z.union([z.number(), z.string()]).optional(),
});

export const systemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.array(contentPartSchema),
  tools: z.array(toolDescriptionSchema).optional(),
});

export const userMessageSchema = z.object({
  role: z.literal('user'),
  content: z.array(contentPartSchema),
});

export const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.array(contentPartSchema),
  toolCalls: z.array(toolCallSchema),
});

export const toolMessageSchema = z.object({
  role: z.literal('tool'),
  content: z.array(contentPartSchema),
  toolCallId: z.string(),
});

const tokenUsageSchema = z.object({
  inputOther: z.number(),
  output: z.number(),
  inputCacheRead: z.number(),
  inputCacheCreation: z.number(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

const finishInfoSchema = z.object({
  finishReason: z.enum(['completed', 'tool_calls', 'truncated', 'filtered', 'paused', 'other']).nullable(),
  rawFinishReason: z.string().nullable(),
});

const entryMetaSchema = z.object({ source: z.string().optional(), key: z.string().optional() });

const assistantMetaSchema = entryMetaSchema.extend({
  model: z.object({ provider: z.string(), model: z.string() }).optional(),
  usage: tokenUsageSchema,
  headers: z.record(z.string(), z.string()).optional(),
  finish: finishInfoSchema.optional(),
  messageId: z.string().optional(),
});

export const historyMessageSchema = z.union([
  z.object({ message: systemMessageSchema, meta: entryMetaSchema }),
  z.object({ message: userMessageSchema, meta: entryMetaSchema }),
  z.object({ message: assistantMessageSchema, meta: assistantMetaSchema }),
  z.object({ message: toolMessageSchema, meta: entryMetaSchema }),
]) as z.ZodType<HistoryMessage>;
