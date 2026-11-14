import { z } from 'zod';

export const contextGroupSchema = z.object({
  role: z.string().min(1),
  count: z.number().int().nonnegative(),
  chars: z.number().int().nonnegative(),
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
  total_chars: z.number().int().nonnegative(),
  groups: z.array(contextGroupSchema),
});
export type ContextSummary = z.infer<typeof contextSummarySchema>;

export const contextItemSummarySchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  name: z.string().optional(),
  sequence: z.number().int().positive().optional(),
  preview: z.string(),
  chars: z.number().int().nonnegative(),
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

export interface ContextItemPart {
  kind: string;
  text?: string;
  name?: string;
  id?: string;
  failed?: boolean;
  data?: unknown;
  children?: ContextItemPart[];
}

export const contextItemPartSchema: z.ZodType<ContextItemPart> = z.lazy(() =>
  z.object({
    kind: z.string().min(1),
    text: z.string().optional(),
    name: z.string().optional(),
    id: z.string().optional(),
    failed: z.boolean().optional(),
    data: z.unknown().optional(),
    children: z.array(contextItemPartSchema).optional(),
  }),
);

export const contextItemDetailSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  name: z.string().optional(),
  sequence: z.number().int().positive().optional(),
  chars: z.number().int().nonnegative(),
  has_media: z.boolean(),
  parts: z.array(contextItemPartSchema),
  raw: z.unknown(),
});
export type ContextItemDetail = z.infer<typeof contextItemDetailSchema>;
