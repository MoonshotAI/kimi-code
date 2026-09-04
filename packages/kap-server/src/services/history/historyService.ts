import { join } from 'node:path';

import {
  getLiveSessionById,
  IAgentLifecycleService,
  ISessionIndex,
  IWireService,
  MAIN_AGENT_ID,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import {
  historyResponseSchema,
  type HistoryMessage,
  type HistoryResponse,
} from '../../protocol/messages';
import { readWireRecords, type ContextRecord } from '../projection/heal';
import type { ProjectionService } from '../projection/projectionService';
import { foldWireHistory } from './coldFold';

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;

export class HistorySessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session ${sessionId} does not exist`);
    this.name = 'HistorySessionNotFoundError';
    this.sessionId = sessionId;
  }
}

export interface HistoryQueryOptions {
  readonly before_turn?: string;
  readonly after_step?: string;
  readonly page_size?: number;
  readonly agent_id?: string;
}

export interface HistoryServiceDeps {
  readonly homeDir: string;
  readonly core: Scope;
  readonly projection: ProjectionService;
}

export async function readSessionHistory(
  deps: HistoryServiceDeps,
  sessionId: string,
  query: HistoryQueryOptions,
): Promise<HistoryResponse> {
  const summary = await deps.core.accessor.get(ISessionIndex).get(sessionId);
  if (summary === undefined) throw new HistorySessionNotFoundError(sessionId);
  const agentId = query.agent_id ?? MAIN_AGENT_ID;
  const live = getLiveSessionById(deps.core.accessor, sessionId) !== undefined;
  if (live) await flushAgentWire(deps.core, sessionId, agentId);
  const records = await readAgentWire(deps.homeDir, summary.workspaceId, sessionId, agentId);
  let subagentTaskIds: ReadonlyMap<string, string> | undefined;
  if (agentId !== MAIN_AGENT_ID) {
    if (live) await flushAgentWire(deps.core, sessionId, MAIN_AGENT_ID);
    const mainRecords = await readAgentWire(deps.homeDir, summary.workspaceId, sessionId, MAIN_AGENT_ID);
    subagentTaskIds = scanSubagentTaskIds(mainRecords);
  }
  const all = foldWireHistory(records, {
    sessionId,
    agentId,
    live,
    fallbackTimestamp: new Date(summary.createdAt).toISOString(),
    subagentTaskIds,
    resolvePlanRevisionKey: (key) =>
      join('sessions', summary.workspaceId, sessionId, 'agents', agentId, key),
  });
  const messages = paginateHistory(all, query);
  const inFlight = live ? deps.projection.inFlight(sessionId, agentId) : undefined;
  const response: HistoryResponse = {
    messages,
    in_flight: inFlight,
  };
  const parsed = historyResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error(
      `history response failed schema validation: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

export function paginateHistory(
  messages: readonly HistoryMessage[],
  query: HistoryQueryOptions,
): HistoryMessage[] {
  const pageSize = Math.min(Math.max(query.page_size ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  if (query.before_turn !== undefined) {
    const index = messages.findIndex(
      (message) => message.type === 'turn' && message.turn_id === query.before_turn,
    );
    if (index < 0) return [];
    return messages.slice(Math.max(0, index - pageSize), index);
  }
  if (query.after_step !== undefined) {
    let index = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if ('step_id' in message && message.step_id === query.after_step) {
        index = i;
        break;
      }
    }
    if (index < 0) return [];
    return messages.slice(index + 1, index + 1 + pageSize);
  }
  return messages.slice(Math.max(0, messages.length - pageSize));
}

function scanSubagentTaskIds(records: readonly ContextRecord[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const record of records) {
    if (record.type !== 'task.started' && record.type !== 'task.terminated') continue;
    const info = record['info'] as { kind?: unknown; agentId?: unknown; taskId?: unknown } | undefined;
    if (info?.kind !== 'agent') continue;
    if (typeof info.agentId !== 'string' || typeof info.taskId !== 'string') continue;
    map.set(info.agentId, info.taskId);
  }
  return map;
}

async function flushAgentWire(core: Scope, sessionId: string, agentId: string): Promise<void> {
  const session = getLiveSessionById(core.accessor, sessionId);
  const handle = session?.accessor.get(IAgentLifecycleService).handleOf(agentId);
  if (handle === undefined) return;
  await handle.accessor.get(IWireService).flush();
}

async function readAgentWire(
  homeDir: string,
  workspaceId: string,
  sessionId: string,
  agentId: string,
): Promise<ContextRecord[]> {
  try {
    return await readWireRecords(
      join(homeDir, 'sessions', workspaceId, sessionId, 'agents', agentId, 'wire.jsonl'),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
