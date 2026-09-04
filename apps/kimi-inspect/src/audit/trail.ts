/**
 * Audit trail for the chat view's message-protocol channel.
 *
 * A pure observer: the chat pipeline (REST history loads, WS messages, user
 * actions) calls the `record*` methods AFTER applying each step to the real
 * `ChatStore`, passing the resulting immutable `ChatState` reference.
 * Replaying the trail is therefore free — every entry already holds the
 * exact state the store had at that point, ready for the timeline slider
 * and the structural diff.
 */

import type { ServerMessage } from '@moonshot-ai/kap-server/protocol';

import type { ChatState } from '../transcript/store';

export const AUDIT_TRAIL_MAX_ENTRIES = 5000;

interface AuditEntryBase {
  /** Position in the trail (stable even when old entries are dropped). */
  readonly index: number;
  /** Local record time (ISO). */
  readonly at: string;
  /** Store state right after this entry was applied (immutable reference). */
  readonly state: ChatState;
  /** One-line summary for the timeline list. */
  readonly summary: string;
}

export interface RestAuditEntry extends AuditEntryBase {
  readonly kind: 'rest';
  readonly request: {
    readonly beforeTurn?: string | undefined;
    readonly afterStep?: string | undefined;
    readonly pageSize: number;
  };
  /** replace = newest page (initial/refresh); prepend = older page; tail = after_step catch-up. */
  readonly mode: 'replace' | 'prepend' | 'tail';
  readonly messageCount: number;
  readonly inFlight?: { turn_id: string; step_id: string } | undefined;
}

export interface WsAuditEntry extends AuditEntryBase {
  readonly kind: 'ws';
  /** The raw server message as applied to the store (entity, delta, or state). */
  readonly message: ServerMessage;
}

export interface EventAuditEntry extends AuditEntryBase {
  readonly kind: 'event';
  readonly event:
    | 'ack'
    | 'ack-error'
    | 'reconnect'
    | 'catchup-refresh'
    | 'protocol-error'
    | 'invalid-frame'
    | 'prompt'
    | 'cancel'
    | 'older-error';
  readonly detail?: string | undefined;
}

export type AuditEntry = RestAuditEntry | WsAuditEntry | EventAuditEntry;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Entry payload accepted by `push` (index/at are filled in there). */
type AuditEntryInput = DistributiveOmit<AuditEntry, 'index' | 'at'>;

export class AuditTrail {
  private entryList: AuditEntry[] = [];
  private nextIndex = 0;
  private readonly listeners = new Set<() => void>();

  /** `useSyncExternalStore`-compatible subscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getEntries(): readonly AuditEntry[] {
    return this.entryList;
  }

  recordRest(
    request: RestAuditEntry['request'],
    mode: RestAuditEntry['mode'],
    messageCount: number,
    inFlight: RestAuditEntry['inFlight'],
    state: ChatState,
  ): void {
    const cursor =
      request.beforeTurn !== undefined
        ? `?before_turn=${request.beforeTurn}`
        : request.afterStep !== undefined
          ? `?after_step=${request.afterStep}`
          : '';
    const flight = inFlight !== undefined ? ` (in_flight ${inFlight.step_id})` : '';
    this.push({
      kind: 'rest',
      request,
      mode,
      messageCount,
      inFlight,
      state,
      summary: `GET history${cursor} → ${messageCount} messages (${mode})${flight}`,
    });
  }

  recordWs(message: ServerMessage, state: ChatState): void {
    this.push({
      kind: 'ws',
      message,
      state,
      summary: summarizeMessage(message),
    });
  }

  recordEvent(
    event: EventAuditEntry['event'],
    detail: string | undefined,
    state: ChatState,
  ): void {
    const label =
      event === 'ack'
        ? 'subscribe ack → after_step catch-up'
        : event === 'ack-error'
          ? 'subscribe ack error'
          : event === 'reconnect'
            ? 'socket dropped → reconnecting'
            : event === 'catchup-refresh'
              ? 'catch-up anchor gone → full refresh'
              : event === 'protocol-error'
                ? 'protocol error frame'
                : event === 'invalid-frame'
                  ? 'invalid frame (server bug)'
                  : event === 'prompt'
                    ? 'prompt sent'
                    : event === 'cancel'
                      ? 'cancel sent'
                      : 'older-page load failed';
    this.push({
      kind: 'event',
      event,
      detail,
      state,
      summary: detail !== undefined && detail !== '' ? `${label}: ${detail}` : label,
    });
  }

  private push(entry: AuditEntryInput): void {
    const full = { ...entry, index: this.nextIndex, at: new Date().toISOString() } as AuditEntry;
    this.nextIndex += 1;
    const kept =
      this.entryList.length >= AUDIT_TRAIL_MAX_ENTRIES
        ? this.entryList.slice(this.entryList.length - AUDIT_TRAIL_MAX_ENTRIES + 1)
        : this.entryList;
    this.entryList = [...kept, full];
    for (const listener of this.listeners) listener();
  }
}

function summarizeMessage(message: ServerMessage): string {
  switch (message.type) {
    case 'turn':
      return `turn ${message.turn_id} (${message.state})`;
    case 'step':
      return `step ${message.step_id} (${message.state})`;
    case 'user':
      return `user ${message.message_id}`;
    case 'assistant':
    case 'thinking':
      return `${message.type} ${message.message_id} (${message.status})`;
    case 'assistant.delta':
    case 'thinking.delta':
      return `${message.type} ${message.message_id} +${message.text.length}ch`;
    case 'tool_call':
      return `tool_call ${message.name} ${message.tool_call_id} (${message.state})`;
    case 'tool_call.delta':
      return `tool_call.delta ${message.tool_call_id} +${message.input_text.length}ch`;
    case 'tool.progress':
      return `tool.progress ${message.tool_call_id} (${message.progress.kind})`;
    case 'system':
      return `system(${message.subtype}) ${message.system_id}`;
    case 'interaction':
      return `interaction ${message.interaction_id} (${message.kind}/${message.state})`;
    case 'task':
      return `task ${message.task_id} (${message.kind}/${message.state})`;
    case 'todo':
      return `todo ${message.todo_id} (${message.items.length} items)`;
    case 'session.state':
      return `session.state (${message.activity}${message.busy ? ', busy' : ''})`;
    default:
      return message.type;
  }
}
