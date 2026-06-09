/**
 * `MessageService` — implementation of `IMessageService`.
 */

import { Disposable, InstantiationType, registerSingleton } from '@moonshot-ai/agent-core';
import type {
  AgentContextData,
  SessionSummary,
} from '@moonshot-ai/agent-core';
import type {
  Message,
  PageResponse,
} from '@moonshot-ai/protocol';

import { ICoreProcessService } from '../coreProcess/coreProcess';
import { SessionNotFoundError } from '../session/session';
import {
  IMessageService,
  MessageNotFoundError,
  deriveMessageId,
  parseMessageId,
  toProtocolMessage,
  type MessageListQuery,
} from './message';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
/** Agent id used for all session-scoped getContext calls (matches agent-core convention; see `core-impl.ts:788`). */
const MAIN_AGENT_ID = 'main';

export class MessageService extends Disposable implements IMessageService {
  readonly _serviceBrand: undefined;

  constructor(@ICoreProcessService private readonly core: ICoreProcessService) {
    super();
  }

  async list(sid: string, query: MessageListQuery): Promise<PageResponse<Message>> {
    const summary = await this._requireSession(sid);
    const context = await this._getContext(sid);
    const all: Message[] = context.history.map((m, idx) =>
      toProtocolMessage(sid, idx, m, summary.createdAt),
    );
    // SCHEMAS §1.3: "缺省返回最近 N 条 (created_at desc)" — newest first.
    const desc = [...all].reverse();

    let pivotIndex = -1;
    if (query.before_id !== undefined) {
      pivotIndex = desc.findIndex((m) => m.id === query.before_id);
    } else if (query.after_id !== undefined) {
      pivotIndex = desc.findIndex((m) => m.id === query.after_id);
    }

    let slice: Message[];
    if (query.before_id !== undefined && pivotIndex >= 0) {
      // before_id = older entries → tail of the desc array, exclusive of pivot.
      slice = desc.slice(pivotIndex + 1);
    } else if (query.after_id !== undefined && pivotIndex >= 0) {
      // after_id = newer entries → head of the desc array, exclusive of pivot.
      slice = desc.slice(0, pivotIndex);
    } else {
      slice = desc;
    }

    const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
    const page = slice.slice(0, pageSize);
    const hasMore = slice.length > pageSize;

    // Role filter is applied AFTER pagination — see header.
    const filtered =
      query.role !== undefined ? page.filter((m) => m.role === query.role) : page;

    return { items: filtered, has_more: hasMore };
  }

  async get(sid: string, mid: string): Promise<Message> {
    const summary = await this._requireSession(sid);
    const parsed = parseMessageId(mid);
    if (parsed === undefined || parsed.sessionId !== sid) {
      throw new MessageNotFoundError(sid, mid);
    }
    const context = await this._getContext(sid);
    const entry = context.history[parsed.index];
    if (entry === undefined) {
      throw new MessageNotFoundError(sid, mid);
    }
    return toProtocolMessage(sid, parsed.index, entry, summary.createdAt);
  }

  /**
   * Confirms the session exists and returns its summary (for the timestamp
   * base). Throws `SessionNotFoundError` (→ 40401) on miss.
   */
  private async _requireSession(sid: string): Promise<SessionSummary> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === sid);
    if (summary === undefined) {
      throw new SessionNotFoundError(sid);
    }
    return summary;
  }

  private async _getContext(sid: string): Promise<AgentContextData> {
    try {
      await this.core.rpc.resumeSession({ sessionId: sid });
      return await this.core.rpc.getContext({ sessionId: sid, agentId: MAIN_AGENT_ID });
    } catch (err) {
      throw new SessionNotFoundError(sid);
    }
  }
}

// Self-register under the global singleton registry. All ctor deps are
// `@I…`-injected; `staticArguments = []`. `supportsDelayedInstantiation =
// false` preserves current reverse-dispose semantics.
registerSingleton(IMessageService, MessageService, InstantiationType.Delayed);
