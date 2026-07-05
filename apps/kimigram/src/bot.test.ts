import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Bot } from 'grammy';
import { openStore, type Store } from './store.js';
import { createPairingService, type PairingService } from './pairing.js';
import {
  createStartHandler,
  createBot,
  createMessageHandler,
  createUpdateIdDedupMiddleware,
} from './bot.js';
import type { Config } from './config.js';
import type { KimiClient } from './kimi/client.js';
import { KimiClientError } from './kimi/client.js';
import type { Logger } from './kimi/ws.js';

const silentLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const TEST_BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: 'TestBot',
  username: 'test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
} as const;

async function dispatchStart(
  pairingService: PairingService,
  store: Store,
  text: string,
  overrides: {
    chatType?: 'private' | 'group';
    chatId?: number;
    userId?: number;
  } = {}
): Promise<{ replies: string[] }> {
  const bot = new Bot('dummy-token');
  bot.botInfo = { ...TEST_BOT_INFO };
  bot.command('start', createStartHandler(pairingService, store));

  const replies: string[] = [];
  bot.api.config.use((prev, method, payload) => {
    if (method === 'sendMessage') {
      replies.push((payload as { text?: string }).text ?? '');
      return Promise.resolve({
        ok: true,
        result: { message_id: 2, text: (payload as { text?: string }).text ?? '' },
      });
    }
    return prev(method, payload);
  });

  const spaceIndex = text.indexOf(' ');
  const commandLength = spaceIndex === -1 ? text.length : spaceIndex;

  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      text,
      chat: { id: overrides.chatId ?? 12345, type: overrides.chatType ?? 'private' },
      from: { id: overrides.userId ?? 67890, is_bot: false, first_name: 'Test' },
      date: Math.floor(Date.now() / 1000),
      entities: [{ type: 'bot_command', offset: 0, length: commandLength }],
    },
  });

  return { replies };
}

function createMockKimiClient(
  overrides: Partial<KimiClient> = {}
): KimiClient {
  return {
    submitPrompt: vi.fn().mockResolvedValue({ id: 'prompt-1' }),
    ...overrides,
  };
}

async function dispatchMessage(
  store: Store,
  kimiClient: KimiClient,
  text: string,
  overrides: {
    chatType?: 'private' | 'group';
    chatId?: number;
    userId?: number;
    noChat?: boolean;
    messageId?: number;
    replyToMessageId?: number;
    logger?: Logger;
  } = {}
): Promise<{ replies: string[] }> {
  const bot = new Bot('dummy-token');
  bot.botInfo = { ...TEST_BOT_INFO };
  bot.on('message:text', createMessageHandler(store, kimiClient, { logger: overrides.logger ?? silentLogger }));

  const replies: string[] = [];
  bot.api.config.use((prev, method, payload) => {
    if (method === 'sendMessage') {
      replies.push((payload as { text?: string }).text ?? '');
      return Promise.resolve({
        ok: true,
        result: { message_id: 2, text: (payload as { text?: string }).text ?? '' },
      });
    }
    return prev(method, payload);
  });

  const replyToMessage = overrides.replyToMessageId
    ? {
        message_id: overrides.replyToMessageId,
        chat: { id: overrides.chatId ?? 12345, type: overrides.chatType ?? 'private' },
        date: Math.floor(Date.now() / 1000),
      }
    : undefined;

  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: overrides.messageId ?? 1,
      text,
      chat: overrides.noChat
        ? undefined
        : { id: overrides.chatId ?? 12345, type: overrides.chatType ?? 'private' },
      from: { id: overrides.userId ?? 67890, is_bot: false, first_name: 'Test' },
      date: Math.floor(Date.now() / 1000),
      reply_to_message: replyToMessage,
    },
  });

  return { replies };
}

describe('createStartHandler', () => {
  let dbPath: string;
  let store: Store;
  let pairingService: PairingService;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'kimigram-test-'));
    dbPath = join(dir, 'test.db');
    store = openStore(dbPath);
    pairingService = createPairingService(store, { ttlMinutes: 10 });
  });

  afterEach(() => {
    store.close();
    const dir = dbPath.substring(0, dbPath.lastIndexOf('/'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('start with valid code replies success, activates pairing and consumes the code', async () => {
    const code = pairingService.generatePairingCode('session-1');
    const { replies } = await dispatchStart(pairingService, store, `/start ${code}`);

    expect(replies[0]).toBe(
      `Paired with session \`session-1\`. You can now send messages here.`
    );
    const pairing = store.getPairingByChatId(12345);
    expect(pairing?.sessionId).toBe('session-1');
    expect(pairing?.active).toBe(true);

    const retry = await dispatchStart(pairingService, store, `/start ${code}`);
    expect(retry.replies[0]).toBe(
      'Invalid or expired code. Generate a new one from your kimi-code session.'
    );
  });

  it('start with expired code replies invalid and leaves the store unchanged', async () => {
    const expiredService = createPairingService(store, { ttlMinutes: 0 });
    const code = expiredService.generatePairingCode('session-1');
    const { replies } = await dispatchStart(expiredService, store, `/start ${code}`);

    expect(replies[0]).toBe(
      'Invalid or expired code. Generate a new one from your kimi-code session.'
    );
    expect(store.getPairingByChatId(12345)).toBeNull();
    expect(expiredService.validatePairingCode(code)).toBeNull();
  });

  it('start without code replies setup instructions', async () => {
    const { replies } = await dispatchStart(pairingService, store, '/start');

    expect(replies[0]).toBe(
      'Generate a pairing code from your kimi-code session (e.g. `/telegram pair`), ' +
        'then send it here as:\n' +
        '`/start <code>`'
    );
  });

  it('start with invalid code replies invalid and leaves the store unchanged', async () => {
    const { replies } = await dispatchStart(pairingService, store, '/start BADCODE');

    expect(replies[0]).toBe(
      'Invalid or expired code. Generate a new one from your kimi-code session.'
    );
    expect(store.getPairingByChatId(12345)).toBeNull();
    expect(pairingService.validatePairingCode('BADCODE')).toBeNull();
  });

  it('start with only whitespace replies setup instructions', async () => {
    const { replies } = await dispatchStart(pairingService, store, '/start   ');

    expect(replies[0]).toBe(
      'Generate a pairing code from your kimi-code session (e.g. `/telegram pair`), ' +
        'then send it here as:\n' +
        '`/start <code>`'
    );
  });

  it('rejects non-private chats and does not activate a pairing', async () => {
    const { replies } = await dispatchStart(pairingService, store, '/start ABC123', {
      chatType: 'group',
    });

    expect(replies[0]).toBe('Please pair in a private chat with the bot.');
    expect(store.getPairingByChatId(12345)).toBeNull();
  });

  it('handles activation failure gracefully and consumes the code', async () => {
    const throwingStore: Store = {
      ...store,
      activatePairingBySession: () => {
        throw new Error('activation failed');
      },
    };
    const code = pairingService.generatePairingCode('session-1');
    const { replies } = await dispatchStart(
      pairingService,
      throwingStore,
      `/start ${code}`
    );

    expect(replies[0]).toBe(
      'Failed to activate pairing. Please try again or generate a new code.'
    );
    expect(pairingService.validatePairingCode(code)).toBeNull();
  });
});

describe('createMessageHandler', () => {
  let dbPath: string;
  let store: Store;
  let pairingService: PairingService;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'kimigram-test-'));
    dbPath = join(dir, 'test.db');
    store = openStore(dbPath);
    pairingService = createPairingService(store, { ttlMinutes: 10 });
  });

  afterEach(() => {
    store.close();
    const dir = dbPath.substring(0, dbPath.lastIndexOf('/'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('forwards text messages from paired chats', async () => {
    const code = pairingService.generatePairingCode('session-1');
    await dispatchStart(pairingService, store, `/start ${code}`);

    const kimiClient = createMockKimiClient();
    const { replies } = await dispatchMessage(
      store,
      kimiClient,
      'Hello from Telegram'
    );

    expect(kimiClient.submitPrompt).toHaveBeenCalledWith(
      'session-1',
      'Hello from Telegram',
      undefined
    );
    expect(replies[0]).toBe('Prompt sent.');
  });

  it('rejects messages from unpaired chats', async () => {
    const kimiClient = createMockKimiClient();
    const { replies } = await dispatchMessage(
      store,
      kimiClient,
      'Hello from Telegram'
    );

    expect(kimiClient.submitPrompt).not.toHaveBeenCalled();
    expect(replies[0]).toBe(
      'This chat is not paired. Send `/start <code>` to pair with your kimi-code session.'
    );
  });

  it('ignores empty text messages', async () => {
    const code = pairingService.generatePairingCode('session-1');
    await dispatchStart(pairingService, store, `/start ${code}`);

    const kimiClient = createMockKimiClient();
    const { replies } = await dispatchMessage(
      store,
      kimiClient,
      '   '
    );

    expect(kimiClient.submitPrompt).not.toHaveBeenCalled();
    expect(replies[0]).toBe('Please send a non-empty message.');
  });

  it('surfaces client errors to the user', async () => {
    const code = pairingService.generatePairingCode('session-1');
    await dispatchStart(pairingService, store, `/start ${code}`);

    const kimiClient = createMockKimiClient({
      submitPrompt: vi.fn().mockRejectedValue(
        new KimiClientError('Unauthorized', 401, 'bad token')
      ),
    });
    const { replies } = await dispatchMessage(
      store,
      kimiClient,
      'Hello'
    );

    expect(replies[0]).toBe('Failed to send prompt (401). Please try again.');
  });

  it('does not forward messages when pairing is inactive', async () => {
    const code = pairingService.generatePairingCode('session-1');
    await dispatchStart(pairingService, store, `/start ${code}`);
    store.deactivatePairing(12345);

    const kimiClient = createMockKimiClient();
    const { replies } = await dispatchMessage(
      store,
      kimiClient,
      'Hello after deactivate'
    );

    expect(kimiClient.submitPrompt).not.toHaveBeenCalled();
    expect(replies[0]).toBe(
      'This chat is not paired. Send `/start <code>` to pair with your kimi-code session.'
    );
  });

  it('surfaces non-client errors without a status', async () => {
    const code = pairingService.generatePairingCode('session-1');
    await dispatchStart(pairingService, store, `/start ${code}`);

    const kimiClient = createMockKimiClient({
      submitPrompt: vi.fn().mockRejectedValue(new Error('network down')),
    });
    const { replies } = await dispatchMessage(
      store,
      kimiClient,
      'Hello'
    );

    expect(replies[0]).toBe('Failed to send prompt. Please try again.');
  });

  it('does nothing when chat id is missing', async () => {
    const code = pairingService.generatePairingCode('session-1');
    await dispatchStart(pairingService, store, `/start ${code}`);

    const kimiClient = createMockKimiClient();
    const { replies } = await dispatchMessage(
      store,
      kimiClient,
      'Hello',
      { noChat: true }
    );

    expect(kimiClient.submitPrompt).not.toHaveBeenCalled();
    expect(replies).toHaveLength(0);
  });

  it('forwards replies with the parent kimi message id', async () => {
    const code = pairingService.generatePairingCode('session-1');
    await dispatchStart(pairingService, store, `/start ${code}`);
    store.saveThreadMapping({
      sessionId: 'session-1',
      telegramChatId: 12345,
      telegramMessageId: 10,
      kimiMessageId: 'kimi-10',
      direction: 'kimi_to_telegram',
    });

    const kimiClient = createMockKimiClient();
    await dispatchMessage(store, kimiClient, 'Reply text', {
      messageId: 20,
      replyToMessageId: 10,
    });

    expect(kimiClient.submitPrompt).toHaveBeenCalledWith(
      'session-1',
      'Reply text',
      'kimi-10'
    );
  });

  it('falls back to top-level prompt when reply has no mapping', async () => {
    const code = pairingService.generatePairingCode('session-1');
    await dispatchStart(pairingService, store, `/start ${code}`);

    const kimiClient = createMockKimiClient();
    await dispatchMessage(store, kimiClient, 'Reply text', {
      messageId: 20,
      replyToMessageId: 999,
    });

    expect(kimiClient.submitPrompt).toHaveBeenCalledWith(
      'session-1',
      'Reply text',
      undefined
    );
  });

  it('saves a thread mapping for the forwarded prompt', async () => {
    const code = pairingService.generatePairingCode('session-1');
    await dispatchStart(pairingService, store, `/start ${code}`);

    const kimiClient = createMockKimiClient();
    await dispatchMessage(store, kimiClient, 'Hello', { messageId: 30 });

    const mapping = store.getThreadMappingByTelegramMessageId('session-1', 12345, 30);
    expect(mapping?.kimiMessageId).toBe('prompt-1');
  });

  it('logs mapping save failures but still tells the user the prompt was sent', async () => {
    const code = pairingService.generatePairingCode('session-1');
    await dispatchStart(pairingService, store, `/start ${code}`);

    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const throwingStore: Store = {
      ...store,
      saveThreadMapping: () => {
        throw new Error('db locked');
      },
    };
    const kimiClient = createMockKimiClient();
    const { replies } = await dispatchMessage(
      throwingStore,
      kimiClient,
      'Hello',
      { messageId: 30, logger }
    );

    expect(replies[0]).toBe('Prompt sent.');
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('createBot', () => {
  it('creates a bot and registers the start command', async () => {
    const store = openStore(':memory:');
    try {
      const pairingService = createPairingService(store, { ttlMinutes: 10 });
      const code = pairingService.generatePairingCode('session-1');
      const config: Config = {
        telegramBotToken: 'test-token',
        databasePath: ':memory:',
        pairingCodeTtlMinutes: 10,
        logLevel: 'info',
        kimiServerUrl: 'http://localhost:58627',
        kimiBearerToken: 'kimi-token',
        kimiTokenFile: '~/.kimi-code/token',
      };
      const kimiClient = createMockKimiClient();
      const bot = createBot(config, pairingService, store, kimiClient, silentLogger);

      bot.botInfo = { ...TEST_BOT_INFO };

      const sentMessages: unknown[] = [];
      bot.api.config.use((prev, method, payload) => {
        if (method === 'sendMessage') {
          sentMessages.push(payload);
          return Promise.resolve({
            ok: true,
            result: { message_id: 2, text: (payload as { text?: string }).text ?? '' },
          });
        }
        return prev(method, payload);
      });

      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          text: `/start ${code}`,
          chat: { id: 12345, type: 'private' },
          from: { id: 67890, is_bot: false, first_name: 'Test' },
          date: Math.floor(Date.now() / 1000),
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      });

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        chat_id: 12345,
        text: 'Paired with session `session-1`. You can now send messages here.',
      });
    } finally {
      store.close();
    }
  });

  it('creates a bot and registers the text message handler', async () => {
    const store = openStore(':memory:');
    try {
      const pairingService = createPairingService(store, { ttlMinutes: 10 });
      const code = pairingService.generatePairingCode('session-1');
      const config: Config = {
        telegramBotToken: 'test-token',
        databasePath: ':memory:',
        pairingCodeTtlMinutes: 10,
        logLevel: 'info',
        kimiServerUrl: 'http://localhost:58627',
        kimiBearerToken: 'kimi-token',
        kimiTokenFile: '~/.kimi-code/token',
      };
      const kimiClient = createMockKimiClient();
      const bot = createBot(config, pairingService, store, kimiClient, silentLogger);

      bot.botInfo = { ...TEST_BOT_INFO };

      const sentMessages: unknown[] = [];
      bot.api.config.use((prev, method, payload) => {
        if (method === 'sendMessage') {
          sentMessages.push(payload);
          return Promise.resolve({
            ok: true,
            result: { message_id: 2, text: (payload as { text?: string }).text ?? '' },
          });
        }
        return prev(method, payload);
      });

      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          text: `/start ${code}`,
          chat: { id: 12345, type: 'private' },
          from: { id: 67890, is_bot: false, first_name: 'Test' },
          date: Math.floor(Date.now() / 1000),
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      });

      await bot.handleUpdate({
        update_id: 2,
        message: {
          message_id: 2,
          text: 'Forwarded message',
          chat: { id: 12345, type: 'private' },
          from: { id: 67890, is_bot: false, first_name: 'Test' },
          date: Math.floor(Date.now() / 1000),
        },
      });

      expect(kimiClient.submitPrompt).toHaveBeenCalledWith(
        'session-1',
        'Forwarded message',
        undefined
      );
      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[1]).toMatchObject({
        chat_id: 12345,
        text: 'Prompt sent.',
      });
    } finally {
      store.close();
    }
  });
});

describe('createUpdateIdDedupMiddleware', () => {
  it('calls next for new update_ids', async () => {
    const middleware = createUpdateIdDedupMiddleware();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware({ update: { update_id: 1 } } as Context, next);
    await middleware({ update: { update_id: 2 } } as Context, next);

    expect(next).toHaveBeenCalledTimes(2);
  });

  it('drops duplicate update_ids', async () => {
    const middleware = createUpdateIdDedupMiddleware();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware({ update: { update_id: 1 } } as Context, next);
    await middleware({ update: { update_id: 1 } } as Context, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('evicts old ids when the window is full', async () => {
    const middleware = createUpdateIdDedupMiddleware(2);
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware({ update: { update_id: 1 } } as Context, next);
    await middleware({ update: { update_id: 2 } } as Context, next);
    await middleware({ update: { update_id: 3 } } as Context, next);
    await middleware({ update: { update_id: 1 } } as Context, next);

    expect(next).toHaveBeenCalledTimes(4);
  });

  it('calls next when update_id is missing', async () => {
    const middleware = createUpdateIdDedupMiddleware();
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware({ update: {} } as Context, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('deduplicates updates across different handlers on the same bot', async () => {
    const store = openStore(':memory:');
    try {
      const pairingService = createPairingService(store, { ttlMinutes: 10 });
      const code = pairingService.generatePairingCode('session-1');
      const config: Config = {
        telegramBotToken: 'test-token',
        databasePath: ':memory:',
        pairingCodeTtlMinutes: 10,
        logLevel: 'info',
        kimiServerUrl: 'http://localhost:58627',
        kimiBearerToken: 'kimi-token',
        kimiTokenFile: '~/.kimi-code/token',
      };
      const kimiClient = createMockKimiClient();
      const bot = createBot(config, pairingService, store, kimiClient, silentLogger);

      bot.botInfo = { ...TEST_BOT_INFO };

      const sentMessages: unknown[] = [];
      bot.api.config.use((prev, method, payload) => {
        if (method === 'sendMessage') {
          sentMessages.push(payload);
          return Promise.resolve({
            ok: true,
            result: { message_id: 2, text: (payload as { text?: string }).text ?? '' },
          });
        }
        return prev(method, payload);
      });

      const update = {
        update_id: 1,
        message: {
          message_id: 1,
          text: `/start ${code}`,
          chat: { id: 12345, type: 'private' },
          from: { id: 67890, is_bot: false, first_name: 'Test' },
          date: Math.floor(Date.now() / 1000),
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      };

      await bot.handleUpdate(update);
      await bot.handleUpdate(update);

      expect(sentMessages).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
