import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';
import {
  sessionAgentConfigPartialSchema,
  sessionWarningSchema,
  sessionWarningsResponseSchema,
  updateSessionProfileRequestSchema as engineUpdateSessionProfileRequestSchema,
} from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';

import { ErrorCode } from './error-codes';
import { goalSnapshotSchema } from './goal';
import { cursorQuerySchema, pageResponseSchema } from './pagination';
import {
  creationOnlyProfileSchema,
  sessionActivitySchema,
  sessionChildCreateSchema,
  sessionCreateSchema,
  sessionForkSchema,
  sessionSchema,
} from './session';

export { sessionWarningSchema, sessionWarningsResponseSchema };
export type {
  SessionWarning,
  SessionWarningsResponse,
} from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';

export const updateSessionProfileRequestSchema = engineUpdateSessionProfileRequestSchema.extend({
  agent_config: sessionAgentConfigPartialSchema
    .extend({ profile: creationOnlyProfileSchema })
    .optional(),
});
export type UpdateSessionProfileRequest = z.infer<typeof updateSessionProfileRequestSchema>;

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

const repeatedParam = <T extends z.ZodTypeAny>(item: T) =>
  z.union([item, z.array(item).min(1)]).optional();

export const sessionsSortSchema = z.enum([
  'updated_at_desc',
  'updated_at_asc',
  'created_at_desc',
]);
export type SessionsSort = z.infer<typeof sessionsSortSchema>;

export const sessionsViewSchema = z.enum(['flat', 'by_workspace']);
export type SessionsView = z.infer<typeof sessionsViewSchema>;

export const sessionsArchivedFilterSchema = z.enum(['false', 'true', 'all']);
export type SessionsArchivedFilter = z.infer<typeof sessionsArchivedFilterSchema>;

const KNOWN_INCLUDE_DOMAINS = new Set(['git']);
const KNOWN_FIELDS = new Set(['id', 'archived']);
export const IDS_PROJECTION_PAGE_SIZE_MAX = 10000;
export const FULL_PAGE_SIZE_MAX = 100;
export const SESSIONS_BATCH_IDS_MAX = 5000;

export function parseSessionIncludeDomains(include: string | undefined): string[] {
  return (include ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function parseSessionFields(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ];
}

function isIdsProjection(fields: readonly string[]): boolean {
  return fields.length === 2 && fields.every((field) => KNOWN_FIELDS.has(field));
}

export const listSessionsQuerySchema = z
  .object({
    workspace_id: repeatedParam(z.string().min(1)),
    archived: sessionsArchivedFilterSchema.optional(),
    has_prompt: booleanQueryParam,
    busy: booleanQueryParam,
    activity: repeatedParam(sessionActivitySchema),
    updated_after: isoDateTimeSchema.optional(),
    updated_before: isoDateTimeSchema.optional(),
    sort: sessionsSortSchema.optional(),
    view: sessionsViewSchema.optional(),
    group_page_size: z.coerce.number().int().min(1).max(IDS_PROJECTION_PAGE_SIZE_MAX).optional(),
    include: z.string().optional(),
    fields: z.string().optional(),
    page_size: z.coerce.number().int().min(1).max(IDS_PROJECTION_PAGE_SIZE_MAX).optional(),
    page_token: z.string().min(1).optional(),
    page: z.coerce.number().int().min(1).optional(),
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    const cursorParams = [
      value.page_token !== undefined ? 'page_token' : undefined,
      value.page !== undefined ? 'page' : undefined,
      value.before_id !== undefined ? 'before_id' : undefined,
      value.after_id !== undefined ? 'after_id' : undefined,
    ].filter((entry): entry is string => entry !== undefined);
    if (cursorParams.length > 1) {
      ctx.addIssue({
        code: 'custom',
        message: `${cursorParams.join(' and ')} are mutually exclusive`,
        path: [cursorParams[0]!],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
    if (
      value.view === 'by_workspace' &&
      (value.before_id !== undefined || value.after_id !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: "before_id and after_id are not supported with view='by_workspace'",
        path: [value.before_id !== undefined ? 'before_id' : 'after_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
    for (const domain of parseSessionIncludeDomains(value.include)) {
      if (!KNOWN_INCLUDE_DOMAINS.has(domain)) {
        ctx.addIssue({
          code: 'custom',
          message: `unknown domain '${domain}'`,
          path: ['include'],
          params: { code: ErrorCode.VALIDATION_FAILED },
        });
      }
    }
    const fields = parseSessionFields(value.fields);
    for (const field of fields) {
      if (!KNOWN_FIELDS.has(field)) {
        ctx.addIssue({
          code: 'custom',
          message: `unknown field '${field}'`,
          path: ['fields'],
          params: { code: ErrorCode.VALIDATION_FAILED },
        });
      }
    }
    const projection = fields.length > 0 && fields.every((field) => KNOWN_FIELDS.has(field));
    if (projection && !isIdsProjection(fields)) {
      ctx.addIssue({
        code: 'custom',
        message: "unsupported fields projection; the only supported value is 'id,archived'",
        path: ['fields'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
    if (projection && parseSessionIncludeDomains(value.include).includes('git')) {
      ctx.addIssue({
        code: 'custom',
        message: 'include=git is not available with the ids projection',
        path: ['include'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
    const pageSizeMax = projection ? IDS_PROJECTION_PAGE_SIZE_MAX : FULL_PAGE_SIZE_MAX;
    if (value.page_size !== undefined && value.page_size > pageSizeMax) {
      ctx.addIssue({
        code: 'custom',
        message: projection
          ? `page_size must be at most ${IDS_PROJECTION_PAGE_SIZE_MAX}`
          : `page_size must be at most ${FULL_PAGE_SIZE_MAX} without the ids projection`,
        path: ['page_size'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
    if (value.group_page_size !== undefined) {
      if (value.view !== 'by_workspace') {
        ctx.addIssue({
          code: 'custom',
          message: "group_page_size requires view='by_workspace'",
          path: ['group_page_size'],
          params: { code: ErrorCode.VALIDATION_FAILED },
        });
      } else if (value.group_page_size > pageSizeMax) {
        ctx.addIssue({
          code: 'custom',
          message: projection
            ? `group_page_size must be at most ${IDS_PROJECTION_PAGE_SIZE_MAX}`
            : `group_page_size must be at most ${FULL_PAGE_SIZE_MAX} without the ids projection`,
          path: ['group_page_size'],
          params: { code: ErrorCode.VALIDATION_FAILED },
        });
      }
    }
  });
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;

export const sessionIdProjectionSchema = z.object({
  id: z.string().min(1),
  archived: z.boolean(),
});
export type SessionIdProjection = z.infer<typeof sessionIdProjectionSchema>;

export const listSessionsFlatResponseSchema = z.object({
  items: z.array(z.union([sessionSchema, sessionIdProjectionSchema])),
  total: z.number().int().nonnegative(),
  has_more: z.boolean(),
  next_page_token: z.string().min(1).optional(),
});
export type ListSessionsFlatResponse = z.infer<typeof listSessionsFlatResponseSchema>;

export const sessionWorkspaceGroupSchema = z.object({
  workspace_id: z.string().min(1),
  sessions: z.array(z.union([sessionSchema, sessionIdProjectionSchema])),
  total: z.number().int().nonnegative(),
});
export type SessionWorkspaceGroup = z.infer<typeof sessionWorkspaceGroupSchema>;

export const listSessionsGroupedResponseSchema = z.object({
  groups: z.array(sessionWorkspaceGroupSchema),
  total: z.number().int().nonnegative(),
  has_more: z.boolean(),
  next_page_token: z.string().min(1).optional(),
});
export type ListSessionsGroupedResponse = z.infer<typeof listSessionsGroupedResponseSchema>;

export const listSessionsResponseSchema = z.union([
  listSessionsFlatResponseSchema,
  listSessionsGroupedResponseSchema,
]);
export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;

export const batchSessionsRequestSchema = z
  .object({ ids: z.array(z.string().min(1)).min(1) })
  .superRefine((value, ctx) => {
    if (new Set(value.ids).size > SESSIONS_BATCH_IDS_MAX) {
      ctx.addIssue({
        code: 'custom',
        message: `ids must contain at most ${SESSIONS_BATCH_IDS_MAX} unique entries`,
        path: ['ids'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });
export type BatchSessionsRequest = z.infer<typeof batchSessionsRequestSchema>;

export const batchSessionsResponseSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      ok: z.boolean(),
      error: z.object({ code: z.number().int(), message: z.string() }).optional(),
    }),
  ),
  succeeded: z.number().int(),
  failed: z.number().int(),
});
export type BatchSessionsResponse = z.infer<typeof batchSessionsResponseSchema>;

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
    desktop: z.boolean().optional(),
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

export const predictPromptRequestSchema = z.object({
  prediction_id: z.string().min(1),
  expected_turn_id: z.number().int().nonnegative(),
});
export type PredictPromptRequest = z.infer<typeof predictPromptRequestSchema>;

export const predictPromptResponseSchema = z.object({
  prediction: z.string().nullable(),
});
export type PredictPromptResponse = z.infer<typeof predictPromptResponseSchema>;

export const cancelPromptPredictionRequestSchema = z.object({
  prediction_id: z.string().min(1),
  reason: z.enum([
    'input',
    'escape',
    'new_turn',
    'session',
    'dialog',
    'queue',
    'submit',
    'plan',
    'visibility',
    'shutdown',
    'disconnect',
    'activity_turn_started',
    'activity_turn_ended',
    'activity_background',
    'activity_interaction',
    'activity_agent_lifecycle',
    'agent_will_close',
    'agent_replaced',
    'agent_closed',
    'disposed',
    'unspecified',
  ]).optional(),
});
export type CancelPromptPredictionRequest = z.infer<typeof cancelPromptPredictionRequestSchema>;

export const cancelPromptPredictionResponseSchema = z.object({
  cancelled: z.boolean(),
});
export type CancelPromptPredictionResponse = z.infer<typeof cancelPromptPredictionResponseSchema>;

export const listSessionChildrenQuerySchema = cursorQuerySchema.and(
  z.object({
    busy: booleanQueryParam,
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

export const getSessionGoalResponseSchema = goalSnapshotSchema.nullable();
export type GetSessionGoalResponse = z.infer<typeof getSessionGoalResponseSchema>;

export const editSessionGoalRequestSchema = z.object({
  objective: z.string(),
});
export type EditSessionGoalRequest = z.infer<typeof editSessionGoalRequestSchema>;

export const editSessionGoalResponseSchema = goalSnapshotSchema;
export type EditSessionGoalResponse = z.infer<typeof editSessionGoalResponseSchema>;

export const compactSessionRequestSchema = z.preprocess(
  (value) => value === undefined ? {} : value,
  z.object({
    instruction: z.string().optional(),
  }),
);
export type CompactSessionRequest = z.infer<typeof compactSessionRequestSchema>;

export const compactSessionResponseSchema = z.object({});
export type CompactSessionResponse = z.infer<typeof compactSessionResponseSchema>;

export const undoSessionRequestSchema = z.object({
  turn_id: z.string().min(1),
  agent_id: z.string().min(1).optional(),
});
export type UndoSessionRequest = z.infer<typeof undoSessionRequestSchema>;

export const undoSessionResponseSchema = z.object({
  removed_turn_ids: z.array(z.string().min(1)),
});
export type UndoSessionResponse = z.infer<typeof undoSessionResponseSchema>;

export const archiveSessionResponseSchema = z.object({
  archived: z.literal(true),
});
export type ArchiveSessionResponse = z.infer<typeof archiveSessionResponseSchema>;

export const takeoverSessionResponseSchema = z.object({
  taken_over: z.literal(true),
});
export type TakeoverSessionResponse = z.infer<typeof takeoverSessionResponseSchema>;

export const restoreSessionResponseSchema = sessionSchema;
export type RestoreSessionResponse = z.infer<typeof restoreSessionResponseSchema>;

export const deleteSessionResponseSchema = z.object({
  deleted: z.literal(true),
});
export type DeleteSessionResponse = z.infer<typeof deleteSessionResponseSchema>;

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
