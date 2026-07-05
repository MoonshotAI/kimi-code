import { describe, it, expect, vi } from 'vitest';
import { createEventDispatcher, type BotApi } from './events.js';
import type { KimiEvent } from './ws.js';
import type { Pairing, Store } from '../store.js';
import type { Logger } from './ws.js';

function createFakeStore(pairing: Pairing | null = null): Store {
  return {
    getPairingBySessionId: vi.fn(() => pairing),
    createPairingRequest: vi.fn(),
    getPendingPairingRequestByCode: vi.fn(),
    consumePairingCode: vi.fn(),
    activatePairingBySession: vi.fn(),
    getPairingByChatId: vi.fn(),
    deactivatePairing: vi.fn(),
    saveThreadMapping: vi.fn((m) => ({ ...m, id: 'mapping-1', createdAt: new Date() })),
    getThreadMappingByTelegramMessageId: vi.fn(),
    getThreadMappingByKimiMessageId: vi.fn(),
    close: vi.fn(),
  };
}

function createFakeBotApi(): BotApi {
  return {
    sendMessage: vi.fn(() => Promise.resolve({ message_id: 1 })),
  };
}

const silentLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createActivePairing(sessionId: string): Pairing {
  return {
    id: 'pairing-1',
    sessionId,
    telegramChatId: 12345,
    telegramUserId: 67890,
    pairingCode: null,
    codeExpiresAt: null,
    pairedAt: new Date(),
    active: true,
  };
}

describe('createEventDispatcher', () => {
  it('sends a notification for turn.ended', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({ type: 'turn.ended', payload: {}, sessionId: 'session-1' });

    await Promise.resolve();
    expect(botApi.sendMessage).toHaveBeenCalledWith(12345, 'Turn completed.', undefined);
  });

  it('saves a thread mapping for outgoing notifications with a message id', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({
      type: 'turn.ended',
      payload: { message_id: 'kimi-100' },
      sessionId: 'session-1',
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(store.saveThreadMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        telegramChatId: 12345,
        telegramMessageId: 1,
        kimiMessageId: 'kimi-100',
        direction: 'kimi_to_telegram',
      })
    );
  });

  it('replies to the original Telegram message when a parent mapping exists', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    store.getThreadMappingByKimiMessageId = vi.fn((_, chatId) => ({
      id: 'mapping-1',
      sessionId: 'session-1',
      telegramChatId: chatId,
      telegramMessageId: 50,
      kimiMessageId: 'kimi-parent',
      direction: 'telegram_to_kimi',
      createdAt: new Date(),
    }));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({
      type: 'turn.ended',
      payload: { parent_message_id: 'kimi-parent' },
      sessionId: 'session-1',
    });

    await Promise.resolve();
    expect(store.getThreadMappingByKimiMessageId).toHaveBeenCalledWith('session-1', 12345, 'kimi-parent');
    expect(botApi.sendMessage).toHaveBeenCalledWith(
      12345,
      'Turn completed.',
      { reply_parameters: { message_id: 50 } }
    );
  });

  it('omits reply parameters when the parent mapping is unknown', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    store.getThreadMappingByKimiMessageId = vi.fn(() => null);
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({
      type: 'turn.ended',
      payload: { parent_message_id: 'kimi-unknown' },
      sessionId: 'session-1',
    });

    await Promise.resolve();
    expect(botApi.sendMessage).toHaveBeenCalledWith(
      12345,
      'Turn completed.',
      undefined
    );
  });

  it('sends a notification for task.completed', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({ type: 'task.completed', payload: {}, sessionId: 'session-1' });

    await Promise.resolve();
    expect(botApi.sendMessage).toHaveBeenCalledWith(12345, 'Task completed.', undefined);
  });

  it('sends a notification for background.task.terminated', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({
      type: 'background.task.terminated',
      payload: {},
      sessionId: 'session-1',
    });

    await Promise.resolve();
    expect(botApi.sendMessage).toHaveBeenCalledWith(12345, 'Task completed.', undefined);
  });

  it('sends a notification when goal.updated status is completed', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({
      type: 'goal.updated',
      payload: { status: 'completed' },
      sessionId: 'session-1',
    });

    await Promise.resolve();
    expect(botApi.sendMessage).toHaveBeenCalledWith(12345, 'Goal completed.', undefined);
  });

  it('ignores goal.updated when status is not completed', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({
      type: 'goal.updated',
      payload: { status: 'in_progress' },
      sessionId: 'session-1',
    });

    await Promise.resolve();
    expect(botApi.sendMessage).not.toHaveBeenCalled();
  });

  it('sends a notification for approval.requested with summary', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({
      type: 'approval.requested',
      payload: { summary: 'Deploy to production?' },
      sessionId: 'session-1',
    });

    await Promise.resolve();
    expect(botApi.sendMessage).toHaveBeenCalledWith(
      12345,
      'Approval requested: Deploy to production?',
      undefined
    );
  });

  it('sends a default notification for event.approval.requested without summary', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({
      type: 'event.approval.requested',
      payload: {},
      sessionId: 'session-1',
    });

    await Promise.resolve();
    expect(botApi.sendMessage).toHaveBeenCalledWith(12345, 'Approval requested.', undefined);
  });

  it('sends a default notification for approval.requested without summary', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({
      type: 'approval.requested',
      payload: {},
      sessionId: 'session-1',
    });

    await Promise.resolve();
    expect(botApi.sendMessage).toHaveBeenCalledWith(12345, 'Approval requested.', undefined);
  });

  it('sends a notification for event.approval.requested with summary', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({
      type: 'event.approval.requested',
      payload: { summary: 'Continue?' },
      sessionId: 'session-1',
    });

    await Promise.resolve();
    expect(botApi.sendMessage).toHaveBeenCalledWith(
      12345,
      'Approval requested: Continue?',
      undefined
    );
  });

  it('ignores unknown event types', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({
      type: 'assistant.delta',
      payload: { delta: 'hello' },
      sessionId: 'session-1',
    });

    await Promise.resolve();
    expect(botApi.sendMessage).not.toHaveBeenCalled();
  });

  it('ignores events for unpaired sessions', async () => {
    const store = createFakeStore(null);
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({ type: 'turn.ended', payload: {}, sessionId: 'session-1' });

    await Promise.resolve();
    expect(botApi.sendMessage).not.toHaveBeenCalled();
  });

  it('ignores events for inactive pairings', async () => {
    const pairing = createActivePairing('session-1');
    pairing.active = false;
    const store = createFakeStore(pairing);
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({ type: 'turn.ended', payload: {}, sessionId: 'session-1' });

    await Promise.resolve();
    expect(botApi.sendMessage).not.toHaveBeenCalled();
  });

  it('ignores events when telegramChatId is null', async () => {
    const pairing = createActivePairing('session-1');
    pairing.telegramChatId = null;
    const store = createFakeStore(pairing);
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({ type: 'turn.ended', payload: {}, sessionId: 'session-1' });

    await Promise.resolve();
    expect(botApi.sendMessage).not.toHaveBeenCalled();
  });

  it('ignores events without a sessionId', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({ type: 'turn.ended', payload: {} });

    await Promise.resolve();
    expect(botApi.sendMessage).not.toHaveBeenCalled();
  });

  it('logs when sendMessage rejects', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    const botApi = createFakeBotApi();
    botApi.sendMessage = vi.fn(() => Promise.reject(new Error('telegram down')));
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const dispatch = createEventDispatcher(store, botApi, { logger });

    dispatch({ type: 'turn.ended', payload: {}, sessionId: 'session-1' });

    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        chatId: 12345,
        error: expect.any(Error),
      }),
      'Failed to send Telegram notification'
    );
  });

  it('logs when sendMessage throws synchronously', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    const botApi = createFakeBotApi();
    botApi.sendMessage = vi.fn(() => {
      throw new Error('sync boom');
    });
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const dispatch = createEventDispatcher(store, botApi, { logger });

    dispatch({ type: 'turn.ended', payload: {}, sessionId: 'session-1' });

    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        chatId: 12345,
        error: expect.any(Error),
      }),
      'Failed to send Telegram notification'
    );
  });

  it('logs when saving the outgoing thread mapping fails', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    store.saveThreadMapping = vi.fn(() => {
      throw new Error('db locked');
    });
    const botApi = createFakeBotApi();
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const dispatch = createEventDispatcher(store, botApi, { logger });

    dispatch({
      type: 'turn.ended',
      payload: { message_id: 'kimi-100' },
      sessionId: 'session-1',
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        chatId: 12345,
        error: expect.any(Error),
      }),
      'Failed to save outgoing thread mapping'
    );
  });

  it('uses payload.id as the outgoing message id when message_id is absent', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({
      type: 'turn.ended',
      payload: { id: 'kimi-200' },
      sessionId: 'session-1',
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(store.saveThreadMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        kimiMessageId: 'kimi-200',
      })
    );
  });

  it('uses payload.reply_to_message_id as the parent id when parent_message_id is absent', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    store.getThreadMappingByKimiMessageId = vi.fn((_, chatId) => ({
      id: 'mapping-1',
      sessionId: 'session-1',
      telegramChatId: chatId,
      telegramMessageId: 60,
      kimiMessageId: 'kimi-parent',
      direction: 'telegram_to_kimi',
      createdAt: new Date(),
    }));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({
      type: 'turn.ended',
      payload: { reply_to_message_id: 'kimi-parent' },
      sessionId: 'session-1',
    });

    await Promise.resolve();
    expect(botApi.sendMessage).toHaveBeenCalledWith(
      12345,
      expect.any(String),
      { reply_parameters: { message_id: 60 } }
    );
  });

  it('sends assistant.message text with MarkdownV2 parse mode', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({
      type: 'assistant.message',
      payload: { text: 'Hello **world**' },
      sessionId: 'session-1',
    });

    await Promise.resolve();
    expect(botApi.sendMessage).toHaveBeenCalledWith(
      12345,
      'Hello *world*',
      { parse_mode: 'MarkdownV2' }
    );
  });

  it('prefers payload.markdown over payload.text for assistant messages', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({
      type: 'assistant.message',
      payload: { text: 'plain', markdown: '_italic_' },
      sessionId: 'session-1',
    });

    await Promise.resolve();
    expect(botApi.sendMessage).toHaveBeenCalledWith(
      12345,
      '_italic_',
      { parse_mode: 'MarkdownV2' }
    );
  });

  it('falls back to plain text when assistant markdown is malformed', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({
      type: 'assistant.message',
      payload: { text: '`unclosed code' },
      sessionId: 'session-1',
    });

    await Promise.resolve();
    expect(botApi.sendMessage).toHaveBeenCalledWith(
      12345,
      '`unclosed code',
      undefined
    );
  });

  it('ignores assistant.message events with no text', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({
      type: 'assistant.message',
      payload: {},
      sessionId: 'session-1',
    });

    await Promise.resolve();
    expect(botApi.sendMessage).not.toHaveBeenCalled();
  });

  it('includes both reply_parameters and parse_mode for threaded assistant messages', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    store.getThreadMappingByKimiMessageId = vi.fn((_, chatId) => ({
      id: 'mapping-1',
      sessionId: 'session-1',
      telegramChatId: chatId,
      telegramMessageId: 70,
      kimiMessageId: 'kimi-parent',
      direction: 'telegram_to_kimi',
      createdAt: new Date(),
    }));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({
      type: 'assistant.message',
      payload: { text: 'Reply with **bold**', parent_message_id: 'kimi-parent' },
      sessionId: 'session-1',
    });

    await Promise.resolve();
    expect(botApi.sendMessage).toHaveBeenCalledWith(
      12345,
      'Reply with *bold*',
      { reply_parameters: { message_id: 70 }, parse_mode: 'MarkdownV2' }
    );
  });

  it('falls back to reply_to_message_id for assistant message threading', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    store.getThreadMappingByKimiMessageId = vi.fn((_, chatId) => ({
      id: 'mapping-1',
      sessionId: 'session-1',
      telegramChatId: chatId,
      telegramMessageId: 80,
      kimiMessageId: 'kimi-parent',
      direction: 'telegram_to_kimi',
      createdAt: new Date(),
    }));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({
      type: 'assistant.message',
      payload: { text: 'Reply', reply_to_message_id: 'kimi-parent' },
      sessionId: 'session-1',
    });

    await Promise.resolve();
    expect(botApi.sendMessage).toHaveBeenCalledWith(
      12345,
      'Reply',
      { reply_parameters: { message_id: 80 }, parse_mode: 'MarkdownV2' }
    );
  });

  it('saves a thread mapping for outgoing assistant messages with a message id', async () => {
    const store = createFakeStore(createActivePairing('session-1'));
    const botApi = createFakeBotApi();
    const dispatch = createEventDispatcher(store, botApi, { logger: silentLogger });

    dispatch({
      type: 'assistant.message',
      payload: { text: 'Hello', message_id: 'kimi-300' },
      sessionId: 'session-1',
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(store.saveThreadMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        telegramChatId: 12345,
        telegramMessageId: 1,
        kimiMessageId: 'kimi-300',
        direction: 'kimi_to_telegram',
      })
    );
  });
});
