/**
 * `GET /sessions/{session_id}/snapshot` — IM-style initial sync.
 *
 * **Reader strategy** (controlled by `KIMI_SNAPSHOT_READER`):
 *
 *   - `auto` (default) — delegate to `ISnapshotReader`, which reads
 *     `state.json` + `agents/main/wire.jsonl` directly from disk and bypasses
 *     the heavy `ISessionLifecycleService.resume` chain (DI scope, MCP connect,
 *     full wire replay). Sub-200ms warm / sub-1s cold.
 *   - `legacy` — fall back to `resume` + live service assembly. Pure operator
 *     escape hatch; no silent per-request fallback.
 *
 * **Timeout**: the auto path races against a hard `KIMI_SNAPSHOT_TIMEOUT_MS`
 * ceiling (default 4000ms, under traefik's 5s cut-off). Timeout returns 50001
 * with a structured `snapshot.timeout` log line so the gateway never sees a 499.
 *
 * **Error mapping**: `SnapshotNotFoundError` → 40401; `SnapshotTimeoutError` →
 * 50001; everything else falls through to the global error handler (→ 50001).
 */

import {
  IAgentContextMemoryService,
  IAgentLifecycleService,
  IAgentPromptService,
  ILogService,
  ISessionInteractionService,
  ISessionContext,
  ISessionLifecycleService,
  ISessionMetadata,
  IWorkspaceService,
  toProtocolMessage,
  type IAgentScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { Message } from '@moonshot-ai/agent-core-v2/agent/contextMemory/protocolMessage';
import { ErrorCode } from '../protocol/error-codes';
import {
  sessionSnapshotResponseSchema,
  type InFlightTurn,
  type SessionSnapshotResponse,
} from '../protocol/rest-snapshot';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import {
  SnapshotNotFoundError,
  SnapshotTimeoutError,
  loadSnapshotConfig,
} from '../services/snapshot';
import type { ISnapshotReader } from '../services/snapshot';
import { type SessionEventBroadcaster } from '../transport/ws/v1/sessionEventBroadcaster';
import { toWireApproval } from './approvals';
import { toWireQuestion } from './questions';
import { resolveSessionFacts, toWireSession } from './sessions';

/** Most-recent messages included in the snapshot page. */
const SNAPSHOT_MESSAGE_PAGE_SIZE = 100;

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
  readonly reader: ISnapshotReader;
}

export function registerSnapshotRoutes(app: SnapshotRouteHost, deps: SnapshotRouteDeps): void {
  const { core, broadcaster, reader } = deps;
  const config = loadSnapshotConfig();
  const useReader = config.mode !== 'legacy';

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
        const data = useReader
          ? await readViaReader(reader, session_id, config.timeoutMs)
          : await readViaLegacyAssembly(core, broadcaster, session_id);
        reply.send(okEnvelope(data, req.id));
      } catch (err) {
        if (err instanceof SnapshotNotFoundError) {
          reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, req.id, err.stack));
          return;
        }
        if (err instanceof SnapshotTimeoutError) {
          core.accessor
            .get(ILogService)
            .warn('snapshot.timeout', { sid: session_id, duration_ms: err.timeoutMs });
          reply.send(errEnvelope(ErrorCode.INTERNAL_ERROR, err.message, req.id, err.stack));
          return;
        }
        throw err;
      }
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<SnapshotRouteHost['get']>[2]);
}

async function readViaReader(
  reader: ISnapshotReader,
  sid: string,
  timeoutMs: number,
): Promise<SessionSnapshotResponse> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SnapshotTimeoutError(sid, timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([reader.read(sid), timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readViaLegacyAssembly(
  core: Scope,
  broadcaster: SessionEventBroadcaster,
  sessionId: string,
): Promise<SessionSnapshotResponse> {
  // Resolve the live handle, loading the session from disk when it is cold
  // (created by a previous process or by v1). `resume` returns `undefined`
  // only when the session is unknown or its workspace is gone → 404.
  const handle = await core.accessor.get(ISessionLifecycleService).resume(sessionId);
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

  // Messages — most recent page of the main agent's live history.
  const main = handle.accessor.get(IAgentLifecycleService).get('main');
  let items: Message[] = [];
  let hasMore = false;
  if (main !== undefined) {
    const history = main.accessor.get(IAgentContextMemoryService).get();
    hasMore = history.length > SNAPSHOT_MESSAGE_PAGE_SIZE;
    const page = history.slice(-SNAPSHOT_MESSAGE_PAGE_SIZE);
    const offset = history.length - page.length;
    items = page.map((msg, i) => toProtocolMessage(sessionId, offset + i, msg, meta.createdAt));
  }
  const currentPromptId =
    snapState.inFlightTurn === null ? undefined : readCurrentPromptId(main);
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
