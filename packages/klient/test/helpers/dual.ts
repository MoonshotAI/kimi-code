/**
 * Dual-backend session/agent suite helper — runs the exact same test body
 * against an in-memory engine and an in-process kap-server, one nested
 * `describe` per backend. Model-requiring suites are skipped unless the
 * model env is present (self-contained: the model is seeded into each
 * backend's temp home through the klient facade itself).
 *
 * Env:
 *   KIMI_E2E_MODEL     — model id the gateway serves (e.g. `kimi-k2`)
 *   KIMI_E2E_API_KEY   — API key for the gateway
 *   KIMI_E2E_BASE_URL  — optional base URL (OpenAI-compatible endpoint)
 *   KIMI_E2E_PROTOCOL  — optional wire protocol (default `openai`)
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe } from 'vitest';

import { bootstrap, logSeed, resolveLoggingConfig } from '@moonshot-ai/agent-core-v2';
import { startServer, type RunningServer } from '@moonshot-ai/kap-server';

import type { Klient } from '../../src/index.js';
import type { KlientEvents } from '../../src/core/events/hub.js';
import type { ModelConfig } from '@moonshot-ai/agent-core-v2/app/model/model';
import { createKlient as createMemoryKlient } from '../../src/transports/memory/index.js';
import { createKlient as createHttpKlient } from '../../src/transports/http/index.js';

export type DualBackend = 'memory' | 'http';

export interface DualTarget {
  readonly klient: Klient;
  cleanup(): Promise<void>;
}

export interface ModelEnv {
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly protocol?: ModelConfig['protocol'];
}

export function modelEnv(): ModelEnv | undefined {
  const model = process.env['KIMI_E2E_MODEL'];
  const apiKey = process.env['KIMI_E2E_API_KEY'];
  if (model === undefined || apiKey === undefined) return undefined;
  return {
    model,
    apiKey,
    baseUrl: process.env['KIMI_E2E_BASE_URL'],
    protocol: process.env['KIMI_E2E_PROTOCOL'] as ModelConfig['protocol'],
  };
}

/** Model id registered in the backend for the suite; agents `setModel` to it. */
export const DUAL_MODEL_ID = 'e2e-dual-model';

async function makeTarget(backend: DualBackend, model: ModelEnv | undefined): Promise<DualTarget> {
  const homeDir = await mkdtemp(join(tmpdir(), `klient-dual-${backend}-`));
  let app: ReturnType<typeof bootstrap>['app'] | undefined;
  let server: RunningServer | undefined;
  let klient: Klient;
  if (backend === 'memory') {
    ({ app } = bootstrap({ homeDir }, [
      ...logSeed(resolveLoggingConfig({ homeDir, env: process.env })),
    ]));
    klient = createMemoryKlient({ scope: app });
  } else {
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir, logLevel: 'silent' });
    klient = createHttpKlient({
      url: `http://127.0.0.1:${server.port}`,
      token: server.authTokenService.getToken(),
    });
  }
  if (model !== undefined) {
    await klient.global.models.set({
      id: DUAL_MODEL_ID,
      config: {
        model: model.model,
        apiKey: model.apiKey,
        baseUrl: model.baseUrl,
        protocol: model.protocol ?? 'openai',
        maxContextSize: 262_144,
      },
    });
  }
  return {
    klient,
    cleanup: async () => {
      await klient.close();
      if (server !== undefined) await server.close();
      app?.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    },
  };
}

export interface DualSuiteOptions {
  /** Suite needs a working model; skipped when the env above is absent. */
  readonly requiresModel?: boolean;
}

/** Poll an async predicate until it holds (or throw). */
export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** Resolve with the first payload of `name` (or reject on timeout). */
export function onceEvent<TPayloadMap extends object, E extends keyof TPayloadMap & string>(
  events: KlientEvents<TPayloadMap>,
  name: E,
  timeoutMs = 60_000,
): Promise<TPayloadMap[E]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.dispose();
      reject(new Error(`timed out waiting for event ${name}`));
    }, timeoutMs);
    const sub = events.on(name, (payload) => {
      clearTimeout(timer);
      sub.dispose();
      resolve(payload);
    });
  });
}

/**
 * `body` registers `it`s for BOTH backends; it receives a `klient` accessor
 * valid inside tests (setup happens in `beforeAll`).
 */
export function defineDualSuite(
  name: string,
  options: DualSuiteOptions,
  body: (ctx: { readonly backend: DualBackend; klient: () => Klient }) => void,
): void {
  const model = modelEnv();
  const skip = options.requiresModel === true && model === undefined;
  describe.skipIf(skip)(`dual: ${name}`, () => {
    for (const backend of ['memory', 'http'] as const) {
      describe(backend, () => {
        let target: DualTarget;
        beforeAll(async () => {
          target = await makeTarget(backend, model);
        });
        afterAll(async () => {
          await target.cleanup();
        });
        body({ backend, klient: () => target.klient });
      });
    }
  });
}
