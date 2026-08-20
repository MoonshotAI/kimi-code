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

if (typeof data.textBuildWorkerPath === 'string') {
  try {
    configureTextBuildWorkerRuntime(data.textBuildWorkerPath);
  } catch {
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
