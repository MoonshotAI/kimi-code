import { Bot, type Context } from 'grammy';
import type { PairingService } from './pairing.js';
import type { Store } from './store.js';
import type { Config } from './config.js';
import type { KimiClient } from './kimi/client.js';
import { KimiClientError } from './kimi/client.js';
import type { Logger } from './kimi/ws.js';

/**
 * Telegram bot factory and command handlers.
 *
 * Exposes a `/start <code>` command that consumes a one-time pairing code and
 * links the Telegram chat to a kimi-code session, plus a text-message handler
 * that forwards paired chat messages to kimi-code as user prompts.
 */

export function createStartHandler(pairingService: PairingService, store: Store) {
  return async (ctx: Context): Promise<void> => {
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Please pair in a private chat with the bot.');
      return;
    }

    const code = String(ctx.match ?? '').trim();

    if (!code) {
      await ctx.reply(
        'Generate a pairing code from your kimi-code session (e.g. `/telegram pair`), ' +
          'then send it here as:\n' +
          '`/start <code>`'
      );
      return;
    }

    const request = pairingService.validatePairingCode(code);
    if (!request) {
      await ctx.reply('Invalid or expired code. Generate a new one from your kimi-code session.');
      return;
    }

    const chatId = ctx.chat.id;
    const userId = ctx.from?.id ?? null;

    try {
      store.activatePairingBySession(request.sessionId, chatId, userId);
      await ctx.reply(`Paired with session \`${request.sessionId}\`. You can now send messages here.`);
    } catch {
      await ctx.reply('Failed to activate pairing. Please try again or generate a new code.');
    }
  };
}

const SETUP_INSTRUCTIONS =
  'This chat is not paired. Send `/start <code>` to pair with your kimi-code session.';

const DEFAULT_UPDATE_ID_WINDOW = 200;

/**
 * Creates a grammY middleware that drops duplicate Telegram updates based on
 * `update_id`. Keeps a bounded in-memory window of the most recent IDs.
 *
 * Note: deduplication is in-memory only; duplicates may be re-processed after
 * a process restart. This is acceptable for the current sidecar model.
 */
export function createUpdateIdDedupMiddleware(windowSize = DEFAULT_UPDATE_ID_WINDOW) {
  const seen = new Set<number>();
  const order: number[] = [];

  return async (ctx: Context, next: () => Promise<void>): Promise<void> => {
    const id = ctx.update.update_id;
    if (id == null) {
      await next();
      return;
    }

    if (seen.has(id)) {
      return;
    }

    seen.add(id);
    order.push(id);
    if (order.length > windowSize) {
      const oldest = order.shift();
      if (oldest != null) {
        seen.delete(oldest);
      }
    }

    await next();
  };
}

export interface MessageHandlerOptions {
  logger?: Logger;
}

export function createMessageHandler(
  store: Store,
  kimiClient: KimiClient,
  options: MessageHandlerOptions = {}
) {
  const logger = options.logger ?? console;

  return async (ctx: Context): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const pairing = store.getPairingByChatId(chatId);
    if (!pairing?.active) {
      await ctx.reply(SETUP_INSTRUCTIONS);
      return;
    }

    const text = ctx.message?.text?.trim();
    if (!text) {
      await ctx.reply('Please send a non-empty message.');
      return;
    }

    const replyToTelegramMessageId = ctx.message?.reply_to_message?.message_id;
    let replyToKimiMessageId: string | undefined;
    if (replyToTelegramMessageId != null) {
      const mapping = store.getThreadMappingByTelegramMessageId(
        pairing.sessionId,
        chatId,
        replyToTelegramMessageId
      );
      replyToKimiMessageId = mapping?.kimiMessageId;
    }

    let result: { id: string };
    try {
      result = await kimiClient.submitPrompt(
        pairing.sessionId,
        text,
        replyToKimiMessageId
      );
    } catch (error) {
      const status = error instanceof KimiClientError ? error.status : undefined;
      logger.error({ error, chatId, sessionId: pairing.sessionId }, 'Failed to submit prompt');
      await ctx.reply(
        `Failed to send prompt${status ? ` (${status})` : ''}. Please try again.`
      );
      return;
    }

    const telegramMessageId = ctx.message?.message_id;
    if (telegramMessageId != null) {
      try {
        store.saveThreadMapping({
          sessionId: pairing.sessionId,
          telegramChatId: chatId,
          telegramMessageId,
          kimiMessageId: result.id,
          direction: 'telegram_to_kimi',
        });
      } catch (error) {
        logger.error(
          { error, chatId, sessionId: pairing.sessionId, telegramMessageId },
          'Failed to save thread mapping'
        );
      }
    }

    await ctx.reply('Prompt sent.');
  };
}

export function createBot(
  config: Config,
  pairingService: PairingService,
  store: Store,
  kimiClient: KimiClient,
  logger?: Logger
): Bot {
  const bot = new Bot(config.telegramBotToken);
  bot.use(createUpdateIdDedupMiddleware());
  bot.command('start', createStartHandler(pairingService, store));
  bot.on('message:text', createMessageHandler(store, kimiClient, { logger }));
  return bot;
}
