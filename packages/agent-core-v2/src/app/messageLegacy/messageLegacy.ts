/**
 * `messageLegacy` domain (L7 edge adapter) — v1-compatible message history.
 *
 * Implements the legacy `GET /api/v1/sessions/{sid}/messages[/{mid}]` contract
 * (`packages/server/src/routes/messages.ts`) on top of the native v2 services.
 *
 * The native `IAgentContextMemoryService` (Agent scope, serving `/api/v2` `messages:*`)
 * holds the model's CURRENT, folded context and is left untouched. For a live
 * session this adapter reads that folded history (its transcript is in memory
 * by definition); for a cold session it loads the session, restores the main
 * agent's wire log, and reads the FULL transcript from `IAgentRecordService`
 * (pre-compaction messages preserved, matching v1's `wire.jsonl` rebuild). The
 * `ContextMessage → Message` projection is shared with the `snapshot` and
 * `:undo` edges via `contextMemory/messageProjection`. Bound at App scope — a
 * stateless dispatcher that resolves the target session/agent per call.
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

/** Listing query — v1 `cursorQuery` plus an optional role filter. */
export interface MessageListQuery extends CursorQuery {
  readonly role?: MessageRole;
}

export interface IMessageLegacyService {
  readonly _serviceBrand: undefined;

  /**
   * `GET /sessions/{sid}/messages` — paginated, newest-first message history.
   * Throws `session.not_found` when `sid` is unknown.
   */
  list(sessionId: string, query: MessageListQuery): Promise<PageResponse<Message>>;
  /**
   * `GET /sessions/{sid}/messages/{mid}` — single message by id.
   * Throws `session.not_found` when `sid` is unknown, `message.not_found` when
   * the session is known but `mid` is missing, mismatched, or out of range.
   */
  get(sessionId: string, messageId: string): Promise<Message>;
}

export const IMessageLegacyService: ServiceIdentifier<IMessageLegacyService> =
  createDecorator<IMessageLegacyService>('messageLegacyService');
