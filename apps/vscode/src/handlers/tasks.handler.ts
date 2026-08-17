import { Methods } from "../../shared/bridge";
import type { BackgroundTaskInfo } from "../../shared/legacy-sdk";
import type { Handler } from "./types";

interface TaskIdParams {
  taskId: string;
}

interface TaskOutputParams extends TaskIdParams {
  tail?: number;
}

export const tasksHandlers: Record<string, Handler<any, any>> = {
  [Methods.ListBackgroundTasks]: async (_, ctx): Promise<BackgroundTaskInfo[]> => {
    const runtime = ctx.getSession();
    if (runtime === undefined) return [];
    const tasks = await runtime.listBackgroundTasks();
    return [...tasks];
  },

  [Methods.GetBackgroundTaskOutput]: async (
    params: TaskOutputParams,
    ctx,
  ): Promise<{ output: string }> => {
    const runtime = ctx.getSession();
    if (runtime === undefined) return { output: "" };
    const output = await runtime.getBackgroundTaskOutput(params.taskId, params.tail);
    return { output };
  },

  [Methods.StopBackgroundTask]: async (params: TaskIdParams, ctx): Promise<{ ok: boolean }> => {
    const runtime = ctx.getSession();
    if (runtime === undefined) return { ok: false };
    await runtime.stopBackgroundTask(params.taskId);
    // The terminated event refreshes every view; nudge the requesting view so
    // the panel reflects the stop without waiting for the engine round-trip.
    await runtime.announceBackgroundTasks(ctx.webviewId).catch((error: unknown) => {
      ctx.logError("Failed to refresh background tasks after a stop", error);
    });
    return { ok: true };
  },
};
