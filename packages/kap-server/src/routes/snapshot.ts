import {
  AGENT_WIRE_RECORD_KEY,
  IAgentContextMemoryService,
  IAgentPromptService,
  IAgentScopeContext,
  IAppendLogStore,
  ISessionContext,
  ISessionInteractionService,
  ISessionMetadata,
  IWireService,
  IWorkspaceService,
  createContextTranscriptReducer,
  deriveSpineState,
  ensureMainAgent,
  epochStartupNodeId,
  isRootEpoch,
  resumeSessionById,
  spineTreeViewFromState,
  type ContextMessage,
  type IAgentScopeHandle,
  type Scope,
  type SpineTreeNodeView,
  type WireRecord,
} from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  sessionSnapshotResponseSchema,
  type InFlightTurn,
  type SessionSnapshotResponse,
  type SpineTreeNode,
  type SpineTreeView,
} from '../protocol/rest-snapshot';
import { loadMessageHistory } from '../services/messages/messageHistory';
import { type SessionEventBroadcaster } from '../transport/ws/v1/sessionEventBroadcaster';
import { toWireApproval } from './approvals';
import { toWireQuestion } from './questions';
import { resolveSessionFacts, toWireSession } from './sessions';

const SNAPSHOT_MESSAGE_PAGE_SIZE = 100;

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
  const handle = await resumeSessionById(core.accessor, sessionId);
  if (handle === undefined) {
    throw new SnapshotNotFoundError(sessionId);
  }

  const snapState = await broadcaster.getSnapshotState(sessionId);

  const workspaceId = handle.accessor.get(ISessionContext).workspaceId;
  const workspace = await core.accessor.get(IWorkspaceService).get(workspaceId);
  const cwd = workspace?.root ?? '';
  const meta = await handle.accessor.get(ISessionMetadata).read();
  const session = toWireSession(
    { ...meta, workspaceId },
    cwd,
    resolveSessionFacts(core, sessionId),
  );

  const main = await ensureMainAgent(handle);
  const all = await loadMessageHistory(core, main, sessionId, meta.createdAt);
  const hasMore = all.length > SNAPSHOT_MESSAGE_PAGE_SIZE;
  const items = all.slice(-SNAPSHOT_MESSAGE_PAGE_SIZE);
  const spineTree = deriveSpineTree(await loadContextHistory(core, main), items);

  const currentPromptId = snapState.inFlightTurn === null ? undefined : readCurrentPromptId(main);
  const inFlightTurn = attachCurrentPromptIdToInFlight(snapState.inFlightTurn, currentPromptId);

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
    spine_tree: spineTree,
    pending_approvals: pendingApprovals,
    pending_questions: pendingQuestions,
  };
}

function readCurrentPromptId(main: IAgentScopeHandle | undefined): string | undefined {
  if (main === undefined) return undefined;
  try {
    return main.accessor.get(IAgentPromptService).list().active?.id;
  } catch {
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

async function loadContextHistory(
  core: Scope,
  agent: IAgentScopeHandle,
): Promise<readonly ContextMessage[]> {
  await agent.accessor.get(IWireService).flush();
  const scope = agent.accessor.get(IAgentScopeContext).scope();
  const reducer = createContextTranscriptReducer();
  for await (const record of core.accessor
    .get(IAppendLogStore)
    .read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY)) {
    reducer.add(record);
  }
  const transcript = reducer.result();
  const live = agent.accessor.get(IAgentContextMemoryService).get();
  if (live.length <= transcript.foldedLength) return transcript.entries;
  return [...transcript.entries, ...live.slice(transcript.foldedLength)];
}

/**
 * Spine task tree derived from the COMPLETE (pre-window) transcript, adapted
 * from the engine's recursive camelCase view (`spineTreeViewFromState`) to
 * the flat snake_case wire shape. Synthetic scaffolding (root-epoch nodes and
 * each epoch's startup node) is flattened away, its real children re-attached
 * to the nearest emitted ancestor, so a session without spine activity seeds
 * an empty node list. Fail-open: a derivation failure returns `undefined`
 * (the client falls back to replaying the messages window) instead of failing
 * the snapshot. `covered_through_id` is the wire id of the LAST message in
 * the sliced `items` page — never a full-transcript index, which would
 * misalign the client's coverage watermark.
 */
export function deriveSpineTree(
  messages: readonly ContextMessage[],
  items: readonly { id: string }[],
): SpineTreeView | undefined {
  try {
    const state = deriveSpineState(messages);
    const view = spineTreeViewFromState(state);
    const nodes: SpineTreeNode[] = [];
    const walk = (views: readonly SpineTreeNodeView[], parentId: string | null): void => {
      for (const node of views) {
        if (isRootEpoch(node.id) || node.id === epochStartupNodeId(epochOf(node.id))) {
          walk(node.children, parentId);
          continue;
        }
        nodes.push({
          id: node.id,
          parent_id: parentId,
          title: node.summary,
          memory: state.nodes[node.id]?.memory ?? '',
          token_cost: node.tokenCost ?? 0,
          status: node.closed ? 'closed' : 'active',
          error: null,
        });
        walk(node.children, node.id);
      }
    };
    walk(view.nodes, null);
    return { covered_through_id: items.at(-1)?.id ?? null, nodes };
  } catch {
    return undefined;
  }
}

function epochOf(id: string): number {
  return Number(id.split('.')[0]);
}
