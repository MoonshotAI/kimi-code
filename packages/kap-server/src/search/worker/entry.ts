/**
 * `search/worker` — worker-thread entry: hosts the search-index core inside
 * a dedicated worker thread.
 *
 * Loaded by the main-process host (`host.ts`) in one of three shapes:
 *   - dev / tests: this `.ts` file itself, under Node's native type
 *     stripping plus the repo-local `.js` → `.ts` resolve hook
 *     (`register-dev-hooks.mjs`);
 *   - bundled CLI (`dist/main.mjs`): the bundled `search-worker.mjs`
 *     sibling emitted by tsdown;
 *   - SEA single-file binary: the extracted runtime asset configured via
 *     `configureSearchWorkerRuntime` (`runtime.ts`).
 *
 * The whole import closure of this file must stay loadable under
 * `--experimental-transform-types`: relative imports carry explicit `.ts`
 * specifiers, no decorators, erasable TypeScript only. In particular it must
 * NOT import the service (`searchService.ts`, decorators) or the
 * agent-core-v2 barrel (`.md?raw` imports need a bundler).
 *
 * Concurrency: requests are handled as their messages arrive (async
 * interleaving, same semantics the in-process service had). A `close`
 * request first lets every in-flight request settle, then closes the core —
 * which drains tracked background ops (sync/refresh) before closing the db —
 * responds, and lets the thread exit. The host's terminate() remains the
 * hard backstop.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { configureTextBuildWorkerRuntime } from '@moonshot-ai/minidb/worker-runtime';

import { GlobalSearchError, type GlobalSearchErrorReason } from '../contract.ts';
import {
  SearchIndexCore,
  type CoreSearchParams,
  type SyncSessionInput,
} from '../indexCore.ts';
import {
  SEARCH_WORKER_PROTOCOL_VERSION,
  type SearchWorkerData,
  type SearchWorkerErrorPayload,
  type SearchWorkerEvent,
  type SearchWorkerOpenResult,
  type SearchWorkerCall,
  type SearchWorkerRequest,
} from './protocol.ts';

const data = workerData as SearchWorkerData;

// The worker owns the search-index MiniDb, so its heavy text-generation
// builds are triggered from THIS thread — give minidb the packaged
// text-build worker entry when the main process extracted one (SEA). In dev
// minidb resolves its own sibling source entry; a missing entry degrades to
// the bounded inline core inside this worker, never the main thread.
if (typeof data.textBuildWorkerPath === 'string') {
  try {
    configureTextBuildWorkerRuntime(data.textBuildWorkerPath);
  } catch {
    // Best-effort: minidb falls back to the bounded inline build in this worker.
  }
}

const port = parentPort;
if (port === null) {
  throw new Error('search worker entry must run inside a worker thread');
}

const post = (event: SearchWorkerEvent): void => {
  port.postMessage(event);
};

const core = new SearchIndexCore({
  indexDir: data.dir,
  bootSalt: data.bootSalt,
  log: {
    info: (message, meta) => {
      post({ type: 'log', level: 'info', message, meta });
    },
    warn: (message, meta) => {
      post({ type: 'log', level: 'warn', message, meta });
    },
  },
  // The lock token must reach the host BEFORE the heavy open work completes
  // — a worker that dies mid-open would otherwise leave an unreapable lock
  // (the lock line carries this process's still-alive pid).
  onLockToken: (token) => {
    post({ type: 'lockToken', token });
  },
});

function toErrorPayload(error: unknown): SearchWorkerErrorPayload {
  if (error instanceof GlobalSearchError) {
    return { message: error.message, reason: error.reason as GlobalSearchErrorReason };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

async function dispatch(request: SearchWorkerCall): Promise<unknown> {
  switch (request.type) {
    case 'open': {
      await core.ensureOpen();
      const result: SearchWorkerOpenResult = {
        readOnly: core.db?.readOnly === true,
        lockToken: core.lockTokenView,
        lifecycle: core.lifecycleState(),
      };
      return result;
    }
    case 'search':
      return core.search(request.params as CoreSearchParams);
    case 'sync':
      return core.sync((request.params as { sessions: readonly SyncSessionInput[] }).sessions);
    case 'refresh': {
      await core.refresh();
      const result: SearchWorkerOpenResult = {
        readOnly: core.db?.readOnly === true,
        lockToken: core.lockTokenView,
        lifecycle: core.lifecycleState(),
      };
      return result;
    }
    case 'reindex': {
      await core.reindex();
      const result: SearchWorkerOpenResult = {
        readOnly: core.db?.readOnly === true,
        lockToken: core.lockTokenView,
        lifecycle: core.lifecycleState(),
      };
      return result;
    }
    case 'status':
      return core.status();
    case 'close':
      return null;
  }
}

const inFlight = new Set<Promise<void>>();
let closing = false;

async function handle(request: SearchWorkerCall): Promise<void> {
  if (request.v !== SEARCH_WORKER_PROTOCOL_VERSION) {
    post({
      id: request.id,
      type: 'error',
      error: {
        message: `search worker protocol mismatch: host v${request.v}, worker v${SEARCH_WORKER_PROTOCOL_VERSION}`,
      },
    });
    return;
  }
  if (request.type === 'close') {
    // Gate the core FIRST (an in-flight sync abandons its remaining work at
    // the next checkpoint), then let every in-flight request settle and
    // close — the close itself drains tracked background ops. The host's
    // terminate() is the backstop when a request wedges.
    closing = true;
    core.beginClose();
    await Promise.all(inFlight);
    let error: SearchWorkerErrorPayload | null = null;
    try {
      await core.close();
    } catch (closeError) {
      error = toErrorPayload(closeError);
    }
    if (error !== null) post({ id: request.id, type: 'error', error });
    else post({ id: request.id, type: 'result', result: null });
    // Releasing the port lets the thread's event loop drain and exit.
    port!.close();
    return;
  }
  if (closing) {
    post({
      id: request.id,
      type: 'error',
      error: { message: 'search service is disposed', reason: 'index_unavailable' },
    });
    return;
  }
  try {
    const result = await dispatch(request);
    post({ id: request.id, type: 'result', result });
  } catch (error) {
    post({ id: request.id, type: 'error', error: toErrorPayload(error) });
  }
}

port.on('message', (value: unknown) => {
  const request = value as SearchWorkerRequest;
  if (request === null || typeof request !== 'object') return;
  if (request.type === 'beginClose') {
    // Control message (no id, no response): flip the core into closing
    // state NOW so an in-flight sync abandons its remaining work at the
    // next checkpoint instead of wedging the host's dispose behind it.
    closing = true;
    core.beginClose();
    return;
  }
  if (typeof request.id !== 'number' || typeof request.type !== 'string') return;
  const tracked = handle(request);
  inFlight.add(tracked);
  void tracked.finally(() => {
    inFlight.delete(tracked);
  });
});

post({ type: 'ready', v: SEARCH_WORKER_PROTOCOL_VERSION });
