import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getRandomValues } from 'node:crypto';
import { openStore, type Store } from './store.js';
import { createPairingService, type PairingService } from './pairing.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    getRandomValues: vi.fn(actual.getRandomValues),
  };
});

describe('PairingService', () => {
  let dbPath: string;
  let store: Store;
  let service: PairingService;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'kimigram-test-'));
    dbPath = join(dir, 'test.db');
    store = openStore(dbPath);
    service = createPairingService(store, { ttlMinutes: 10 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    const dir = dbPath.substring(0, dbPath.lastIndexOf('/'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('generatePairingCode creates unique codes', () => {
    const code1 = service.generatePairingCode('session-1');
    const code2 = service.generatePairingCode('session-2');
    expect(code1).toHaveLength(6);
    expect(code2).toHaveLength(6);
    expect(code1).not.toBe(code2);
    expect(code1).toMatch(/^[A-Z0-9]{6}$/);
    expect(code2).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('generatePairingCode retries on collision and eventually succeeds', () => {
    let callIndex = 0;
    const values = [0, 0, 1]; // AAAAAA, AAAAAA (collision), BBBBBB
    vi.mocked(getRandomValues).mockImplementation((array) => {
      const view = array as Uint8Array;
      const value = values[callIndex] ?? 0;
      view.fill(value);
      callIndex++;
      return array;
    });

    const code1 = service.generatePairingCode('session-1');
    expect(code1).toBe('AAAAAA');

    const code2 = service.generatePairingCode('session-2');
    expect(code2).toBe('BBBBBB');
  });

  it('generatePairingCode throws after exhausting collision retries', () => {
    vi.mocked(getRandomValues).mockImplementation((array) => {
      const view = array as Uint8Array;
      view.fill(5); // always 'FFFFF'
      return array;
    });

    service.generatePairingCode('session-1');
    expect(() => service.generatePairingCode('session-2')).toThrow(
      /UNIQUE constraint failed/
    );
  });

  it('generatePairingCode rethrows non-duplicate errors immediately', () => {
    let calls = 0;
    const throwingStore: Store = {
      ...store,
      createPairingRequest: () => {
        calls++;
        throw new Error('database is down');
      },
    };
    const failingService = createPairingService(throwingStore, {
      ttlMinutes: 10,
    });

    expect(() => failingService.generatePairingCode('session-1')).toThrow(
      'database is down'
    );
    expect(calls).toBe(1);
  });

  it('validatePairingCode returns session for valid code', () => {
    const code = service.generatePairingCode('session-1');
    const request = service.validatePairingCode(code);
    expect(request).not.toBeNull();
    expect(request?.sessionId).toBe('session-1');
  });

  it('validatePairingCode returns null after expiry', () => {
    vi.useFakeTimers();
    try {
      const code = service.generatePairingCode('session-1');
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      const request = service.validatePairingCode(code);
      expect(request).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('validatePairingCode returns null exactly at expiry boundary', () => {
    vi.useFakeTimers();
    try {
      const code = service.generatePairingCode('session-1');
      vi.advanceTimersByTime(10 * 60 * 1000);
      const request = service.validatePairingCode(code);
      expect(request).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('validatePairingCode is case insensitive', () => {
    const code = service.generatePairingCode('session-1');
    const request = service.validatePairingCode(code.toLowerCase());
    expect(request?.sessionId).toBe('session-1');
  });

  it('validatePairingCode trims whitespace', () => {
    const code = service.generatePairingCode('session-1');
    const request = service.validatePairingCode(`  ${code}  `);
    expect(request?.sessionId).toBe('session-1');
  });

  it('validatePairingCode returns null for unknown code', () => {
    const request = service.validatePairingCode('UNKNOWN');
    expect(request).toBeNull();
  });

  it('validatePairingCode returns null for reused code', () => {
    const code = service.generatePairingCode('session-1');
    const firstRequest = service.validatePairingCode(code);
    expect(firstRequest?.sessionId).toBe('session-1');

    const secondRequest = service.validatePairingCode(code);
    expect(secondRequest).toBeNull();
  });
});
