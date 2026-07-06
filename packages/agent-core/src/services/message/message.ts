/**
 * `IMessageService` — daemon-facing message history interface.
 *
 * Wraps `ICoreProcessService.rpc.getContext({sessionId, agentId})` and adapts
 * agent-core's `ContextMessage` history shape (kosong `Message` + origin) to
 * the protocol's SCHEMAS.md §3 `Message` discriminated-by-content union.
 *
 * Endpoint mapping (REST.md §3.4):
 *   GET  /v1/sessions/{sid}/messages         → list(sid, ListMessagesQuery)
 *   GET  /v1/sessions/{sid}/messages/{mid}   → get(sid, mid)
 *
 * Sentinel errors:
 *   - `SessionNotFoundError`   → 40401 at the route layer
 *   - `MessageNotFoundError`   → 40403 at the route layer
 *
 * The adapter is documented in the implementation below.
 *
 * **Field mapping** (kosong/agent-core → protocol):
 *
 *   ContextMessage.role               →  Message.role            (1:1)
 *   ContextMessage.content[]          →  Message.content[]       (per-part adapter; see below)
 *   ContextMessage.toolCalls[]        →  Message.content[]       (appended as `tool_use` content parts)
 *   ContextMessage.toolCallId         →  Message.content[].tool_call_id  (when role==='tool', body becomes a tool_result)
 *   ContextMessage.isError            →  Message.content[0].is_error (only on tool_result)
 *
 * Content-part adapter (kosong ContentPart → SCHEMAS MessageContent):
 *
 *   { type:'text',      text }            → { type:'text', text }
 *   { type:'think',     think, encrypted? } → { type:'thinking', thinking:think, signature?:encrypted }
 *   { type:'image_url', imageUrl }        → { type:'image', source:{kind:'url', url:imageUrl.url } }
 *                                            (file/base64 reserved for future kosong shape)
 *   { type:'audio_url', audioUrl }        → { type:'text', text:`[audio:${audioUrl.url}]` }
 *                                            (SCHEMAS §3 has no audio content variant; flatten lossy)
 *   { type:'video_url', videoUrl }        → { type:'text', text:`[video:${videoUrl.url}]` }
 *                                            (same as audio — no video variant in §3)
 *
 * **ID synthesis**: kosong's `Message` has no `id`. We derive a deterministic
 * id from `(sessionId, history_index)`:
 *
 *     id = `msg_<sessionId>_<6-digit-index>`
 *
 * **Pagination**: SCHEMAS §1.3 / REST §3.4 say default 50, max 100 — applied
 * at the route layer. This impl receives a fully-validated query.
 */

import { createDecorator } from '../../di';
import type { ContextMessage } from '../../agent/context';
import type {
  CursorQuery,
  Message,
  MessageContent,
  MessageRole,
  PageResponse,
  ToolUseContent,
} from '@moonshot-ai/protocol';

/**
 * Listing query — `before_id`/`after_id` + `page_size` mutex is enforced
 * by `cursorQuerySchema`. The service layer adds an optional role filter.
 */
export interface MessageListQuery extends CursorQuery {
  role?: MessageRole;
}

export interface IMessageService {
  readonly _serviceBrand: undefined;

  /**
   * `GET /v1/sessions/{sid}/messages` — paginated message history.
   *
   * Default `page_size = 50`, max 100 (REST.md §3.4 / SCHEMAS §1.3).
   * Defaults are applied at the route layer.
   *
   * `before_id` / `after_id` are cursors keyed on message id (ULID, time
   * sortable). Result order is `created_at desc`; clients displaying in
   * ascending order should `.reverse()`.
   *
   * Throws `SessionNotFoundError` (→ 40401) when `sid` doesn't exist.
   */
  list(sid: string, query: MessageListQuery): Promise<PageResponse<Message>>;

  /**
   * `GET /v1/sessions/{sid}/messages/{mid}` — single message by id.
   *
   * Throws `SessionNotFoundError` (→ 40401) when `sid` doesn't exist.
   * Throws `MessageNotFoundError` (→ 40403) when the session is known but
   * no message with `mid` lives in its history.
   */
  get(sid: string, mid: string): Promise<Message>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IMessageService = createDecorator<IMessageService>('messageService');

/**
 * Sentinel error — daemon's route layer catches and maps to
 * `code: 40403` (message.not_found).
 */
export class MessageNotFoundError extends Error {
  readonly sessionId: string;
  readonly messageId: string;
  constructor(sessionId: string, messageId: string) {
    super(`message ${messageId} does not exist in session ${sessionId}`);
    this.name = 'MessageNotFoundError';
    this.sessionId = sessionId;
    this.messageId = messageId;
  }
}

/**
 * Derive a stable opaque message id from (sessionId, index). Format is
 * documented in the module header.
 */
export function deriveMessageId(sessionId: string, index: number): string {
  const padded = String(index).padStart(6, '0');
  return `msg_${sessionId}_${padded}`;
}

/**
 * Inverse of `deriveMessageId`: parse `msg_<sessionId>_<index>` back into
 * `{sessionId, index}`. Returns `undefined` if the id doesn't match the
 * `MessageService` ULID-shape contract.
 */
export function parseMessageId(
  messageId: string,
): { sessionId: string; index: number } | undefined {
  if (!messageId.startsWith('msg_')) return undefined;
  const rest = messageId.slice('msg_'.length);
  // sessionId may itself contain underscores (sess_01HZZZ...), so split from
  // the RIGHT on '_'.
  const lastUnderscore = rest.lastIndexOf('_');
  if (lastUnderscore <= 0) return undefined;
  const sessionId = rest.slice(0, lastUnderscore);
  const indexStr = rest.slice(lastUnderscore + 1);
  if (!/^\d+$/.test(indexStr)) return undefined;
  const index = Number.parseInt(indexStr, 10);
  if (!Number.isFinite(index) || index < 0) return undefined;
  return { sessionId, index };
}

/**
 * kosong's `Message.role` is `'system' | 'user' | 'assistant' | 'tool'` —
 * already aligned with SCHEMAS §3's `MessageRole`. We pass-through.
 */
function toProtocolRole(role: ContextMessage['role']): MessageRole {
  return role as MessageRole;
}

/**
 * Translate kosong content parts to SCHEMAS §3 content parts. See header
 * for the full mapping table.
 */
function mapContentPart(part: ContextMessage['content'][number]): MessageContent {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think': {
      const sig = part.encrypted;
      return sig !== undefined
        ? { type: 'thinking', thinking: part.think, signature: sig }
        : { type: 'thinking', thinking: part.think };
    }
    case 'image_url':
      return {
        type: 'image',
        source: { kind: 'url', url: part.imageUrl.url },
      };
    case 'audio_url':
      // SCHEMAS §3 has no audio content variant; flatten to a `text` marker
      // so the wire shape stays well-typed without inventing new schema.
      return {
        type: 'text',
        text: `[audio:${part.audioUrl.url}]`,
      };
    case 'video_url':
      return {
        type: 'text',
        text: `[video:${part.videoUrl.url}]`,
      };
  }
}

/**
 * Build the protocol-shaped `Message.content[]` for one ContextMessage.
 *
 * Order:
 *   1. For `tool` role: emit a SINGLE `tool_result` part. The output is the
 *      flattened text of the kosong message's content parts (most tool
 *      messages emit a single text). `is_error` is taken from `ContextMessage.isError`.
 *   2. For other roles: emit each content part mapped per `mapContentPart`,
 *      THEN append one `tool_use` part per `ToolCall` (assistant only).
 */
function buildProtocolContent(msg: ContextMessage): MessageContent[] {
  if (msg.role === 'tool') {
    if (msg.toolCallId === undefined) {
      // Defensive — kosong tool messages always carry toolCallId. If absent,
      // fall back to text passthrough so we don't lose user-visible content.
      return msg.content.map((p) => mapContentPart(p));
    }
    const flattenedOutput = msg.content
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('');
    const part: MessageContent = msg.isError === true
      ? {
          type: 'tool_result',
          tool_call_id: msg.toolCallId,
          output: flattenedOutput,
          is_error: true,
        }
      : {
          type: 'tool_result',
          tool_call_id: msg.toolCallId,
          output: flattenedOutput,
        };
    return [part];
  }

  const base = msg.content.map((p) => mapContentPart(p));

  if (msg.role === 'assistant' && msg.toolCalls.length > 0) {
    for (const call of msg.toolCalls) {
      let parsedInput: unknown = call.arguments;
      if (typeof call.arguments === 'string') {
        try {
          parsedInput = JSON.parse(call.arguments);
        } catch {
          parsedInput = call.arguments;
        }
      }
      const part: ToolUseContent = {
        type: 'tool_use',
        tool_call_id: call.id,
        tool_name: call.name,
        input: parsedInput,
      };
      base.push(part);
    }
  }

  return base;
}

/**
 * Convert one history-array entry into the protocol's `Message` shape.
 *
 * `sessionCreatedAtMs` is the session's `createdAt` (ms). We add the index
 * so per-message `created_at` increases monotonically across the array.
 * Callers that know the real record time can pass `createdAtMs` to override
 * the synthesized value (MessageService does this for wire-derived entries).
 */
export function toProtocolMessage(
  sessionId: string,
  index: number,
  msg: ContextMessage,
  sessionCreatedAtMs: number,
  createdAtMsOverride?: number,
): Message {
  const id = deriveMessageId(sessionId, index);
  const role = toProtocolRole(msg.role);
  const content = buildProtocolContent(msg);
  const createdAtMs = createdAtMsOverride ?? sessionCreatedAtMs + index;
  // Expose the message origin (kosong/agent-core `origin`) via metadata so REST
  // clients (e.g. the web UI) can hide injected/system user turns — compaction
  // summaries, injections, hook results, retries, system triggers, cron, etc. —
  // the same way the TUI does (see isReplayUserTurnRecord). Absent for plain
  // user/assistant/tool messages with no origin.
  const metadata = msg.origin !== undefined ? { origin: msg.origin } : undefined;
  return {
    id,
    session_id: sessionId,
    role,
    content,
    created_at: new Date(createdAtMs).toISOString(),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}
