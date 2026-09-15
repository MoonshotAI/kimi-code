import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  IMcpConfigStore,
  McpConfigStore,
  type GlobalMcpServerConfig,
} from '#/app/mcpConfig/configStore';
import { ErrorCodes } from '#/errors';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

const CONFIG_SCOPE = '';
const CONFIG_KEY = 'mcp.json';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function stdioServer(name: string, command = 'npx'): GlobalMcpServerConfig {
  return { name, transport: 'stdio', command };
}

describe('McpConfigStore', () => {
  let disposables: DisposableStore;
  let storage: InMemoryStorageService;
  let store: IMcpConfigStore;

  beforeEach(() => {
    disposables = new DisposableStore();
    storage = new InMemoryStorageService();
    const ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IFileSystemStorageService, storage);
        reg.definePartialInstance(IBootstrapService, { homeDir: '/kimi-test-home' });
        reg.define(IMcpConfigStore, McpConfigStore);
      },
    });
    store = ix.get(IMcpConfigStore);
  });

  afterEach(() => {
    disposables.dispose();
  });

  async function seedRaw(text: string): Promise<void> {
    await storage.write(CONFIG_SCOPE, CONFIG_KEY, textEncoder.encode(text));
  }

  async function seedJson(value: unknown): Promise<void> {
    await seedRaw(JSON.stringify(value));
  }

  async function readRaw(): Promise<string | undefined> {
    const bytes = await storage.read(CONFIG_SCOPE, CONFIG_KEY);
    return bytes === undefined ? undefined : textDecoder.decode(bytes);
  }

  describe('CRUD', () => {
    it('round-trips add → get → update → remove against an empty catalog', async () => {
      await expect(store.list()).resolves.toEqual([]);

      const added = await store.add(stdioServer('alpha'));
      expect(added).toEqual([{ name: 'alpha', transport: 'stdio', command: 'npx' }]);
      await expect(store.get('alpha')).resolves.toEqual({
        name: 'alpha',
        transport: 'stdio',
        command: 'npx',
      });

      const updated = await store.update(stdioServer('alpha', 'node'));
      expect(updated).toEqual([{ name: 'alpha', transport: 'stdio', command: 'node' }]);

      const remaining = await store.remove('alpha');
      expect(remaining).toEqual([]);
      await expect(store.list()).resolves.toEqual([]);
    });

    it('returns the full catalog from add, update, and remove', async () => {
      await store.add(stdioServer('alpha'));
      const added = await store.add(stdioServer('beta'));
      expect(added.map((server) => server.name)).toEqual(['alpha', 'beta']);
      const remaining = await store.remove('alpha');
      expect(remaining.map((server) => server.name)).toEqual(['beta']);
    });

    it('treats a missing file as an empty catalog', async () => {
      await expect(store.list()).resolves.toEqual([]);
    });

    it('treats a whitespace-only file as an empty catalog', async () => {
      await seedRaw('  \n');
      await expect(store.list()).resolves.toEqual([]);
    });
  });

  describe('byte format', () => {
    it('writes two-space-indented JSON with a trailing newline', async () => {
      await store.add(stdioServer('alpha'));

      const expected = `${JSON.stringify(
        { mcpServers: { alpha: { transport: 'stdio', command: 'npx' } } },
        null,
        2,
      )}\n`;
      expect(await readRaw()).toBe(expected);
    });

    it('preserves unknown top-level keys and mcpServers ordering on write', async () => {
      await seedRaw('{\n  "mcpServers": {},\n  "futureSetting": { "a": 1 }\n}\n');

      await store.add(stdioServer('alpha'));

      const expected = `${JSON.stringify(
        {
          mcpServers: { alpha: { transport: 'stdio', command: 'npx' } },
          futureSetting: { a: 1 },
        },
        null,
        2,
      )}\n`;
      expect(await readRaw()).toBe(expected);
    });

    it('round-trips an entry byte-identically through update', async () => {
      await store.add(stdioServer('alpha'));
      const before = await readRaw();

      await store.update(stdioServer('alpha'));

      expect(await readRaw()).toBe(before);
    });
  });

  describe('name normalization', () => {
    it('trims surrounding whitespace from server names', async () => {
      const added = await store.add(stdioServer('  alpha  '));
      expect(added.map((server) => server.name)).toEqual(['alpha']);
      await expect(store.get(' alpha ')).resolves.toMatchObject({ name: 'alpha' });
      expect(JSON.parse((await readRaw())!)).toMatchObject({ mcpServers: { alpha: {} } });
    });

    it('rejects empty names across all operations', async () => {
      await expect(store.add(stdioServer('   '))).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
        message: 'MCP server name cannot be empty',
      });
      await expect(store.update(stdioServer(''))).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
      });
      await expect(store.get('   ')).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
      await expect(store.remove('   ')).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
      });
    });
  });

  describe('guards', () => {
    it('rejects add with an existing name', async () => {
      await store.add(stdioServer('alpha'));
      await expect(store.add(stdioServer('alpha'))).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
        message: 'MCP server "alpha" already exists',
      });
    });

    it('rejects update for an unknown server', async () => {
      await expect(store.update(stdioServer('ghost'))).rejects.toMatchObject({
        code: ErrorCodes.MCP_SERVER_NOT_FOUND,
        message: 'MCP server "ghost" was not found',
      });
    });

    it('rejects get for an unknown server', async () => {
      await expect(store.get('ghost')).rejects.toMatchObject({
        code: ErrorCodes.MCP_SERVER_NOT_FOUND,
        message: 'MCP server "ghost" was not found',
      });
    });

    it('treats remove of an unknown server as a no-op returning the current catalog', async () => {
      await store.add(stdioServer('alpha'));
      const before = await readRaw();

      let fired = 0;
      store.onDidWrite(() => fired++);
      const remaining = await store.remove('ghost');

      expect(remaining.map((server) => server.name)).toEqual(['alpha']);
      expect(await readRaw()).toBe(before);
      expect(fired).toBe(0);
    });
  });

  describe('read validation', () => {
    it('rejects invalid JSON with config.invalid', async () => {
      await seedRaw('{not json}');
      await expect(store.list()).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID });
      await expect(store.list()).rejects.toThrow(/^Invalid JSON in /);
    });

    it('rejects a BOM-prefixed file as malformed JSON', async () => {
      await seedRaw('\uFEFF{"mcpServers":{}}');
      await expect(store.list()).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID });
      await expect(store.list()).rejects.toThrow(/^Invalid JSON in /);
    });

    it('rejects a non-object top level', async () => {
      await seedRaw('["alpha"]');
      await expect(store.list()).rejects.toMatchObject({
        code: ErrorCodes.CONFIG_INVALID,
        message: `Invalid MCP config in ${store.path}: expected a JSON object`,
      });
    });

    it('rejects a non-object "mcpServers" value', async () => {
      await seedJson({ mcpServers: 'nope' });
      await expect(store.list()).rejects.toMatchObject({
        code: ErrorCodes.CONFIG_INVALID,
        message: `Invalid MCP config in ${store.path}: "mcpServers" must be an object`,
      });
    });

    it('rejects an invalid server entry with the v1 message shape', async () => {
      await seedJson({ mcpServers: { bad: { transport: 'websocket' } } });
      await expect(store.list()).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID });
      await expect(store.list()).rejects.toThrow(/^Invalid MCP server "bad" in global config: /);
    });

    it('rejects an invalid add payload before touching the file', async () => {
      const invalid = { name: 'bad', transport: 'stdio' } as unknown as GlobalMcpServerConfig;
      await expect(store.add(invalid)).rejects.toMatchObject({
        code: ErrorCodes.CONFIG_INVALID,
      });
      await expect(store.add(invalid)).rejects.toThrow(
        /^Invalid MCP server "bad" in global config: /,
      );
      expect(await readRaw()).toBeUndefined();
    });
  });

  describe('__proto__ safety', () => {
    it('adds, reads back, and removes a server literally named __proto__', async () => {
      const added = await store.add(stdioServer('__proto__'));
      expect(added).toEqual([{ name: '__proto__', transport: 'stdio', command: 'npx' }]);

      await expect(store.get('__proto__')).resolves.toMatchObject({ name: '__proto__' });

      const persisted = JSON.parse((await readRaw())!) as Record<string, unknown>;
      const rawServers = persisted['mcpServers'] as Record<string, unknown>;
      expect(Object.hasOwn(rawServers, '__proto__')).toBe(true);
      expect(rawServers['__proto__']).toEqual({ transport: 'stdio', command: 'npx' });

      await expect(store.remove('__proto__')).resolves.toEqual([]);
    });

    it('reads a file declaring a __proto__ server', async () => {
      await seedRaw('{"mcpServers":{"__proto__":{"transport":"stdio","command":"npx"}}}');
      await expect(store.list()).resolves.toEqual([
        { name: '__proto__', transport: 'stdio', command: 'npx' },
      ]);
    });
  });

  describe('onDidWrite', () => {
    it('fires once after each successful add, update, and remove', async () => {
      let fired = 0;
      store.onDidWrite(() => fired++);

      await store.add(stdioServer('alpha'));
      expect(fired).toBe(1);

      await store.update(stdioServer('alpha', 'node'));
      expect(fired).toBe(2);

      await store.remove('alpha');
      expect(fired).toBe(3);
    });

    it('never fires on reads, failed mutations, or no-op removes', async () => {
      await store.add(stdioServer('alpha'));
      let fired = 0;
      store.onDidWrite(() => fired++);

      await store.list();
      await store.get('alpha');
      expect(fired).toBe(0);

      await expect(store.add(stdioServer('   '))).rejects.toMatchObject({
        code: ErrorCodes.REQUEST_INVALID,
      });
      await expect(store.get('ghost')).rejects.toMatchObject({
        code: ErrorCodes.MCP_SERVER_NOT_FOUND,
      });
      await store.remove('ghost');
      expect(fired).toBe(0);
    });

    it('waits for asynchronous listeners before resolving a mutation', async () => {
      let resolveStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      store.onDidWrite((event) => {
        resolveStarted();
        event.waitUntil(gate);
      });

      let completed = false;
      const mutation = store.add(stdioServer('alpha')).then(() => {
        completed = true;
      });
      await started;
      await Promise.resolve();
      expect(completed).toBe(false);

      release();
      await mutation;
      expect(completed).toBe(true);
    });

    it('starts asynchronous listeners concurrently before waiting for completion', async () => {
      let resolveStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let secondStarted = false;
      store.onDidWrite((event) => {
        resolveStarted();
        event.waitUntil(gate);
      });
      store.onDidWrite(() => {
        secondStarted = true;
      });

      const mutation = store.add(stdioServer('alpha'));
      await started;
      await Promise.resolve();
      const secondStartedBeforeRelease = secondStarted;
      release();
      await mutation;

      expect(secondStartedBeforeRelease).toBe(true);
    });

    it('serializes concurrent mutations so no entry is lost', async () => {
      await Promise.all([store.add(stdioServer('alpha')), store.add(stdioServer('beta'))]);

      await expect(store.list()).resolves.toEqual([
        { name: 'alpha', transport: 'stdio', command: 'npx' },
        { name: 'beta', transport: 'stdio', command: 'npx' },
      ]);
      expect(JSON.parse((await readRaw())!)).toMatchObject({
        mcpServers: { alpha: {}, beta: {} },
      });
    });

    it('lets a write listener mutate the store without wedging the mutation queue', async () => {
      let reentered = false;
      store.onDidWrite((event) => {
        if (reentered) return;
        reentered = true;
        event.waitUntil(store.add(stdioServer('beta')).then(() => undefined));
      });

      await store.add(stdioServer('alpha'));

      await expect(store.list()).resolves.toEqual([
        { name: 'alpha', transport: 'stdio', command: 'npx' },
        { name: 'beta', transport: 'stdio', command: 'npx' },
      ]);
    });
  });
});
