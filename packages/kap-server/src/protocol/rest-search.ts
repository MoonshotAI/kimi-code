/**
 *   POST /v1/search
 *
 * Wire shapes for the global message search endpoint. The wire uses
 * snake_case (REST convention in this repo); `routes/search.ts` maps to the
 * camelCase service contract in `src/search/contract.ts`.
 */

import { z } from 'zod';

export const searchMessagesBodySchema = z.object({
  query: z.string().min(1),
  mode: z.enum(['terms', 'literal']).optional(),
  op: z.enum(['AND', 'OR']).optional(),
  container: z
    .object({
      session_id: z.string().min(1).optional(),
      agent_id: z.string().min(1).optional(),
    })
    .optional(),
  role: z.enum(['user', 'assistant', 'title']).optional(),
  start_time: z.number().int().nonnegative().optional(),
  end_time: z.number().int().nonnegative().optional(),
  sort: z.enum(['score', 'time_desc', 'time_asc']).optional(),
  page_size: z.number().int().min(1).max(50).optional(),
  page_token: z.string().min(1).optional(),
});
export type SearchMessagesBody = z.infer<typeof searchMessagesBodySchema>;

export const searchMessageHitSchema = z.object({
  session_id: z.string(),
  workspace_id: z.string(),
  session_title: z.string(),
  agent_id: z.string(),
  role: z.enum(['user', 'assistant', 'title']),
  snippet: z.string(),
  time: z.number(),
  turn: z.number().int().nonnegative().optional(),
  step_id: z.string().optional(),
  score: z.number(),
});

export const searchMessagesResponseSchema = z.object({
  items: z.array(searchMessageHitSchema),
  has_more: z.boolean(),
  page_token: z.string().optional(),
  incomplete: z.enum(['candidate_cap']).optional(),
  index_state: z.object({
    state: z.enum(['building', 'ready', 'readonly']),
    indexed_sessions: z.number(),
    total_sessions: z.number(),
    documents: z.number(),
  }),
  source: z.enum(['live', 'index']),
});
export type SearchMessagesResponse = z.infer<typeof searchMessagesResponseSchema>;
