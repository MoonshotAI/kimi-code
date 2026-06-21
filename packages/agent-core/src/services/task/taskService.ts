/**
 * `TaskService` — implementation of `ITaskService`.
 */

import { Disposable, InstantiationType, registerSingleton } from '../../di';
import type { BackgroundTask } from '@moonshot-ai/protocol';

import type { CoreRPC } from '../../rpc';
import { ICoreRuntime } from '../coreProcess/coreProcess';
import { SessionNotFoundError } from '../session/session';
import {
  ITaskService,
  TaskNotFoundError,
  TaskAlreadyFinishedError,
  toProtocolTask,
  isTerminalStatus,
  type GetTaskOptions,
  type TaskListQuery,
} from './task';

const MAIN_AGENT_ID = 'main';
const DEFAULT_TASK_OUTPUT_PREVIEW_BYTES = 32 * 1024;

/**
 * Narrow in-process CoreAPI accessor supplied by the concrete
 * `CoreProcessService` (the sole production `ICoreRuntime`). Routed
 * through a structural cast so the public `ICoreRuntime` facade — and
 * the many test doubles that implement it across the suite — stay unchanged.
 * The daemon-side adapter always provides `getCoreApi()`; see
 * `CoreProcessService.getCoreApi` for the zero-serialization rationale.
 */
type InProcessCoreApi = { getCoreApi(): CoreRPC };

export class TaskService extends Disposable implements ITaskService {
  readonly _serviceBrand: undefined;

  constructor(@ICoreRuntime private readonly core: ICoreRuntime) {
    super();
  }

  async list(sessionId: string, query: TaskListQuery): Promise<readonly BackgroundTask[]> {
    await this._requireSession(sessionId);
    const raw = await this._getAllRaw(sessionId);
    const all = raw.map((info) => toProtocolTask(sessionId, info));
    if (query.status !== undefined) {
      return all.filter((t) => t.status === query.status);
    }
    return all;
  }

  async get(
    sessionId: string,
    taskId: string,
    options?: GetTaskOptions,
  ): Promise<BackgroundTask> {
    await this._requireSession(sessionId);
    const raw = await this._getAllRaw(sessionId);
    const found = raw.find((t) => t.taskId === taskId);
    if (found === undefined) {
      throw new TaskNotFoundError(sessionId, taskId);
    }

    let output: { preview: string; bytes: number } | undefined;
    if (options?.withOutput) {
      const tailBytes = options.outputBytes ?? DEFAULT_TASK_OUTPUT_PREVIEW_BYTES;
      try {
        const preview = await this.coreApi().getBackgroundOutput({
          sessionId,
          agentId: MAIN_AGENT_ID,
          taskId,
          tail: tailBytes,
        });
        if (preview.length > 0) {
          output = { preview, bytes: Buffer.byteLength(preview, 'utf-8') };
        }
      } catch {
        // Output may not be available yet; fall back to task metadata only.
      }
    }

    return toProtocolTask(sessionId, found, output);
  }

  async cancel(sessionId: string, taskId: string): Promise<{ cancelled: true }> {
    await this._requireSession(sessionId);
    // Pre-fetch so we can distinguish the 40406 (not found) and 40904 (already
    // finished) cases deterministically — agent-core's `stopBackground` is a
    // fire-and-forget call that doesn't surface this.
    const raw = await this._getAllRaw(sessionId);
    const found = raw.find((t) => t.taskId === taskId);
    if (found === undefined) {
      throw new TaskNotFoundError(sessionId, taskId);
    }
    const wireStatus = toProtocolTask(sessionId, found).status;
    if (isTerminalStatus(wireStatus)) {
      throw new TaskAlreadyFinishedError(sessionId, taskId, wireStatus);
    }
    await this.coreApi().stopBackground({
      sessionId,
      agentId: MAIN_AGENT_ID,
      taskId,
    });
    return { cancelled: true };
  }

  // --- internals ------------------------------------------------------------

  private async _requireSession(sessionId: string): Promise<void> {
    const all = await this.coreApi().listSessions({});
    if (!all.some((s) => s.id === sessionId)) {
      throw new SessionNotFoundError(sessionId);
    }
  }

  private async _getAllRaw(
    sessionId: string,
  ): Promise<ReadonlyArray<Awaited<ReturnType<typeof this.core.rpc.getBackground>>[number]>> {
    try {
      return await this.coreApi().getBackground({
        sessionId,
        agentId: MAIN_AGENT_ID,
      });
    } catch {
      // Session not loaded; treat as empty.
      return [];
    }
  }

  /**
   * In-process CoreAPI handle — the same methods as `this.core.rpc` but
   * dispatched directly on the in-process `KimiCore`, skipping the
   * `createRPC` JSON serialize/deserialize hop. Method signatures and return
   * shapes are identical to the `rpc` proxy; only the serialization is
   * removed. The cast is localized here so every call site above reads
   * `this.coreApi().<method>(...)`.
   */
  private coreApi(): CoreRPC {
    return (this.core as unknown as InProcessCoreApi).getCoreApi();
  }
}

// Self-register under the global singleton registry. All ctor deps are
// `@I…`-injected; `staticArguments = []`. `supportsDelayedInstantiation =
// false` preserves current reverse-dispose semantics.
registerSingleton(ITaskService, TaskService, InstantiationType.Delayed);
