import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'node:crypto';

/**
 * SQLite-backed store for Telegram ↔ kimi-code pairings.
 *
 * A pairing starts as a pending request with a single-use, expiring code.
 * Once the user sends `/start <code>` in Telegram, the code is consumed and
 * the pairing is activated with the Telegram chat/user IDs.
 */

export interface Pairing {
  id: string;
  sessionId: string;
  telegramChatId: number | null;
  telegramUserId: number | null;
  pairingCode: string | null;
  codeExpiresAt: Date | null;
  pairedAt: Date | null;
  active: boolean;
}

export interface PendingPairingRequest {
  id: string;
  sessionId: string;
  pairingCode: string | null;
  codeExpiresAt: Date;
  active: false;
}

export interface ThreadMapping {
  id: string;
  sessionId: string;
  telegramChatId: number;
  telegramMessageId: number;
  kimiMessageId: string;
  direction: 'telegram_to_kimi' | 'kimi_to_telegram';
  createdAt: Date;
}

export interface Store {
  createPairingRequest(sessionId: string, pairingCode: string, expiresAt: Date): PendingPairingRequest;
  getPendingPairingRequestByCode(pairingCode: string): PendingPairingRequest | null;
  consumePairingCode(pairingCode: string): PendingPairingRequest | null;
  activatePairingBySession(sessionId: string, telegramChatId: number, telegramUserId: number | null): Pairing;
  getPairingByChatId(telegramChatId: number): Pairing | null;
  getPairingBySessionId(sessionId: string): Pairing | null;
  deactivatePairing(telegramChatId: number): void;
  saveThreadMapping(mapping: Omit<ThreadMapping, 'id' | 'createdAt'>): ThreadMapping;
  getThreadMappingByTelegramMessageId(sessionId: string, telegramChatId: number, telegramMessageId: number): ThreadMapping | null;
  getThreadMappingByKimiMessageId(sessionId: string, telegramChatId: number, kimiMessageId: string): ThreadMapping | null;
  close(): void;
}

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS pairings (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  telegram_chat_id INTEGER UNIQUE,
  telegram_user_id INTEGER,
  pairing_code TEXT UNIQUE,
  code_expires_at DATETIME,
  paired_at DATETIME,
  active BOOLEAN DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_pairings_code ON pairings(pairing_code);
CREATE INDEX IF NOT EXISTS idx_pairings_session ON pairings(session_id);

CREATE TABLE IF NOT EXISTS thread_mappings (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  telegram_chat_id INTEGER NOT NULL,
  telegram_message_id INTEGER NOT NULL,
  kimi_message_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, telegram_chat_id, telegram_message_id),
  UNIQUE(session_id, telegram_chat_id, kimi_message_id)
);
CREATE INDEX IF NOT EXISTS idx_thread_mappings_telegram ON thread_mappings(session_id, telegram_chat_id, telegram_message_id);
CREATE INDEX IF NOT EXISTS idx_thread_mappings_kimi ON thread_mappings(session_id, telegram_chat_id, kimi_message_id);
`;

function toPairing(row: Record<string, unknown>): Pairing {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    telegramChatId: row.telegram_chat_id == null ? null : Number(row.telegram_chat_id),
    telegramUserId: row.telegram_user_id == null ? null : Number(row.telegram_user_id),
    pairingCode: row.pairing_code == null ? null : String(row.pairing_code),
    codeExpiresAt: row.code_expires_at == null ? null : new Date(String(row.code_expires_at)),
    pairedAt: row.paired_at == null ? null : new Date(String(row.paired_at)),
    active: Boolean(row.active),
  };
}

function toThreadMapping(row: Record<string, unknown>): ThreadMapping {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    telegramChatId: Number(row.telegram_chat_id),
    telegramMessageId: Number(row.telegram_message_id),
    kimiMessageId: String(row.kimi_message_id),
    direction: String(row.direction) as ThreadMapping['direction'],
    createdAt: new Date(String(row.created_at)),
  };
}

function toPendingRequest(row: Record<string, unknown>): PendingPairingRequest {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    pairingCode: row.pairing_code == null ? null : String(row.pairing_code),
    codeExpiresAt: new Date(String(row.code_expires_at)),
    active: false,
  };
}

export function openStore(databasePath: string): Store {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.exec(MIGRATION_SQL);

  const insertRequest = db.prepare(
    `INSERT INTO pairings (id, session_id, pairing_code, code_expires_at, active)
     VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(session_id) DO UPDATE SET
       pairing_code = excluded.pairing_code,
       code_expires_at = excluded.code_expires_at,
       active = 0,
       telegram_chat_id = NULL,
       telegram_user_id = NULL,
       paired_at = NULL
     RETURNING *`
  );

  const findByCode = db.prepare(
    `SELECT * FROM pairings WHERE pairing_code = ?`
  );

  const consumeCode = db.prepare(
    `UPDATE pairings
     SET pairing_code = NULL
     WHERE pairing_code = ? AND code_expires_at > datetime('now')
     RETURNING *`
  );

  const activateBySession = db.prepare(
    `UPDATE pairings
     SET telegram_chat_id = ?, telegram_user_id = ?, paired_at = datetime('now'), active = 1
     WHERE session_id = ? AND active = 0
     RETURNING *`
  );

  const clearChatId = db.prepare(
    `UPDATE pairings SET telegram_chat_id = NULL, telegram_user_id = NULL, active = 0 WHERE telegram_chat_id = ?`
  );

  const findByChatId = db.prepare(
    `SELECT * FROM pairings WHERE telegram_chat_id = ?`
  );

  const findBySessionId = db.prepare(
    `SELECT * FROM pairings WHERE session_id = ?`
  );

  const deactivate = db.prepare(
    `UPDATE pairings SET active = 0 WHERE telegram_chat_id = ?`
  );

  const insertThreadMapping = db.prepare(
    `INSERT INTO thread_mappings (id, session_id, telegram_chat_id, telegram_message_id, kimi_message_id, direction)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, telegram_chat_id, telegram_message_id) DO UPDATE SET
       kimi_message_id = excluded.kimi_message_id,
       direction = excluded.direction,
       created_at = CURRENT_TIMESTAMP
     ON CONFLICT(session_id, telegram_chat_id, kimi_message_id) DO UPDATE SET
       telegram_message_id = excluded.telegram_message_id,
       direction = excluded.direction,
       created_at = CURRENT_TIMESTAMP
     RETURNING *`
  );

  const findThreadMappingByTelegram = db.prepare(
    `SELECT * FROM thread_mappings WHERE session_id = ? AND telegram_chat_id = ? AND telegram_message_id = ?`
  );

  const findThreadMappingByKimi = db.prepare(
    `SELECT * FROM thread_mappings WHERE session_id = ? AND telegram_chat_id = ? AND kimi_message_id = ?`
  );

  return {
    createPairingRequest(sessionId, pairingCode, expiresAt): PendingPairingRequest {
      const id = randomUUID();
      const row = insertRequest.get(id, sessionId, pairingCode, expiresAt.toISOString()) as Record<string, unknown>;
      if (!row) throw new Error('Failed to create pairing request');
      return toPendingRequest(row);
    },

    getPendingPairingRequestByCode(pairingCode): PendingPairingRequest | null {
      const row = findByCode.get(pairingCode) as Record<string, unknown> | undefined;
      return row ? toPendingRequest(row) : null;
    },

    consumePairingCode(pairingCode): PendingPairingRequest | null {
      const request = this.getPendingPairingRequestByCode(pairingCode);
      if (!request) return null;
      if (request.codeExpiresAt <= new Date()) return null;

      const row = consumeCode.get(pairingCode) as Record<string, unknown> | undefined;
      return row ? toPendingRequest(row) : null;
    },

    activatePairingBySession(sessionId, telegramChatId, telegramUserId): Pairing {
      const row = db.transaction(() => {
        clearChatId.run(telegramChatId);
        return activateBySession.get(telegramChatId, telegramUserId, sessionId) as Record<string, unknown> | undefined;
      })();
      if (!row) throw new Error('Failed to activate pairing for session');
      return toPairing(row);
    },

    getPairingByChatId(telegramChatId): Pairing | null {
      const row = findByChatId.get(telegramChatId) as Record<string, unknown> | undefined;
      return row ? toPairing(row) : null;
    },

    getPairingBySessionId(sessionId): Pairing | null {
      const row = findBySessionId.get(sessionId) as Record<string, unknown> | undefined;
      return row ? toPairing(row) : null;
    },

    deactivatePairing(telegramChatId): void {
      deactivate.run(telegramChatId);
    },

    saveThreadMapping(mapping): ThreadMapping {
      if (!mapping.sessionId?.trim()) {
        throw new Error('sessionId is required to save a thread mapping');
      }
      if (!mapping.kimiMessageId?.trim()) {
        throw new Error('kimiMessageId is required to save a thread mapping');
      }
      if (mapping.telegramChatId == null || mapping.telegramChatId <= 0) {
        throw new Error('telegramChatId must be a positive integer');
      }
      if (mapping.telegramMessageId == null || mapping.telegramMessageId <= 0) {
        throw new Error('telegramMessageId must be a positive integer');
      }

      const id = randomUUID();
      const row = insertThreadMapping.get(
        id,
        mapping.sessionId,
        mapping.telegramChatId,
        mapping.telegramMessageId,
        mapping.kimiMessageId,
        mapping.direction
      ) as Record<string, unknown> | undefined;
      if (!row) throw new Error('Failed to save thread mapping');
      return toThreadMapping(row);
    },

    getThreadMappingByTelegramMessageId(sessionId, telegramChatId, telegramMessageId): ThreadMapping | null {
      const row = findThreadMappingByTelegram.get(sessionId, telegramChatId, telegramMessageId) as Record<string, unknown> | undefined;
      return row ? toThreadMapping(row) : null;
    },

    getThreadMappingByKimiMessageId(sessionId, telegramChatId, kimiMessageId): ThreadMapping | null {
      const row = findThreadMappingByKimi.get(sessionId, telegramChatId, kimiMessageId) as Record<string, unknown> | undefined;
      return row ? toThreadMapping(row) : null;
    },

    close(): void {
      db.close();
    },
  };
}
