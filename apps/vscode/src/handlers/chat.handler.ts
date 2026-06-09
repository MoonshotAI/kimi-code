import * as vscode from "vscode";
import { Methods, Events } from "../../shared/bridge";
import { VSCodeSettings } from "../config/vscode-settings";
import { GitManager } from "../managers";
import { CliErrorCodes, TransportErrorCodes, SessionErrorCodes, getErrorCode, getErrorCategory, isAgentSdkError, CliError } from "@moonshot-ai/kimi-code-vscode-agent-sdk";
import type { ContentPart, ApprovalResult, RunResult, AgentMode } from "@moonshot-ai/kimi-code-vscode-agent-sdk";
import type { Handler, HandlerContext } from "./types";
import type { ErrorPhase } from "../../shared/types";
import { classifyError, getUserMessage } from "shared/errors";

interface StreamChatParams {
  content: string | ContentPart[];
  model: string;
  thinking: boolean;
  mode?: AgentMode;
  yoloMode?: boolean;
  sessionId?: string;
}

interface RespondApprovalParams {
  requestId: string | number;
  response?: ApprovalResult;
  optionId?: string;
}

interface SteerChatParams {
  content?: string | ContentPart[];
}

interface PrewarmSessionParams {
  model: string;
  thinking: boolean;
  mode?: AgentMode;
  yoloMode?: boolean;
}

function broadcastIfCurrent(ctx: HandlerContext, generation: number, event: string, data: unknown): boolean {
  if (!ctx.isSessionGeneration(generation)) {
    return false;
  }
  ctx.broadcast(event, data, ctx.webviewId);
  return true;
}

const streamChat: Handler<StreamChatParams, { done: boolean }> = async (params, ctx) => {
  if (!ctx.workDir) {
    ctx.broadcast(
      Events.StreamEvent,
      {
        type: "error",
        code: "NO_WORKSPACE",
        message: "Please open a folder to start.",
        phase: "preflight" as ErrorPhase,
      },
      ctx.webviewId,
    );
    vscode.window.showWarningMessage("Kimi: Please open a folder first.", "Open Folder").then((a) => {
      if (a) {
        vscode.commands.executeCommand("vscode.openFolder");
      }
    });
    return { done: false };
  }

  const streamGeneration = ctx.getSessionGeneration();

  if (VSCodeSettings.autosave) {
    await ctx.saveAllDirty();
  }

  if (!ctx.isSessionGeneration(streamGeneration)) {
    return { done: false };
  }

  const existingSession = ctx.getSession();
  const isNewConversation = !existingSession && !params.sessionId;

  try {
    const mode = normalizeMode(params.mode, params.yoloMode);
    const session = await ctx.getOrCreateSession(params.model, params.thinking, mode, params.sessionId);
    await session.ensureStarted();

    if (!ctx.isSessionGeneration(streamGeneration)) {
      return { done: false };
    }

    const startupEvents = session.consumeBufferedEvents().filter((event) => event.type === "ConfigOptionUpdate" || event.type === "AvailableCommandsUpdate");
    ctx.fileManager.setSessionId(ctx.webviewId, session.sessionId);

    broadcastIfCurrent(ctx, streamGeneration, Events.StreamEvent, { type: "session_start", sessionId: session.sessionId, model: session.model });
    for (const event of startupEvents) {
      if (!broadcastIfCurrent(ctx, streamGeneration, Events.StreamEvent, event)) {
        return { done: false };
      }
    }

    if (isNewConversation) {
      void GitManager.initBaseline(ctx.workDir, session.sessionId).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[chat] Failed to initialize Git baseline:", err);
        broadcastIfCurrent(ctx, streamGeneration, Events.StreamEvent, {
          type: "error",
          code: "BASELINE_INIT_FAILED",
          message: `Failed to initialize file tracking baseline: ${message}`,
          phase: "runtime",
        });
      });
    } else {
      await GitManager.commit(ctx.workDir, session.sessionId);
    }

    if (!ctx.isSessionGeneration(streamGeneration)) {
      return { done: false };
    }

    const turn = session.prompt(params.content);
    ctx.setTurn(turn);
    let result: RunResult = { status: "finished" };

    for await (const event of turn) {
      if (!broadcastIfCurrent(ctx, streamGeneration, Events.StreamEvent, event)) {
        return { done: false };
      }
    }

    result = await turn.result;

    if (!ctx.isSessionGeneration(streamGeneration)) {
      return { done: false };
    }

    // A completed turn proves the CLI token is valid.
    ctx.setLoggedIn(true);

    broadcastIfCurrent(ctx, streamGeneration, Events.StreamEvent, { type: "stream_complete", result });
    ctx.setTurn(null);

    return { done: true };
  } catch (err) {
    if (!ctx.isSessionGeneration(streamGeneration)) {
      return { done: false };
    }

    ctx.setTurn(null);

    const code = getErrorCode(err);
    const phase = classifyError(code);
    const message = getUserMessage(code, err instanceof Error ? err.message : String(err));

    if (code === CliErrorCodes.AUTH_REQUIRED || code === TransportErrorCodes.CLI_NOT_FOUND || code === TransportErrorCodes.SPAWN_FAILED) {
      ctx.setLoggedIn(false);
      vscode.window.showWarningMessage("Kimi Code: Please sign in to continue.", "Login").then((a) => {
        if (a) {
          vscode.commands.executeCommand("kimi.login");
        }
      });
    }

    broadcastIfCurrent(ctx, streamGeneration, Events.StreamEvent, {
      type: "error",
      code,
      message,
      phase,
      details: errorDetails(err),
    });

    return { done: false };
  }
};

const prewarmSession: Handler<PrewarmSessionParams, { ok: boolean }> = async (params, ctx) => {
  if (!ctx.workDir) {
    return { ok: false };
  }

  try {
    const mode = normalizeMode(params.mode, params.yoloMode);
    await ctx.prewarmSession(params.model, params.thinking, mode);
    return { ok: true };
  } catch (err) {
    console.warn("[chat] Failed to prewarm session:", err);
    return { ok: false };
  }
};

function hasSteerContent(content: string | ContentPart[] | undefined): content is string | ContentPart[] {
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  return Array.isArray(content) && content.length > 0;
}

const abortChat: Handler<void, { aborted: boolean }> = async (_, ctx) => {
  const turn = ctx.getTurn();
  if (turn) {
    await turn.interrupt();
    ctx.setTurn(null);
  }
  return { aborted: true };
};

const steerChat: Handler<SteerChatParams, { ok: boolean }> = async (params, ctx) => {
  const session = ctx.getSession();
  if (!session || !hasSteerContent(params?.content)) {
    return { ok: false };
  }

  const currentTurn = ctx.getTurn();
  if (currentTurn && session.state === "active") {
    // Enqueue the queued message into the ACP session first. If the current turn
    // is still active, this returns the existing turn; session.steer() then asks
    // ACP to cancel that turn so the queued prompt becomes the next item in the
    // same turn loop.
    session.prompt(params.content);
    await session.steer();
    return { ok: true };
  }

  // Turn has already finished naturally: fall back to stream semantics so the
  // queued message is not dropped. create a new turn, register it, and iterate.
  const turn = session.prompt(params.content);
  ctx.setTurn(turn);

  try {
    for await (const event of turn) {
      ctx.broadcast(Events.StreamEvent, event, ctx.webviewId);
    }
    const result = await turn.result;
    ctx.setLoggedIn(true);
    ctx.broadcast(Events.StreamEvent, { type: "stream_complete", result }, ctx.webviewId);
    ctx.setTurn(null);
    return { ok: true };
  } catch (err) {
    ctx.setTurn(null);
    const code = getErrorCode(err);
    const phase = classifyError(code);
    const message = getUserMessage(code, err instanceof Error ? err.message : String(err));
    if (code === CliErrorCodes.AUTH_REQUIRED || code === TransportErrorCodes.CLI_NOT_FOUND || code === TransportErrorCodes.SPAWN_FAILED) {
      ctx.setLoggedIn(false);
    }
    ctx.broadcast(Events.StreamEvent, { type: "error", code, message, phase, details: errorDetails(err) }, ctx.webviewId);
    return { ok: false };
  }
};

const respondApproval: Handler<RespondApprovalParams, { ok: boolean }> = async (params, ctx) => {
  const turn = ctx.getTurn();
  if (!turn) {
    return { ok: false };
  }
  const result: ApprovalResult = params.optionId ? { optionId: params.optionId } : params.response ?? "reject";
  await turn.approve(params.requestId, result);
  return { ok: true };
};

const resetSession: Handler<void, { ok: boolean }> = async (_, ctx) => {
  const turn = ctx.getTurn();
  if (turn) {
    try {
      await turn.interrupt();
    } catch (err) {
      console.warn("[chat] Failed to interrupt current turn:", err);
    }
    ctx.setTurn(null);
  }
  ctx.bumpSessionGeneration();
  await ctx.closeSession();
  ctx.fileManager.clearTracked(ctx.webviewId);
  return { ok: true };
};

export const chatHandlers: Record<string, Handler<any, any>> = {
  [Methods.StreamChat]: streamChat,
  [Methods.PrewarmSession]: prewarmSession,
  [Methods.AbortChat]: abortChat,
  [Methods.SteerChat]: steerChat,
  [Methods.RespondApproval]: respondApproval,
  [Methods.ResetSession]: resetSession,
};

function errorDetails(err: unknown): Record<string, unknown> | undefined {
  if (!isAgentSdkError(err)) {
    return undefined;
  }

  const details: Record<string, unknown> = { category: getErrorCategory(err) };
  if (err.context) details.context = err.context;
  if (err instanceof CliError && typeof err.numericCode === "number") details.numericCode = err.numericCode;
  return details;
}

function normalizeMode(mode?: AgentMode, yoloMode?: boolean): AgentMode {
  if (mode === "default" || mode === "plan" || mode === "auto" || mode === "yolo") {
    return mode;
  }
  return yoloMode ? "yolo" : "default";
}
