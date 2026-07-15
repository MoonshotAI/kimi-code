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
 *   POST    /v1/sessions/{id}:restore     -                     data: Session
 */

import { z } from 'zod';

import { messageSchema } from '@moonshot-ai/agent-core-v2/agent/contextMemory/protocolMessage';
import {
  sessionStatusResponseSchema,
  sessionWarningSchema,
  sessionWarningsResponseSchema,
  sessionStatusSchema,
  updateSessionProfileRequestSchema,
  type UpdateSessionProfileRequest,
} from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';

import { goalSnapshotSchema } from './goal';
import { cursorQuerySchema, pageResponseSchema } from './pagination';
import {
  sessionChildCreateSchema,
  sessionCreateSchema,
  sessionForkSchema,
  sessionSchema,
} from './session';

export {
  sessionStatusResponseSchema,
  sessionStatusSchema,
  sessionWarningSchema,
  sessionWarningsResponseSchema,
  updateSessionProfileRequestSchema,
};
export type {
  SessionStatus,
  SessionStatusResponse,
  SessionWarning,
  SessionWarningsResponse,
  UpdateSessionProfileRequest,
} from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';

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
    archived_only: booleanQueryParam,
    exclude_empty: booleanQueryParam,
  }),
);
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;

export const getSessionResponseSchema = sessionSchema;
export type GetSessionResponse = z.infer<typeof getSessionResponseSchema>;

export const getSessionProfileResponseSchema = sessionSchema;
export type GetSessionProfileResponse = z.infer<typeof getSessionProfileResponseSchema>;

export const MAX_SESSION_EXPORT_WEB_LOG_BYTES = 256 * 1024;

export const exportSessionParamsSchema = z.object({
  session_id: z.string().min(1),
});
export type ExportSessionParams = z.infer<typeof exportSessionParamsSchema>;

export const exportSessionRequestSchema = z
  .object({
    web_log: z
      .string()
      .refine((value) => fitsUtf8ByteLimit(value, MAX_SESSION_EXPORT_WEB_LOG_BYTES), {
        message: `web_log must not exceed ${MAX_SESSION_EXPORT_WEB_LOG_BYTES} UTF-8 bytes`,
      })
      .optional(),
  })
  .strict();
export type ExportSessionRequest = z.infer<typeof exportSessionRequestSchema>;

export const updateSessionProfileResponseSchema = sessionSchema;
export type UpdateSessionProfileResponse = z.infer<typeof updateSessionProfileResponseSchema>;

export const updateSessionMetaRequestSchema = updateSessionProfileRequestSchema;
export type UpdateSessionMetaRequest = UpdateSessionProfileRequest;

export const updateSessionMetaResponseSchema = updateSessionProfileResponseSchema;
export type UpdateSessionMetaResponse = UpdateSessionProfileResponse;

export const updateSessionRequestSchema = updateSessionProfileRequestSchema;
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

// Child lists intentionally omit exclude_empty: the /sessions/{id}/children route
// does not filter by it, so advertising it would mislead generated clients.
export const listSessionChildrenQuerySchema = cursorQuerySchema.and(
  z.object({
    status: sessionStatusSchema.optional(),
    include_archive: booleanQueryParam,
  }),
);
export type ListSessionChildrenQuery = z.infer<typeof listSessionChildrenQuerySchema>;

export const listSessionChildrenResponseSchema = pageResponseSchema(sessionSchema);
export type ListSessionChildrenResponse = z.infer<typeof listSessionChildrenResponseSchema>;

export const createSessionChildRequestSchema = sessionChildCreateSchema;
export type CreateSessionChildRequest = z.infer<typeof createSessionChildRequestSchema>;

export const createSessionChildResponseSchema = sessionSchema;
export type CreateSessionChildResponse = z.infer<typeof createSessionChildResponseSchema>;

// GET /sessions/{id}/goal — the session's current goal snapshot (camelCase,
// same shape as the `goal.updated` WS event payload), or null when none is
// active.
export const getSessionGoalResponseSchema = goalSnapshotSchema.nullable();
export type GetSessionGoalResponse = z.infer<typeof getSessionGoalResponseSchema>;

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

export const restoreSessionResponseSchema = sessionSchema;
export type RestoreSessionResponse = z.infer<typeof restoreSessionResponseSchema>;

/** @deprecated kept as an alias for backward compatibility; prefer archiveSessionResponseSchema. */
export const deleteSessionResponseSchema = archiveSessionResponseSchema;
/** @deprecated kept as an alias for backward compatibility; prefer ArchiveSessionResponse. */
export type DeleteSessionResponse = ArchiveSessionResponse;

export const sessionAbortResponseSchema = z.object({
  aborted: z.boolean(),
});
export type SessionAbortResponse = z.infer<typeof sessionAbortResponseSchema>;

function fitsUtf8ByteLimit(value: string, limit: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index)!;
    if (codePoint < 0x80) {
      bytes += 1;
    } else if (codePoint < 0x800) {
      bytes += 2;
    } else if (codePoint > 0xffff) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
    if (bytes > limit) return false;
  }
  return true;
}
