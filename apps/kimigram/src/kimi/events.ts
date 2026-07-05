import type { KimiEvent, Logger } from './ws.js';
import type { Store } from '../store.js';
import type { ReplyParameters } from '@grammyjs/types';
import { convertToTelegramMarkdown } from '../formatting/telegramMarkdown.js';

export type { ReplyParameters };

export interface SendMessageOptions {
  reply_parameters?: ReplyParameters;
  parse_mode?: 'MarkdownV2' | 'HTML';
  [key: string]: unknown;
}

/**
 * Minimal Telegram API surface used by the event dispatcher.
 * This keeps the dispatcher decoupled from the full grammY Bot type.
 */
export interface SentMessage {
  message_id: number;
}

export interface BotApi {
  sendMessage(chatId: number, text: string, options?: SendMessageOptions): Promise<SentMessage>;
}

export interface EventDispatcherOptions {
  logger?: Logger;
}

/**
 * Creates a handler for kimi-code WebSocket events that sends Telegram
 * notifications to the chat paired with the event's session. Milestone events
 * are sent as plain text; assistant messages are converted to MarkdownV2 when
 * safe and fall back to plain text otherwise.
 *
 * Currently notifies for: `turn.ended`, `task.completed`,
 * `background.task.terminated`, `goal.updated` (when `status === 'completed'`),
 * `event.approval.requested`, and `approval.requested`. Events without a
 * `sessionId`, or for unpaired/inactive sessions, are ignored.
 */
export function createEventDispatcher(
  store: Store,
  botApi: BotApi,
  options: EventDispatcherOptions = {}
): (event: KimiEvent) => void {
  const logger = options.logger ?? console;

  return (event) => {
    const sessionId = event.sessionId;

    if (!sessionId) {
      logger.warn({ eventType: event.type }, 'Ignoring kimi-code event without sessionId');
      return;
    }

    const pairing = store.getPairingBySessionId(sessionId);
    if (!pairing?.active || pairing.telegramChatId == null) {
      return;
    }

    const chatId = pairing.telegramChatId;

    const notification = buildNotificationText(event);
    if (!notification) {
      return;
    }

    const parentKimiMessageId = getParentKimiMessageId(event);
    const sendOptions = buildSendOptions(
      store,
      sessionId,
      chatId,
      parentKimiMessageId,
      notification.parseMode
    );

    const eventKimiMessageId = getEventKimiMessageId(event);

    Promise.resolve()
      .then(() => botApi.sendMessage(chatId, notification.text, sendOptions))
      .then((sent) => {
        if (eventKimiMessageId) {
          try {
            store.saveThreadMapping({
              sessionId,
              telegramChatId: chatId,
              telegramMessageId: sent.message_id,
              kimiMessageId: eventKimiMessageId,
              direction: 'kimi_to_telegram',
            });
          } catch (error) {
            logger.error(
              { error, sessionId, chatId, messageId: sent.message_id },
              'Failed to save outgoing thread mapping'
            );
          }
        }
      })
      .catch((error) => {
        logger.error(
          { error, sessionId, chatId },
          'Failed to send Telegram notification'
        );
      });
  };
}

function getEventKimiMessageId(event: KimiEvent): string | undefined {
  const payload = event.payload as {
    message_id?: unknown;
    id?: unknown;
  } | null | undefined;
  const id = payload?.message_id ?? payload?.id;
  return typeof id === 'string' ? id : undefined;
}

function getParentKimiMessageId(event: KimiEvent): string | undefined {
  const payload = event.payload as {
    parent_message_id?: unknown;
    reply_to_message_id?: unknown;
  } | null | undefined;
  const id = payload?.parent_message_id ?? payload?.reply_to_message_id;
  return typeof id === 'string' ? id : undefined;
}

function buildSendOptions(
  store: Store,
  sessionId: string,
  telegramChatId: number,
  kimiMessageId: string | undefined,
  parseMode: 'MarkdownV2' | undefined
): SendMessageOptions | undefined {
  let options: SendMessageOptions | undefined = undefined;

  if (kimiMessageId) {
    const mapping = store.getThreadMappingByKimiMessageId(
      sessionId,
      telegramChatId,
      kimiMessageId
    );
    if (mapping) {
      options = { reply_parameters: { message_id: mapping.telegramMessageId } };
    }
  }

  if (parseMode) {
    options = { ...options, parse_mode: parseMode };
  }

  return options;
}

interface Notification {
  text: string;
  parseMode?: 'MarkdownV2';
}

function buildNotificationText(event: KimiEvent): Notification | null {
  switch (event.type) {
    case 'turn.ended':
      return { text: 'Turn completed.' };
    case 'task.completed':
    case 'background.task.terminated':
      return { text: 'Task completed.' };
    case 'goal.updated': {
      const payload = event.payload as { status?: string } | null | undefined;
      if (payload?.status === 'completed') {
        return { text: 'Goal completed.' };
      }
      return null;
    }
    case 'event.approval.requested':
    case 'approval.requested': {
      const payload = event.payload as { summary?: string } | null | undefined;
      return {
        text: payload?.summary
          ? `Approval requested: ${payload.summary}`
          : 'Approval requested.',
      };
    }
    case 'assistant.message': {
      const payload = event.payload as
        | { text?: string; markdown?: string }
        | null
        | undefined;
      const source = payload?.markdown ?? payload?.text;
      if (!source) {
        return null;
      }
      return convertToTelegramMarkdown(source);
    }
    default:
      return null;
  }
}
