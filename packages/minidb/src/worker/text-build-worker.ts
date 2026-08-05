// src/worker/text-build-worker.ts
//
// Worker-thread entry for the stage-6 workerized text generation build. This
// file is loaded with `execArgv: []` under Node's native type stripping, so
// its whole import closure uses explicit `.ts` specifiers (see
// text-build-core.ts' import note). It is a thin hosting shell around
// buildTextArtifacts: the spec arrives as workerData, progress goes back as
// messages, and a 'cancel' message triggers the cooperative abort (the main
// thread's terminate() remains the hard backstop).
//
// Internal to the package — NEVER re-exported from the root entry point.

import { parentPort, workerData } from 'node:worker_threads';
import { TEXT_BUILD_WORKER_PROTOCOL_VERSION } from '../worker-runtime.ts';
import { buildTextArtifacts } from './text-build-core.ts';
import type { TextBuildCoreSpec, TextBuildCoreResult } from './text-build-core.ts';

type DoneMessage = { type: 'done'; result: TextBuildCoreResult };
type FailedMessage = { type: 'failed'; error: string; aborted: boolean };
type CancelMessage = { type: 'cancel' };

const controller = new AbortController();
parentPort?.on('message', (m: CancelMessage) => {
  if (m && m.type === 'cancel') controller.abort();
});

const spec: TextBuildCoreSpec = {
  ...(workerData as TextBuildCoreSpec),
  signal: controller.signal,
  // Sync writes occupy this worker, never the host's libuv thread pool.
  syncIo: true,
  onProgress: (progress) => {
    parentPort?.postMessage({ type: 'progress', ...progress });
  },
};

parentPort?.postMessage({ type: 'ready', version: TEXT_BUILD_WORKER_PROTOCOL_VERSION });
try {
  const result = await buildTextArtifacts(spec);
  const message: DoneMessage = { type: 'done', result };
  parentPort?.postMessage(message);
} catch (error) {
  const message: FailedMessage = {
    type: 'failed',
    error: error instanceof Error ? error.message : String(error),
    aborted: (error as Error)?.name === 'AbortError',
  };
  parentPort?.postMessage(message);
}
