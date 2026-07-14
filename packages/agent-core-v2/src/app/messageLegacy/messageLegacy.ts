/**
 * `messageLegacy` domain (L7 edge adapter) — v1-compatible message history.
 *
 * Implements the legacy `GET /api/v1/sessions/{sid}/messages[/{mid}]` contract
 * (`packages/server/src/routes/messages.ts`) on top of the native v2 services.
 *
 * The native `IAgentContextMemoryService` (Agent scope, serving `/api/v2`
 * `messages:*`) holds the model's CURRENT, folded context and is NOT the full
 * transcript: after a compaction it collapses into `[...keptUserMessages,
 * compaction_summary]`. The full transcript is reduced from the main agent's
 * in-memory record journal (`IAgentWireRecordService.getRecords()`), which
 * `ISessionLifecycleService.resume` seeds from `wire.jsonl` and live dispatch
 * then keeps current — so neither a live nor a cold session is read back from
 * disk here. The `ContextMessage → Message` projection is shared with the
 * `snapshot` and `:undo` edges via `contextMemory/messageProjection`. Bound at
 * App scope — a stateless dispatcher that resolves the target session/agent per
 * call.
 *
 * Error contract (mapped at the route layer):
 *   - `session.not_found`  → 40401
 *   - `message.not_found`  → 40403
 */

import type {
  CursorQuery,
  Message,
  MessageRole,
  PageResponse,
} from '@moonshot-ai/protocol';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface MessageListQuery extends CursorQuery {
  readonly role?: MessageRole;
}

export interface IMessageLegacyService {
  readonly _serviceBrand: undefined;

  list(sessionId: string, query: MessageListQuery): Promise<PageResponse<Message>>;
  get(sessionId: string, messageId: string): Promise<Message>;
}

export const IMessageLegacyService: ServiceIdentifier<IMessageLegacyService> =
  createDecorator<IMessageLegacyService>('messageLegacyService');
