import {
  AGENT_WIRE_RECORD_KEY,
  IAgentContextMemoryService,
  IAgentPromptService,
  IAgentScopeContext,
  IAppendLogStore,
  INTERACTION_TAG_SESSION_ID,
  ISessionContext,
  ISessionMetadata,
  IWireService,
  IWorkspaceService,
  createContextTranscriptReducer,
  deriveSpineState,
  interactions,
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
import { ensureMainAgent } from '../transport/mainAgent';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  sessionSnapshotResponseSchema,
  type InFlightTurn,
  type SessionSnapshotResponse,
  type SpineTreeNode,
  type SpineTreeView,
} from '../protocol/rest-snapshot';
import { emptySessionUsage, type SessionUsage } from '../protocol/session';
import {
  readLegacyStatus,
  type LegacyStatusSnapshot,
} from '../services/legacyStatus/legacyStatus';
import { loadMessageHistory } from '../services/messages/messageHistory';
import { type SessionEventBroadcaster } from '../transport/ws/v1/sessionEventBroadcaster';
import { toWireApproval } from './approvals';
import { toWireQuestion } from '../protocol/question-wire';
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
      } catch (error) {
        if (error instanceof SnapshotNotFoundError) {
          reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, error.message, req.id, error.stack));
          return;
        }
        throw error;
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

  const main = await ensureMainAgent(handle);
  const status = readLegacyStatus(main);
  const session = {
    ...toWireSession(
      { ...meta, workspaceId },
      cwd,
      resolveSessionFacts(core, sessionId),
    ),
    agent_config: { model: status?.model ?? '' },
    usage: toSnapshotUsage(status),
  };

  const all = await loadMessageHistory(core, main, sessionId, meta.createdAt);
  const hasMore = all.length > SNAPSHOT_MESSAGE_PAGE_SIZE;
  const items = all.slice(-SNAPSHOT_MESSAGE_PAGE_SIZE);
  const spineTree = deriveSpineTree(await loadContextHistory(core, main), items);

  const currentPromptId = snapState.inFlightTurn === null ? undefined : readCurrentPromptId(main);
  const inFlightTurn = attachCurrentPromptIdToInFlight(snapState.inFlightTurn, currentPromptId);

  const pendingApprovals = interactions
    .findAll({
      kind: 'approval',
      resolved: false,
      tags: { [INTERACTION_TAG_SESSION_ID]: sessionId },
    })
    .map((i) => toWireApproval(i, sessionId));
  const pendingQuestions = interactions
    .findAll({
      kind: 'question',
      resolved: false,
      tags: { [INTERACTION_TAG_SESSION_ID]: sessionId },
    })
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

function toSnapshotUsage(status: LegacyStatusSnapshot | undefined): SessionUsage {
  if (status === undefined) return emptySessionUsage();
  const total = status.usage?.total;
  return {
    input_tokens: total?.inputOther ?? 0,
    output_tokens: total?.output ?? 0,
    cache_read_tokens: total?.inputCacheRead ?? 0,
    cache_creation_tokens: total?.inputCacheCreation ?? 0,
    context_tokens: status.contextTokens,
    context_limit: status.maxContextTokens,
  };
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

export function deriveSpineTree(
  messages: readonly ContextMessage[],
  items: readonly { id: string }[],
): SpineTreeView | undefined {
  try {
    const view = spineTreeViewFromState(deriveSpineState(messages));
    const nodes: SpineTreeNode[] = [];
    const walk = (views: readonly SpineTreeNodeView[], parentId: string | null): void => {
      for (const node of views) {
        if (node.kind !== 'task') {
          walk(node.children, parentId);
          continue;
        }
        nodes.push({
          id: node.id,
          parent_id: parentId,
          title: node.summary,
          memory: node.memory ?? '',
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
