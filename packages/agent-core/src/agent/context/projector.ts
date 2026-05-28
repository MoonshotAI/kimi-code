import type { ContentPart, Message, TextPart } from '@moonshot-ai/kosong';

import { renderNotificationXml } from './notification-xml';

type ProjectableMessage = Message & {
  readonly origin?:
    | {
        readonly kind: string;
        readonly event?: string | undefined;
        readonly blockedByHook?: string | undefined;
      }
    | undefined;
};

const TRANSCRIPT_ONLY_HOOK_RESULT_EVENTS = new Set(['UserPromptSubmit']);

export interface EphemeralInjection {
  kind: 'memory_recall' | 'system_reminder' | 'pending_notification';
  content: string | Record<string, unknown>;
  position?: 'before_user' | 'after_system';
}

export function project(
  history: readonly ProjectableMessage[],
  ephemeralInjections?: readonly EphemeralInjection[],
): Message[] {
  // Keep partial or empty assistant placeholders away from providers.
  // They can appear when a turn is aborted or errors before any content
  // or tool call is appended.
  const usable = history.filter((message) => {
    if (isBlockedUserPrompt(message)) return false;
    return (
      !isTranscriptOnlyHookResult(message) &&
      message.partial !== true &&
      !(message.role === 'assistant' && message.content.length === 0 && message.toolCalls.length === 0)
    );
  });
  const merged = mergeAdjacentUserMessages(usable);

  const injectionMessages = ephemeralInjections?.map((injection) => renderInjection(injection));

  // Ephemeral injections sit before the first history message
  // (before_user) so things like system_reminder land right before the
  // user turn they contextualise.
  return injectionMessages ? [...injectionMessages, ...merged] : merged;
}

function isTranscriptOnlyHookResult(message: ProjectableMessage): boolean {
  return (
    message.origin?.kind === 'hook_result' &&
    TRANSCRIPT_ONLY_HOOK_RESULT_EVENTS.has(message.origin.event ?? '')
  );
}

function isBlockedUserPrompt(message: ProjectableMessage): boolean {
  return message.role === 'user' && message.origin?.blockedByHook === 'UserPromptSubmit';
}

/**
 * Render an EphemeralInjection into a synthetic user message. System
 * reminders and pending notifications use XML wrappers so the model can
 * distinguish host annotations from genuine user text. `memory_recall`
 * stays as free text.
 *
 * The merge-guard logic downstream (`mergeAdjacentUserMessages`) uses
 * the `<notification ` / `<system-reminder>` opening tag to detect
 * these messages, so the exact tag names are load-bearing for
 * projector correctness — do not rename without also updating
 * `isInjectionUserMessage` below.
 */
function renderInjection(injection: EphemeralInjection): Message {
  const text = renderInjectionText(injection);
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}

function renderInjectionText(injection: EphemeralInjection): string {
  const { kind, content } = injection;
  if (kind === 'pending_notification') {
    // Production callers pass notification metadata, but accepting a
    // string keeps older embedders from crashing on replay/projection.
    if (typeof content === 'string') {
      return `<notification>\n${content}\n</notification>`;
    }
    return renderNotificationXml(content);
  }
  if (kind === 'system_reminder') {
    const body = typeof content === 'string' ? content : JSON.stringify(content);
    return `<system-reminder>\n${body}\n</system-reminder>`;
  }
  const body = typeof content === 'string' ? content : JSON.stringify(content);
  return body;
}

/**
 * Detect whether a user message was produced by the ephemeral injection
 * pipeline (system_reminder or notification XML tag). Such messages
 * must never be merged with an adjacent real user turn — doing so would
 * smear the injection's XML wrapper into the user's actual prompt and
 * confuse the LLM about where the system annotation ends.
 *
 */
function isInjectionUserMessage(message: Message): boolean {
  if (message.role !== 'user') return false;
  const text = extractTextOnly(message);
  // Cheap leading-fragment check — injections always have the opening
  // tag at the start. We use `trimStart()` so leading whitespace
  // doesn't defeat the check, and require `'<notification '` (with
  // trailing space) so user text like `<notificationally` or the
  // bare `<notification>` tag (no attributes) is not misidentified.
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<notification ')) return true;
  if (trimmed.startsWith('<system-reminder>')) return true;
  if (trimmed.startsWith('<hook_result ')) return true;
  if (trimmed.startsWith('<cron-fire ')) return true;
  return false;
}

function mergeAdjacentUserMessages(history: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (const message of history) {
    const previous = out.at(-1);
    if (
      message.role === 'user' &&
      previous !== undefined &&
      previous.role === 'user' &&
      !isInjectionUserMessage(message) &&
      !isInjectionUserMessage(previous)
    ) {
      out[out.length - 1] = mergeTwoUserMessages(previous, message);
      continue;
    }
    // Clone into a fresh Message so we never mutate input arrays.
    out.push(cloneMessage(message));
  }
  return out;
}

function mergeTwoUserMessages(a: Message, b: Message): Message {
  const aText = extractTextOnly(a);
  const bText = extractTextOnly(b);
  const nonTextParts = [
    ...a.content.filter((p) => p.type !== 'text'),
    ...b.content.filter((p) => p.type !== 'text'),
  ];
  const mergedText: TextPart = { type: 'text', text: `${aText}\n\n${bText}` };
  const content: ContentPart[] = [mergedText, ...nonTextParts];
  return {
    role: 'user',
    content,
    toolCalls: [],
  };
}

function extractTextOnly(message: Message): string {
  return message.content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function cloneMessage(message: Message): Message {
  return {
    role: message.role,
    name: message.name,
    content: message.content.map((p) => ({ ...p })) as ContentPart[],
    toolCalls: message.toolCalls.map((tc) => ({ ...tc })),
    toolCallId: message.toolCallId,
    partial: message.partial,
  };
}
