import { Methods } from "../../shared/bridge";
import { listSessions, parseSessionEvents, deleteSession, parseConfig, getErrorCode, CliErrorCodes } from "@moonshot-ai/kimi-code-vscode-agent-sdk";
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

    ctx.fileManager.setSessionId(ctx.webviewId, params.kimiSessionId);
    await GitManager.initBaseline(ctx.workDir, params.kimiSessionId);

    const config = parseConfig();
    const model = config.defaultModel || config.models[0]?.id || "";
    // History replay creates the session; YOLO defaults to off here and is
    // re-supplied by the webview on the next streamChat.
    const session = await ctx.getOrCreateSession(model, config.defaultThinking, "default", params.kimiSessionId);
    try {
      await session.ensureStarted();
    } catch (err) {
      // A failed handshake on AUTH_REQUIRED means the CLI token is no longer
      // valid; flip the login context so the UI can guide re-authentication
      // (mirrors streamChat). Re-throw so the bridge surfaces the error.
      if (getErrorCode(err) === CliErrorCodes.AUTH_REQUIRED) {
        ctx.setLoggedIn(false);
      }
      throw err;
    }
    // A successful handshake proves the CLI token is valid.
    ctx.setLoggedIn(true);
    const replayed = session.consumeBufferedEvents();

    return replayed.length > 0 ? replayed : parseSessionEvents(ctx.workDir, params.kimiSessionId);
  },

  [Methods.DeleteKimiSession]: async (params: DeleteSessionParams, ctx): Promise<{ ok: boolean }> => {
    if (!ctx.workDir) {
      return { ok: false };
    }
    return { ok: await deleteSession(ctx.workDir, params.sessionId) };
  },
};
