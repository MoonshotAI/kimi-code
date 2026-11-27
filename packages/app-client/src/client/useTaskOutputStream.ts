import { shallowRef, triggerRef } from 'vue';
import type { KimiEventConnection } from '@moonshot-ai/app-core/api';
import { applyTaskOutputChunk, type TaskOutputBuffer } from '@moonshot-ai/app-core/lib';

export type TaskOutputState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly text: string };

type TaskOutputEntry =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly buffer: TaskOutputBuffer };

export interface UseTaskOutputStream {
  watch: (sessionId: string, agentId: string, taskId: string) => void;
  unwatch: (sessionId: string, agentId: string, taskId: string) => void;
  receive: (sessionId: string, agentId: string, taskId: string, offset: number, text: string) => void;
  fail: (sessionId: string, agentId: string, taskId: string) => void;
  outputOf: (sessionId: string, agentId: string, taskId: string) => TaskOutputState | undefined;
}

export function useTaskOutputStream(deps: {
  connection: () => KimiEventConnection | null;
}): UseTaskOutputStream {
  const entries = shallowRef(new Map<string, TaskOutputEntry>());
  let frameScheduled = false;

  function key(sessionId: string, agentId: string, taskId: string): string {
    return `${sessionId}\0${agentId}\0${taskId}`;
  }

  function notifyNextFrame(): void {
    if (frameScheduled) return;
    frameScheduled = true;
    scheduleFrame(() => {
      frameScheduled = false;
      triggerRef(entries);
    });
  }

  function watch(sessionId: string, agentId: string, taskId: string): void {
    const k = key(sessionId, agentId, taskId);
    if (entries.value.has(k)) return;
    entries.value.set(k, { status: 'loading' });
    triggerRef(entries);
    deps.connection()?.watchTaskOutput(sessionId, agentId, taskId);
  }

  function unwatch(sessionId: string, agentId: string, taskId: string): void {
    if (!entries.value.delete(key(sessionId, agentId, taskId))) return;
    triggerRef(entries);
    deps.connection()?.unwatchTaskOutput(sessionId, agentId, taskId);
  }

  function receive(sessionId: string, agentId: string, taskId: string, offset: number, text: string): void {
    const k = key(sessionId, agentId, taskId);
    const entry = entries.value.get(k);
    if (entry === undefined) return;
    const previous = entry.status === 'ready' ? entry.buffer : undefined;
    entries.value.set(k, { status: 'ready', buffer: applyTaskOutputChunk(previous, offset, text) });
    notifyNextFrame();
  }

  function fail(sessionId: string, agentId: string, taskId: string): void {
    const k = key(sessionId, agentId, taskId);
    if (!entries.value.has(k)) return;
    entries.value.set(k, { status: 'failed' });
    triggerRef(entries);
  }

  function outputOf(sessionId: string, agentId: string, taskId: string): TaskOutputState | undefined {
    const entry = entries.value.get(key(sessionId, agentId, taskId));
    if (entry?.status !== 'ready') return entry;
    return { status: 'ready', text: entry.buffer.text };
  }

  return { watch, unwatch, receive, fail, outputOf };
}

function scheduleFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback);
  else setTimeout(callback, 16);
}
