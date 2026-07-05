import { getRandomValues } from 'node:crypto';
import type { Store, PendingPairingRequest } from './store.js';

/**
 * Pairing service: generates and validates one-time codes used to link
 * a Telegram chat to a kimi-code session.
 *
 * Codes are 6-character alphanumeric strings, generated with a CSPRNG and
 * discarded after first use or after the configured TTL expires.
 */

export interface PairingService {
  generatePairingCode(sessionId: string): string;
  validatePairingCode(code: string): PendingPairingRequest | null;
}

export interface PairingServiceOptions {
  ttlMinutes: number;
}

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LENGTH = 6;
const MAX_RETRIES = 10;
const REJECT_THRESHOLD = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;

function generateCode(): string {
  let randomBytes = getRandomValues(new Uint8Array(CODE_LENGTH * 2));
  let code = '';
  let index = 0;
  while (code.length < CODE_LENGTH) {
    if (index >= randomBytes.length) {
      randomBytes = getRandomValues(new Uint8Array(CODE_LENGTH * 2));
      index = 0;
    }
    const byte = randomBytes[index++];
    if (byte < REJECT_THRESHOLD) {
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
  }
  return code;
}

export function createPairingService(
  store: Store,
  options: PairingServiceOptions
): PairingService {
  return {
    generatePairingCode(sessionId): string {
      const expiresAt = new Date(Date.now() + options.ttlMinutes * 60 * 1000);

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const code = generateCode();
        try {
          store.createPairingRequest(sessionId, code, expiresAt);
          return code;
        } catch (error) {
          const isDuplicate = error instanceof Error && error.message.includes('UNIQUE constraint failed');
          if (!isDuplicate || attempt === MAX_RETRIES - 1) {
            throw error;
          }
        }
      }

      // Unreachable: the loop always returns a code or throws, but TypeScript
      // cannot prove it. This throw documents the impossible fall-through.
      throw new Error('Failed to generate a unique pairing code');
    },

    validatePairingCode(code): PendingPairingRequest | null {
      const normalized = code.trim().toUpperCase();
      const request = store.getPendingPairingRequestByCode(normalized);
      if (!request) return null;

      const now = new Date();
      if (request.codeExpiresAt <= now) {
        return null;
      }

      return store.consumePairingCode(normalized);
    },
  };
}
