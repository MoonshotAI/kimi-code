/**
 * `contextMemory` message id helpers.
 *
 * Local message ids (`msg_<ulid>`) are process-lifetime identifiers only —
 * they are NOT persisted: the on-disk `context.append_message` record carries
 * exactly v1's field set, and public message ids are derived from the
 * transcript index (see `messageProjection.toProtocolMessage`), which stays
 * stable across live reads and resume. `newMessageId` remains for callers that
 * need an opaque per-process id (e.g. `prompt scheduler` prompt tracking).
 * Provider-assigned ids live on the separate `providerMessageId` field and
 * never collide with this namespace.
 */

import { ulid } from 'ulid';

export function newMessageId(): string {
  return `msg_${ulid()}`;
}
