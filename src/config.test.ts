import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { homedir } from 'os';
import { join } from 'path';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  const originalEnv = process.env;
  let tempDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    tempDir = mkdtempSync(join(tmpdir(), 'kimigram-config-test-'));
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DATABASE_PATH;
    delete process.env.PAIRING_CODE_TTL_MINUTES;
    delete process.env.LOG_LEVEL;
    delete process.env.KIMI_SERVER_URL;
    delete process.env.KIMI_BEARER_TOKEN;
    delete process.env.KIMI_TOKEN_FILE;
    delete process.env.KIMI_WS_AUTH_MODE;
    // Most tests do not care about the kimi token; provide a default so the
    // bearer-token requirement does not interfere with unrelated assertions.
    process.env.KIMI_BEARER_TOKEN = 'default-kimi-token';
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('throws when TELEGRAM_BOT_TOKEN is missing', () => {
    expect(() => loadConfig()).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('throws when TELEGRAM_BOT_TOKEN is empty', () => {
    process.env.TELEGRAM_BOT_TOKEN = '';
    expect(() => loadConfig()).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('returns defaults for optional values', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    const config = loadConfig();
    expect(config.databasePath).toBe('./data/kimigram.db');
    expect(config.pairingCodeTtlMinutes).toBe(10);
    expect(config.logLevel).toBe('info');
  });

  it('parses custom values from environment', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.DATABASE_PATH = '/custom/db.sqlite';
    process.env.PAIRING_CODE_TTL_MINUTES = '5';
    process.env.LOG_LEVEL = 'debug';

    const config = loadConfig();
    expect(config.databasePath).toBe('/custom/db.sqlite');
    expect(config.pairingCodeTtlMinutes).toBe(5);
    expect(config.logLevel).toBe('debug');
  });

  it('throws for invalid numeric config values', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.PAIRING_CODE_TTL_MINUTES = 'not-a-number';
    expect(() => loadConfig()).toThrow(/PAIRING_CODE_TTL_MINUTES/);
  });

  it('throws for zero ttl', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.PAIRING_CODE_TTL_MINUTES = '0';
    expect(() => loadConfig()).toThrow(/PAIRING_CODE_TTL_MINUTES/);
  });

  it('throws for negative ttl', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.PAIRING_CODE_TTL_MINUTES = '-1';
    expect(() => loadConfig()).toThrow(/PAIRING_CODE_TTL_MINUTES/);
  });

  it('throws for non-integer ttl', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.PAIRING_CODE_TTL_MINUTES = '1.5';
    expect(() => loadConfig()).toThrow(/PAIRING_CODE_TTL_MINUTES/);
  });

  it('throws for invalid log level', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.LOG_LEVEL = 'verbose';
    expect(() => loadConfig()).toThrow(/LOG_LEVEL/);
  });

  it('loads default kimi server URL', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.KIMI_BEARER_TOKEN = 'kimi-token';
    const config = loadConfig();
    expect(config.kimiServerUrl).toBe('http://127.0.0.1:58627');
  });

  it('loads kimi bearer token from environment', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.KIMI_BEARER_TOKEN = 'env-token';
    const config = loadConfig();
    expect(config.kimiBearerToken).toBe('env-token');
  });

  it('loads kimi bearer token from file when env is not set', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    delete process.env.KIMI_BEARER_TOKEN;
    const tokenPath = join(tempDir, 'token');
    writeFileSync(tokenPath, 'file-token');
    process.env.KIMI_TOKEN_FILE = tokenPath;

    const config = loadConfig();
    expect(config.kimiBearerToken).toBe('file-token');
  });

  it('trims trailing newline from token file', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    delete process.env.KIMI_BEARER_TOKEN;
    const tokenPath = join(tempDir, 'token');
    writeFileSync(tokenPath, 'file-token\n');
    process.env.KIMI_TOKEN_FILE = tokenPath;

    const config = loadConfig();
    expect(config.kimiBearerToken).toBe('file-token');
  });

  it('throws when bearer token is missing and token file cannot be read', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    delete process.env.KIMI_BEARER_TOKEN;
    process.env.KIMI_TOKEN_FILE = join(tempDir, 'missing-token');
    expect(() => loadConfig()).toThrow(/token/i);
  });

  it('normalizes trailing slash on kimi server URL', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.KIMI_BEARER_TOKEN = 'kimi-token';
    process.env.KIMI_SERVER_URL = 'http://localhost:8080/';
    const config = loadConfig();
    expect(config.kimiServerUrl).toBe('http://localhost:8080');
  });

  it('throws for invalid kimi server URL', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.KIMI_BEARER_TOKEN = 'kimi-token';
    process.env.KIMI_SERVER_URL = 'not-a-url';
    expect(() => loadConfig()).toThrow(/KIMI_SERVER_URL/);
  });

  it('derives ws URL from http server URL', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.KIMI_BEARER_TOKEN = 'kimi-token';
    process.env.KIMI_SERVER_URL = 'http://localhost:8080/';
    const config = loadConfig();
    expect(config.kimiWsUrl).toBe('ws://localhost:8080');
  });

  it('derives wss URL from https server URL', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.KIMI_BEARER_TOKEN = 'kimi-token';
    process.env.KIMI_SERVER_URL = 'https://example.com/';
    const config = loadConfig();
    expect(config.kimiWsUrl).toBe('wss://example.com');
  });

  it('defaults WebSocket auth mode to subprotocol', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.KIMI_BEARER_TOKEN = 'kimi-token';
    const config = loadConfig();
    expect(config.kimiWsAuthMode).toBe('subprotocol');
  });

  it('loads WebSocket auth mode from environment', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.KIMI_BEARER_TOKEN = 'kimi-token';
    process.env.KIMI_WS_AUTH_MODE = 'query';
    const config = loadConfig();
    expect(config.kimiWsAuthMode).toBe('query');
  });

  it('throws for invalid WebSocket auth mode', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.KIMI_BEARER_TOKEN = 'kimi-token';
    process.env.KIMI_WS_AUTH_MODE = 'invalid';
    expect(() => loadConfig()).toThrow(/KIMI_WS_AUTH_MODE/);
  });

  it('throws for empty WebSocket auth mode string', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.KIMI_BEARER_TOKEN = 'kimi-token';
    process.env.KIMI_WS_AUTH_MODE = '';
    expect(() => loadConfig()).toThrow(/KIMI_WS_AUTH_MODE/);
  });

  it('throws when bearer token env is whitespace only', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.KIMI_BEARER_TOKEN = '   ';
    expect(() => loadConfig()).toThrow(/token/i);
  });

  it('throws when token file is empty', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    delete process.env.KIMI_BEARER_TOKEN;
    const tokenPath = join(tempDir, 'empty-token');
    writeFileSync(tokenPath, '');
    process.env.KIMI_TOKEN_FILE = tokenPath;
    expect(() => loadConfig()).toThrow(/token/i);
  });

  it('falls back to token file when env bearer token is empty string', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.KIMI_BEARER_TOKEN = '';
    const tokenPath = join(tempDir, 'fallback-token');
    writeFileSync(tokenPath, 'fallback');
    process.env.KIMI_TOKEN_FILE = tokenPath;

    const config = loadConfig();
    expect(config.kimiBearerToken).toBe('fallback');
  });

  it('expands tilde in token file path', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    delete process.env.KIMI_BEARER_TOKEN;
    const tokenPath = join(homedir(), 'kimigram-test-token');
    writeFileSync(tokenPath, 'homedir-token');
    process.env.KIMI_TOKEN_FILE = '~/kimigram-test-token';

    try {
      const config = loadConfig();
      expect(config.kimiBearerToken).toBe('homedir-token');
    } finally {
      rmSync(tokenPath, { force: true });
    }
  });
});
