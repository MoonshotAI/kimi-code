import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { useHttpRoute } from '../feature';
import { ErrorCode, sendErr, sendOk } from '../route/http';

export interface GuiStoreOptions {
  readonly persistPath?: string;
}

interface GuiStore {
  getItem(key: string): Promise<string | null>;
  length(): Promise<number>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
}

export function useGuiStoreRoutes(prefix: string, options: GuiStoreOptions = {}): void {
  const store = createGuiStore(options.persistPath);

  useHttpRoute({
    id: 'gui.store.getItem',
    method: 'GET',
    path: `${prefix}/gui/store/getItem`,
    handler: async (request, response) => {
      const key = readKey(request.query['key']);
      if (key === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'key must be a string between 1 and 256 characters', 400);
        return;
      }
      sendOk(request, response, { value: await store.getItem(key) });
    },
  });

  useHttpRoute({
    id: 'gui.store.length',
    method: 'GET',
    path: `${prefix}/gui/store/length`,
    handler: async (request, response) => {
      sendOk(request, response, { length: await store.length() });
    },
  });

  useHttpRoute({
    id: 'gui.store.setItem',
    method: 'POST',
    path: `${prefix}/gui/store/setItem`,
    handler: async (request, response) => {
      const body = readKeyValueBody(request.body);
      if (body === undefined || typeof body.value !== 'string') {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'key and value are required', 400);
        return;
      }
      await store.setItem(body.key, body.value);
      sendOk(request, response, null);
    },
  });

  useHttpRoute({
    id: 'gui.store.removeItem',
    method: 'POST',
    path: `${prefix}/gui/store/removeItem`,
    handler: async (request, response) => {
      const body = readKeyValueBody(request.body);
      if (body === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'key is required', 400);
        return;
      }
      await store.removeItem(body.key);
      sendOk(request, response, null);
    },
  });

  useHttpRoute({
    id: 'gui.store.clear',
    method: 'POST',
    path: `${prefix}/gui/store/clear`,
    handler: async (request, response) => {
      await store.clear();
      sendOk(request, response, null);
    },
  });
}

function createGuiStore(persistPath?: string): GuiStore {
  let data: Record<string, string> | undefined;
  let chain: Promise<void> = Promise.resolve();

  const load = async (): Promise<Record<string, string>> => {
    if (data !== undefined) return data;
    const next: Record<string, string> = {};
    if (persistPath !== undefined) {
      const parsed = await readFile(persistPath, 'utf8')
        .then((text) => JSON.parse(text) as unknown)
        .catch(() => undefined);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string') next[key] = value;
        }
      }
    }
    data = next;
    return data;
  };

  const persist = async (): Promise<void> => {
    if (persistPath === undefined || data === undefined) return;
    await mkdir(dirname(persistPath), { recursive: true });
    const tmp = `${persistPath}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, persistPath);
  };

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const run = chain.then(task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    getItem: async (key) => {
      const all = await load();
      return Object.prototype.hasOwnProperty.call(all, key) ? (all[key] ?? null) : null;
    },
    length: async () => Object.keys(await load()).length,
    setItem: (key, value) =>
      enqueue(async () => {
        (await load())[key] = value;
        await persist();
      }),
    removeItem: (key) =>
      enqueue(async () => {
        const all = await load();
        if (Object.prototype.hasOwnProperty.call(all, key)) {
          delete all[key];
          await persist();
        }
      }),
    clear: () =>
      enqueue(async () => {
        data = {};
        await persist();
      }),
  };
}

function readKey(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
}

function readKeyValueBody(body: unknown): { readonly key: string; readonly value?: string } | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as { [key: string]: unknown };
  const key = readKey(record['key']);
  if (key === undefined) return undefined;
  return { key, value: typeof record['value'] === 'string' ? record['value'] : undefined };
}
