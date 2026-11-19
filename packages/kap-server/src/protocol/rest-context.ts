import { z } from 'zod';

export const contextGroupSchema = z.object({
  role: z.string().min(1),
  count: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
});
export type ContextGroup = z.infer<typeof contextGroupSchema>;

export const contextTokensSchema = z.object({
  used: z.number().int().nonnegative(),
  max: z.number().int().nonnegative().optional(),
});
export type ContextTokens = z.infer<typeof contextTokensSchema>;

export const contextSummarySchema = z.object({
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  captured_at: z.number().int().nonnegative(),
  model: z.string().optional(),
  tokens: contextTokensSchema,
  groups: z.array(contextGroupSchema),
});
export type ContextSummary = z.infer<typeof contextSummarySchema>;

export const contextItemSegmentSchema = z.enum(['thinking', 'reply', 'tool_call']);
export type ContextItemSegment = z.infer<typeof contextItemSegmentSchema>;

export const contextItemSummarySchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  segment: contextItemSegmentSchema.optional(),
  name: z.string().optional(),
  sequence: z.number().int().positive().optional(),
  preview: z.string(),
  tokens: z.number().int().nonnegative(),
  has_media: z.boolean(),
});
export type ContextItemSummary = z.infer<typeof contextItemSummarySchema>;

export const contextItemsResponseSchema = z.object({
  summary: contextSummarySchema,
  tools: z.array(contextItemSummarySchema),
  items: z.array(contextItemSummarySchema),
  total: z.number().int().nonnegative(),
  has_more: z.boolean(),
});
export type ContextItemsResponse = z.infer<typeof contextItemsResponseSchema>;

export const contextItemPartSchema = z.object({
  kind: z.enum(['text', 'think', 'definition', 'function', 'media']),
  text: z.string().optional(),
  name: z.string().optional(),
  tokens: z.number().int().nonnegative().optional(),
  data: z.unknown().optional(),
});
export type ContextItemPart = z.infer<typeof contextItemPartSchema>;

export const contextItemDetailSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  segment: contextItemSegmentSchema.optional(),
  name: z.string().optional(),
  sequence: z.number().int().positive().optional(),
  tokens: z.number().int().nonnegative(),
  has_media: z.boolean(),
  parts: z.array(contextItemPartSchema),
  raw: z.unknown(),
});
export type ContextItemDetail = z.infer<typeof contextItemDetailSchema>;
