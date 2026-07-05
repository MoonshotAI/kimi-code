import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openStore, type Store } from './store.js';

describe('Store', () => {
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'kimigram-test-'));
    dbPath = join(dir, 'test.db');
    store = openStore(dbPath);
  });

  afterEach(() => {
    store.close();
    const dir = dbPath.substring(0, dbPath.lastIndexOf('/'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('createPairingRequest stores a pending code', () => {
    const request = store.createPairingRequest('session-1', 'ABC123', new Date(Date.now() + 60000));
    expect(request.sessionId).toBe('session-1');
    expect(request.pairingCode).toBe('ABC123');
    expect(request.active).toBe(false);
  });

  it('createPairingRequest upserts pending code for same session', () => {
    store.createPairingRequest('session-1', 'ABC123', new Date(Date.now() + 60000));
    const second = store.createPairingRequest('session-1', 'DEF456', new Date(Date.now() + 120000));
    expect(second.pairingCode).toBe('DEF456');

    const found = store.getPendingPairingRequestByCode('DEF456');
    expect(found?.sessionId).toBe('session-1');
    expect(store.getPendingPairingRequestByCode('ABC123')).toBeNull();
  });

  it('getPendingPairingRequestByCode returns null for consumed code', () => {
    store.createPairingRequest('session-1', 'ABC123', new Date(Date.now() + 60000));
    store.consumePairingCode('ABC123');
    expect(store.getPendingPairingRequestByCode('ABC123')).toBeNull();
  });

  it('consumePairingCode returns null for expired code', () => {
    store.createPairingRequest('session-1', 'ABC123', new Date(Date.now() - 1000));
    expect(store.consumePairingCode('ABC123')).toBeNull();
  });

  it('activatePairingBySession links chat id and marks active', () => {
    store.createPairingRequest('session-1', 'ABC123', new Date(Date.now() + 60000));
    store.consumePairingCode('ABC123');
    const pairing = store.activatePairingBySession('session-1', 12345, 67890);
    expect(pairing.sessionId).toBe('session-1');
    expect(pairing.telegramChatId).toBe(12345);
    expect(pairing.telegramUserId).toBe(67890);
    expect(pairing.active).toBe(true);

    const found = store.getPairingByChatId(12345);
    expect(found?.sessionId).toBe('session-1');
  });

  it('activatePairingBySession replaces old pairing for same chat id', () => {
    store.createPairingRequest('session-1', 'ABC123', new Date(Date.now() + 60000));
    store.consumePairingCode('ABC123');
    store.activatePairingBySession('session-1', 12345, 1);

    store.createPairingRequest('session-2', 'DEF456', new Date(Date.now() + 60000));
    store.consumePairingCode('DEF456');
    const pairing = store.activatePairingBySession('session-2', 12345, 2);

    expect(pairing.sessionId).toBe('session-2');
    const found = store.getPairingByChatId(12345);
    expect(found?.sessionId).toBe('session-2');

    const oldSession = store.getPairingBySessionId('session-1');
    expect(oldSession?.telegramChatId).toBeNull();
    expect(oldSession?.active).toBe(false);
  });

  it('getPairingByChatId returns null for unknown chat', () => {
    const found = store.getPairingByChatId(99999);
    expect(found).toBeNull();
  });

  it('getPairingBySessionId returns null for unknown session', () => {
    const found = store.getPairingBySessionId('unknown');
    expect(found).toBeNull();
  });

  it('activatePairingBySession throws for non-existent session', () => {
    expect(() => store.activatePairingBySession('missing', 12345, 1)).toThrow(
      'Failed to activate pairing for session'
    );
  });

  it('deactivatePairing disables notifications for a chat', () => {
    store.createPairingRequest('session-1', 'ABC123', new Date(Date.now() + 60000));
    store.consumePairingCode('ABC123');
    store.activatePairingBySession('session-1', 12345, 1);
    store.deactivatePairing(12345);

    const found = store.getPairingByChatId(12345);
    expect(found?.active).toBe(false);
  });

  describe('thread mappings', () => {
    it('saves and retrieves a mapping by Telegram message id', () => {
      const saved = store.saveThreadMapping({
        sessionId: 'session-1',
        telegramChatId: 12345,
        telegramMessageId: 42,
        kimiMessageId: 'kimi-42',
        direction: 'telegram_to_kimi',
      });
      expect(saved.sessionId).toBe('session-1');
      expect(saved.telegramChatId).toBe(12345);
      expect(saved.telegramMessageId).toBe(42);
      expect(saved.kimiMessageId).toBe('kimi-42');
      expect(saved.direction).toBe('telegram_to_kimi');

      const found = store.getThreadMappingByTelegramMessageId('session-1', 12345, 42);
      expect(found?.kimiMessageId).toBe('kimi-42');
    });

    it('saves and retrieves a mapping by kimi message id', () => {
      store.saveThreadMapping({
        sessionId: 'session-1',
        telegramChatId: 12345,
        telegramMessageId: 43,
        kimiMessageId: 'kimi-43',
        direction: 'kimi_to_telegram',
      });

      const found = store.getThreadMappingByKimiMessageId('session-1', 12345, 'kimi-43');
      expect(found?.telegramMessageId).toBe(43);
      expect(found?.direction).toBe('kimi_to_telegram');
    });

    it('returns null for unknown mappings', () => {
      expect(store.getThreadMappingByTelegramMessageId('session-1', 12345, 999)).toBeNull();
      expect(store.getThreadMappingByKimiMessageId('session-1', 12345, 'missing')).toBeNull();
    });

    it('upserts a mapping when the same telegram message id is saved again', () => {
      store.saveThreadMapping({
        sessionId: 'session-1',
        telegramChatId: 12345,
        telegramMessageId: 44,
        kimiMessageId: 'kimi-44',
        direction: 'telegram_to_kimi',
      });
      store.saveThreadMapping({
        sessionId: 'session-1',
        telegramChatId: 12345,
        telegramMessageId: 44,
        kimiMessageId: 'kimi-44-updated',
        direction: 'telegram_to_kimi',
      });

      const found = store.getThreadMappingByTelegramMessageId('session-1', 12345, 44);
      expect(found?.kimiMessageId).toBe('kimi-44-updated');
    });

    it('upserts a mapping when the same kimi message id is saved again', () => {
      store.saveThreadMapping({
        sessionId: 'session-1',
        telegramChatId: 12345,
        telegramMessageId: 45,
        kimiMessageId: 'kimi-45',
        direction: 'telegram_to_kimi',
      });
      store.saveThreadMapping({
        sessionId: 'session-1',
        telegramChatId: 12345,
        telegramMessageId: 46,
        kimiMessageId: 'kimi-45',
        direction: 'telegram_to_kimi',
      });

      const foundByTelegram = store.getThreadMappingByTelegramMessageId('session-1', 12345, 46);
      expect(foundByTelegram?.kimiMessageId).toBe('kimi-45');
      expect(store.getThreadMappingByTelegramMessageId('session-1', 12345, 45)).toBeNull();
    });

    it('isolates mappings by chat id', () => {
      store.saveThreadMapping({
        sessionId: 'session-1',
        telegramChatId: 11111,
        telegramMessageId: 100,
        kimiMessageId: 'kimi-100',
        direction: 'kimi_to_telegram',
      });
      store.saveThreadMapping({
        sessionId: 'session-1',
        telegramChatId: 22222,
        telegramMessageId: 100,
        kimiMessageId: 'kimi-200',
        direction: 'kimi_to_telegram',
      });

      const found = store.getThreadMappingByTelegramMessageId('session-1', 22222, 100);
      expect(found?.kimiMessageId).toBe('kimi-200');
    });

    it('throws when saving a mapping with invalid ids', () => {
      expect(() =>
        store.saveThreadMapping({
          sessionId: '',
          telegramChatId: 12345,
          telegramMessageId: 1,
          kimiMessageId: 'kimi-1',
          direction: 'telegram_to_kimi',
        })
      ).toThrow(/sessionId/);

      expect(() =>
        store.saveThreadMapping({
          sessionId: 'session-1',
          telegramChatId: 0,
          telegramMessageId: 1,
          kimiMessageId: 'kimi-1',
          direction: 'telegram_to_kimi',
        })
      ).toThrow(/telegramChatId/);

      expect(() =>
        store.saveThreadMapping({
          sessionId: 'session-1',
          telegramChatId: 12345,
          telegramMessageId: -1,
          kimiMessageId: 'kimi-1',
          direction: 'telegram_to_kimi',
        })
      ).toThrow(/telegramMessageId/);

      expect(() =>
        store.saveThreadMapping({
          sessionId: 'session-1',
          telegramChatId: 12345,
          telegramMessageId: 1,
          kimiMessageId: '  ',
          direction: 'telegram_to_kimi',
        })
      ).toThrow(/kimiMessageId/);
    });
  });
});
