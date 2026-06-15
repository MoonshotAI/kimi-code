import { Methods } from "../../shared/bridge";
import { listSessions, parseSessionEvents, deleteSession } from "@moonshot-ai/kimi-code-vscode-agent-sdk";
import { GitManager } from "../managers";
import type { SessionInfo, StreamEvent } from "@moonshot-ai/kimi-code-vscode-agent-sdk";
import type { Handler } from "./types";

interface LoadHistoryParams {
  kimiSessionId: string;
}

interface DeleteSessionParams {
  sessionId: string;
}

export const sessionHandlers: Record<string, Handler<any, any>> = {
  [Methods.GetKimiSessions]: async (_, ctx) => {
    return ctx.workDir ? listSessions(ctx.workDir) : [];
  },

  [Methods.LoadKimiSessionHistory]: async (params: LoadHistoryParams, ctx): Promise<StreamEvent[]> => {
    if (!ctx.workDir) {
      return [];
    }
    const workDir = ctx.workDir;

    ctx.bumpSessionGeneration();
    await ctx.closeSession();
    ctx.fileManager.clearTracked(ctx.webviewId);
    ctx.fileManager.setSessionId(ctx.webviewId, params.kimiSessionId);

    const events = await parseSessionEvents(workDir, params.kimiSessionId);
    setTimeout(() => {
      void GitManager.initBaseline(workDir, params.kimiSessionId).catch((err) => {
        console.warn("[session] Failed to pre-initialize Git baseline for history:", err);
      });
    }, 0);

    return events;
  },

  [Methods.DeleteKimiSession]: async (params: DeleteSessionParams, ctx): Promise<{ ok: boolean }> => {
    if (!ctx.workDir) {
      return { ok: false };
    }
    return { ok: await deleteSession(ctx.workDir, params.sessionId) };
  },
};
