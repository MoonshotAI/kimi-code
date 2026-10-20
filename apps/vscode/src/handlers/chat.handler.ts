import * as vscode from "vscode";
import { isKimiError } from "@moonshot-ai/kimi-code-sdk";

import { Events, Methods } from "../../shared/bridge";
import type { ApprovalResponse, ContentPart } from "../../shared/legacy-sdk";
import { getUserMessage } from "../../shared/errors";
import type { ErrorPhase } from "../../shared/types";
import { VSCodeSettings } from "../config/vscode-settings";
import { normalizeEffort } from "../runtime/kimi-runtime";
import type { SessionRuntime } from "../runtime/session-runtime";
import { isWorkspacePathContained, relativeWorkspacePath } from "../utils/workspace-path";
import { parseHostSlashCommand, runHostSlashCommand } from "./slash-command";
import type { Handler } from "./types";

interface StreamChatParams {
  content: string | ContentPart[];
  model: string;
  effort?: string;
  thinking?: boolean;
  planMode?: boolean;
  sessionId?: string;
}

interface RespondApprovalParams {
  requestId: string;
  response: ApprovalResponse;
}

interface RespondQuestionParams {
  rpcRequestId: string;
  questionRequestId: string;
  answers: Record<string, string>;
}

const injectedEditorContextSessions = new Map<string, string>();

async function buildSystemContext(sessionId: string, ctx: Parameters<Handler>[1]): Promise<string> {
  const mode = VSCodeSettings.editorContext;
  if (mode === "never") return "";

  const editor = vscode.window.activeTextEditor;
  if (!editor || !ctx.workDirUri || !(await isWorkspacePathContained(ctx.workDirUri, editor.document.uri))) {
    return "";
  }

  const document = editor.document;
  const relativePath = relativeWorkspacePath(ctx.workDirUri, document.uri);
  if (relativePath === undefined) return "";
  const lastPath = injectedEditorContextSessions.get(sessionId);
  if (mode === "onConversationStart" && lastPath !== undefined) return "";
  if (mode === "onFileChange" && lastPath === relativePath) return "";

  injectedEditorContextSessions.set(sessionId, relativePath);
  const selection = editor.selection;
  const selectionInfo = selection.isEmpty
    ? ""
    : ` (L${selection.start.line + 1}-${selection.end.line + 1} selected)`;
  const unsavedInfo = document.isDirty ? ", unsaved" : "";
  return `<system>Editor context (use only if relevant to user's query): ${relativePath}:${selection.active.line + 1}${selectionInfo}${unsavedInfo}.</system>\n`;
}

function prependSystemContext(content: string | ContentPart[], context: string): string | ContentPart[] {
  if (!context) return content;
  if (typeof content === "string") return `${content}\n${context}`;

  const index = content.findIndex((part) => part.type === "text");
  if (index < 0) return [{ type: "text", text: context }, ...content];
  const copy = [...content];
  const text = copy[index] as Extract<ContentPart, { type: "text" }>;
  copy[index] = { type: "text", text: context + text.text };
  return copy;
}

const streamChat: Handler<StreamChatParams, { done: boolean }> = async (params, ctx) => {
  if (!ctx.workDir) {
    emitPreflightError(ctx, "NO_WORKSPACE", "Please open a folder to start.");
    void vscode.window.showWarningMessage("Kimi: Please open a folder first.", "Open Folder").then((action) => {
      if (action) void vscode.commands.executeCommand("vscode.openFolder");
    });
    return { done: false };
  }

  if (VSCodeSettings.autosave) {
    try {
      await ctx.saveAllDirty();
    } catch (error) {
      emitCaughtError(ctx, error, "preflight");
      return { done: false };
    }
  }

  let runtime: SessionRuntime;
  try {
    runtime = await ctx.getOrCreateSession(
      params.model,
      params.effort ?? (params.thinking === true ? "on" : "off"),
      params.sessionId,
    );
  } catch (error) {
    emitCaughtError(ctx, error, "preflight");
    return { done: false };
  }

  try {
    // Attach no longer overwrites session modes with the configured defaults
    // (resumed sessions keep their own), so apply the model/effort that the
    // composer submitted with this prompt before the turn starts.
    const status = await runtime.session.getStatus();
    let model = status.model;
    if (params.model && model !== params.model) {
      await runtime.session.setModel(params.model);
      model = params.model;
    }
    const effort = normalizeEffort(params.effort ?? (params.thinking === true ? "on" : "off"));
    if (status.thinkingEffort !== effort) {
      await runtime.session.setThinking(effort);
    }
    if (params.planMode !== undefined && status.planMode !== params.planMode) {
      await runtime.session.setPlanMode(params.planMode);
    }
    runtime.announceSessionStart(model);
  } catch (error) {
    emitCaughtError(ctx, error, "preflight", runtime.id);
    return { done: false };
  }

  const slash = parseHostSlashCommand(params.content);
  if (slash !== undefined) {
    try {
      return { done: await runHostSlashCommand(runtime, slash, ctx) };
    } catch (error) {
      emitCaughtError(ctx, error, "runtime", runtime.id);
      return { done: false };
    }
  }

  const systemContext = await buildSystemContext(runtime.id, ctx);
  try {
    const result = await runtime.prompt(prependSystemContext(params.content, systemContext));
    return { done: result.status === "finished" };
  } catch (error) {
    emitCaughtError(ctx, error, "runtime", runtime.id);
    return { done: false };
  }
};

const abortChat: Handler<void, { aborted: boolean }> = async (_, ctx) => {
  const runtime = ctx.getSession();
  // Do not claim an abort when there is no runtime to cancel — the webview
  // would otherwise show the task as stopped while the engine keeps running.
  if (runtime === undefined) return { aborted: false };
  await runtime.cancel();
  return { aborted: true };
};

const respondApproval: Handler<RespondApprovalParams, { ok: boolean }> = async (params, ctx) => {
  return { ok: ctx.getSession()?.respondApproval(params.requestId, params.response) ?? false };
};

const respondQuestion: Handler<RespondQuestionParams, { ok: boolean }> = async (params, ctx) => {
  const id = params.questionRequestId || params.rpcRequestId;
  return { ok: ctx.getSession()?.respondQuestion(id, params.answers) ?? false };
};

const setPlanMode: Handler<{ enabled: boolean }, { ok: boolean; planMode: boolean }> = async (params, ctx) => {
  const runtime = ctx.getSession();
  if (runtime === undefined) return { ok: false, planMode: false };
  await runtime.session.setPlanMode(params.enabled);
  return { ok: true, planMode: params.enabled };
};

const steerChat: Handler<{ content: string | ContentPart[] }, { ok: boolean }> = async (params, ctx) => {
  const runtime = ctx.getSession();
  if (runtime === undefined || !runtime.isBusy) return { ok: false };
  await runtime.steer(params.content);
  return { ok: true };
};

const resetSession: Handler<void, { ok: boolean }> = async (_, ctx) => {
  const runtime = ctx.getSession();
  if (runtime !== undefined) injectedEditorContextSessions.delete(runtime.id);
  await ctx.closeSession();
  ctx.fileManager.clearTracked(ctx.webviewId);
  return { ok: true };
};

export const chatHandlers: Record<string, Handler<any, any>> = {
  [Methods.StreamChat]: streamChat,
  [Methods.AbortChat]: abortChat,
  [Methods.RespondApproval]: respondApproval,
  [Methods.RespondQuestion]: respondQuestion,
  [Methods.SetPlanMode]: setPlanMode,
  [Methods.SteerChat]: steerChat,
  [Methods.ResetSession]: resetSession,
};

function emitCaughtError(
  ctx: Parameters<Handler>[1],
  error: unknown,
  phase: ErrorPhase,
  sessionId?: string,
): void {
  const code = isKimiError(error) ? error.code : "internal";
  const detail = error instanceof Error ? error.message : String(error);
  ctx.logError(`Chat ${phase} request failed`, error);
  ctx.broadcast(
    Events.StreamEvent,
    {
      type: "error",
      code,
      message: getUserMessage(code, detail),
      detail,
      phase,
      ...(sessionId === undefined ? {} : { _sessionId: sessionId }),
    },
    ctx.webviewId,
  );
}

function emitPreflightError(ctx: Parameters<Handler>[1], code: string, message: string): void {
  ctx.broadcast(
    Events.StreamEvent,
    { type: "error", code, message, phase: "preflight" },
    ctx.webviewId,
  );
}
