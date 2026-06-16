/**
 *   POST    /v1/sessions                  body: SessionCreate   data: Session
 *   GET     /v1/sessions                  query: ListSessions   data: Page<Session>
 *   GET     /v1/sessions/{id}             -                     data: Session
 *   GET     /v1/sessions/{id}/profile     -                     data: Session
 *   POST    /v1/sessions/{id}/profile     body: SessionUpdate   data: Session
 *   POST    /v1/sessions/{id}:fork        body: SessionFork     data: Session
 *   POST    /v1/sessions/{id}:btw         -                     data: StartBtwSession
 *   GET     /v1/sessions/{id}/children    query: ListSessions   data: Page<Session>
 *   POST    /v1/sessions/{id}/children    body: SessionChild    data: Session
 *   GET     /v1/sessions/{id}/status      -                     data: SessionStatus
 *   POST    /v1/sessions/{id}:compact     body: CompactSession  data: {}
 *   POST    /v1/sessions/{id}:undo        body: UndoSession     data: UndoSession
 *   POST    /v1/sessions/{id}:archive     -                     data: { archived: true }
 */

import { z } from 'zod';

import { messageSchema } from '../message';
import { cursorQuerySchema, pageResponseSchema } from '../pagination';
import {
  sessionChildCreateSchema,
  sessionCreateSchema,
  sessionForkSchema,
  sessionSchema,
  sessionStatusSchema,
  sessionUpdateSchema,
} from '../session';

export const createSessionRequestSchema = sessionCreateSchema;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const createSessionResponseSchema = sessionSchema;
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

const booleanQueryParam = z.preprocess(
  (value) => {
    if (value === 'true' || value === '1' || value === 1 || value === true) return true;
    if (value === 'false' || value === '0' || value === 0 || value === false) return false;
    return value;
  },
  z.boolean().optional(),
);

export const listSessionsQuerySchema = cursorQuerySchema.and(
  z.object({
    status: sessionStatusSchema.optional(),
    include_archive: booleanQueryParam,
  }),
);
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;

export const getSessionResponseSchema = sessionSchema;
export type GetSessionResponse = z.infer<typeof getSessionResponseSchema>;

export const getSessionProfileResponseSchema = sessionSchema;
export type GetSessionProfileResponse = z.infer<typeof getSessionProfileResponseSchema>;

export const updateSessionProfileRequestSchema = sessionUpdateSchema;
export type UpdateSessionProfileRequest = z.infer<typeof updateSessionProfileRequestSchema>;

export const updateSessionProfileResponseSchema = sessionSchema;
export type UpdateSessionProfileResponse = z.infer<typeof updateSessionProfileResponseSchema>;

export const updateSessionMetaRequestSchema = updateSessionProfileRequestSchema;
export type UpdateSessionMetaRequest = UpdateSessionProfileRequest;

export const updateSessionMetaResponseSchema = updateSessionProfileResponseSchema;
export type UpdateSessionMetaResponse = UpdateSessionProfileResponse;

export const updateSessionRequestSchema = sessionUpdateSchema;
export type UpdateSessionRequest = z.infer<typeof updateSessionRequestSchema>;

export const updateSessionResponseSchema = sessionSchema;
export type UpdateSessionResponse = z.infer<typeof updateSessionResponseSchema>;

export const forkSessionRequestSchema = sessionForkSchema;
export type ForkSessionRequest = z.infer<typeof forkSessionRequestSchema>;

export const forkSessionResponseSchema = sessionSchema;
export type ForkSessionResponse = z.infer<typeof forkSessionResponseSchema>;

export const startBtwSessionResponseSchema = z.object({
  agent_id: z.string().min(1),
});
export type StartBtwSessionResponse = z.infer<typeof startBtwSessionResponseSchema>;

export const listSessionChildrenQuerySchema = listSessionsQuerySchema;
export type ListSessionChildrenQuery = z.infer<typeof listSessionChildrenQuerySchema>;

export const listSessionChildrenResponseSchema = pageResponseSchema(sessionSchema);
export type ListSessionChildrenResponse = z.infer<typeof listSessionChildrenResponseSchema>;

export const createSessionChildRequestSchema = sessionChildCreateSchema;
export type CreateSessionChildRequest = z.infer<typeof createSessionChildRequestSchema>;

export const createSessionChildResponseSchema = sessionSchema;
export type CreateSessionChildResponse = z.infer<typeof createSessionChildResponseSchema>;

export const sessionStatusResponseSchema = z.object({
  status: sessionStatusSchema,
  model: z.string().optional(),
  thinking_level: z.string(),
  permission: z.string(),
  plan_mode: z.boolean(),
  swarm_mode: z.boolean(),
  context_tokens: z.number().int().nonnegative(),
  max_context_tokens: z.number().int().nonnegative(),
  context_usage: z.number().min(0).max(1),
});
export type SessionStatusResponse = z.infer<typeof sessionStatusResponseSchema>;

export const compactSessionRequestSchema = z.preprocess(
  (value) => value === undefined ? {} : value,
  z.object({
    instruction: z.string().optional(),
  }),
);
export type CompactSessionRequest = z.infer<typeof compactSessionRequestSchema>;

export const compactSessionResponseSchema = z.object({});
export type CompactSessionResponse = z.infer<typeof compactSessionResponseSchema>;

export const undoSessionRequestSchema = z.preprocess(
  (value) => value === undefined ? {} : value,
  z.object({
    count: z.number().int().positive().default(1),
    page_size: z.number().int().min(1).max(100).optional(),
  }),
);
export type UndoSessionRequest = z.infer<typeof undoSessionRequestSchema>;

export const undoSessionResponseSchema = z.object({
  messages: pageResponseSchema(messageSchema),
  status: sessionStatusResponseSchema,
});
export type UndoSessionResponse = z.infer<typeof undoSessionResponseSchema>;

export const archiveSessionResponseSchema = z.object({
  archived: z.literal(true),
});
export type ArchiveSessionResponse = z.infer<typeof archiveSessionResponseSchema>;

/** @deprecated kept as an alias for backward compatibility; prefer archiveSessionResponseSchema. */
export const deleteSessionResponseSchema = archiveSessionResponseSchema;
/** @deprecated kept as an alias for backward compatibility; prefer ArchiveSessionResponse. */
export type DeleteSessionResponse = ArchiveSessionResponse;

export const sessionAbortResponseSchema = z.object({
  aborted: z.boolean(),
});
export type SessionAbortResponse = z.infer<typeof sessionAbortResponseSchema>;
