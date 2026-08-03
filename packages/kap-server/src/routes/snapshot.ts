/**
 * `GET /sessions/{session_id}/snapshot` — atomic session snapshot for client
 * rebuild: state + `as_of_seq` watermark + `epoch`, assembled from the engine
 * services. Cold sessions are resumed through `ISessionLifecycleService.resume`
 * — the same path `messages` and `:undo` use — and the message page comes from
 * the shared full-transcript loader (`services/messages/messageHistory`), so
 * this endpoint and `GET /sessions/{sid}/messages` serve the same history:
 * full across compactions, media rehydrated.
 *
 * **Error mapping**: `SnapshotNotFoundError` → 40401; everything else falls
 * through to the global error handler (→ 50001).
 */

import {
  ensureMainAgent,
  IAgentPromptService,
  ISessionContext,
  ISessionInteractionService,
  ISessionMetadata,
  IWorkspaceService,
  resumeSessionById,
  type IAgentScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  sessionSnapshotResponseSchema,
  type InFlightTurn,
  type SessionSnapshotResponse,
} from '../protocol/rest-snapshot';
import { loadMessageHistory } from '../services/messages/messageHistory';
import { type SessionEventBroadcaster } from '../transport/ws/v1/sessionEventBroadcaster';
import { toWireApproval } from './approvals';
import { toWireQuestion } from './questions';
import { resolveSessionFacts, toWireSession } from './sessions';

/** Most-recent messages included in the snapshot page. */
const SNAPSHOT_MESSAGE_PAGE_SIZE = 100;

/** Sentinel — the handler maps it to 40401. */
class SnapshotNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} does not exist`);
    this.name = 'SnapshotNotFoundError';
  }
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

interface SnapshotRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; params: { session_id: string } },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export interface SnapshotRouteDeps {
  readonly core: Scope;
  readonly broadcaster: SessionEventBroadcaster;
}

export function registerSnapshotRoutes(app: SnapshotRouteHost, deps: SnapshotRouteDeps): void {
  const { core, broadcaster } = deps;

  const route = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/snapshot',
      params: sessionIdParamSchema,
      success: { data: sessionSnapshotResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.INTERNAL_ERROR]: {},
      },
      description:
        'Atomic session snapshot for client rebuild: state + as_of_seq watermark + epoch',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      try {
        const data = await assembleSnapshot(core, broadcaster, session_id);
        reply.send(okEnvelope(data, req.id));
      } catch (err) {
        if (err instanceof SnapshotNotFoundError) {
          reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, req.id, err.stack));
          return;
        }
        throw err;
      }
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<SnapshotRouteHost['get']>[2]);
}

async function assembleSnapshot(
  core: Scope,
  broadcaster: SessionEventBroadcaster,
  sessionId: string,
): Promise<SessionSnapshotResponse> {
  // Resolve the live handle, loading the session from disk when it is cold
  // (created by a previous process or by v1). `resume` returns `undefined`
  // only when the session is unknown or its workspace is gone → 404.
  const handle = await resumeSessionById(core.accessor, sessionId);
  if (handle === undefined) {
    throw new SnapshotNotFoundError(sessionId);
  }

  // Watermark + in-flight turn (drains the dispatch queue for consistency).
  const snapState = await broadcaster.getSnapshotState(sessionId);

  // Session wire shape (needs the workspace root for `metadata.cwd`).
  // `ISessionMetadata` normalizes legacy v1 documents on load (absent
  // `version` → ISO-string timestamps → epoch ms, id backfilled), so the
  // metadata read here is always v2-shaped and safe to project.
  const workspaceId = handle.accessor.get(ISessionContext).workspaceId;
  const workspace = await core.accessor.get(IWorkspaceService).get(workspaceId);
  const cwd = workspace?.root ?? '';
  const meta = await handle.accessor.get(ISessionMetadata).read();
  const session = toWireSession(
    { ...meta, workspaceId },
    cwd,
    resolveSessionFacts(core, sessionId),
  );

  // Messages — most recent page of the main agent's full history, from the
  // loader shared with the `messages` routes.
  const main = await ensureMainAgent(handle);
  const all = await loadMessageHistory(core, main, sessionId, meta.createdAt);
  const hasMore = all.length > SNAPSHOT_MESSAGE_PAGE_SIZE;
  const items = all.slice(-SNAPSHOT_MESSAGE_PAGE_SIZE);

  const currentPromptId = snapState.inFlightTurn === null ? undefined : readCurrentPromptId(main);
  const inFlightTurn = attachCurrentPromptIdToInFlight(snapState.inFlightTurn, currentPromptId);

  // Pending approvals / questions.
  const interaction = handle.accessor.get(ISessionInteractionService);
  const pendingApprovals = interaction
    .listPending('approval')
    .map((i) => toWireApproval(i, sessionId));
  const pendingQuestions = interaction
    .listPending('question')
    .map((i) => toWireQuestion(i, sessionId));

  return {
    as_of_seq: snapState.seq,
    epoch: snapState.epoch,
    session,
    messages: { items, has_more: hasMore },
    in_flight_turn: inFlightTurn,
    subagents: snapState.subagents,
    pending_approvals: pendingApprovals,
    pending_questions: pendingQuestions,
  };
}

function readCurrentPromptId(main: IAgentScopeHandle | undefined): string | undefined {
  if (main === undefined) return undefined;
  try {
    return main.accessor.get(IAgentPromptService).list().active?.id;
  } catch {
    // Auxiliary reconnect metadata must not make the whole snapshot fail.
    return undefined;
  }
}

function attachCurrentPromptIdToInFlight(
  inFlightTurn: InFlightTurn | null,
  currentPromptId: string | undefined,
): InFlightTurn | null {
  if (inFlightTurn === null || currentPromptId === undefined) return inFlightTurn;
  return { ...inFlightTurn, current_prompt_id: currentPromptId };
}
