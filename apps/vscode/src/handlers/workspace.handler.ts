import * as vscode from "vscode";
import { Methods } from "../../shared/bridge";
import type { Handler } from "./types";
import type { WorkspaceStatus } from "shared/types";

const INPUT_HISTORY_KEY = "kimi.inputHistory";
const MAX_HISTORY_SIZE = 100;

const checkWorkspace: Handler<void, WorkspaceStatus> = async (_, ctx) => {
  return {
    hasWorkspace: ctx.workDir !== null,
    path: ctx.workDir ?? undefined,
    workspaceRoot: ctx.workspaceRoot ?? undefined,
  };
};

const openFolder: Handler<void, { ok: boolean }> = async () => {
  await vscode.commands.executeCommand("vscode.openFolder");
  return { ok: true };
};

const getInputHistory: Handler<void, string[]> = async (_, ctx) => {
  return ctx.workspaceState.get<string[]>(INPUT_HISTORY_KEY, []);
};

const addInputHistory: Handler<{ text: string }, { ok: boolean }> = async ({ text }, ctx) => {
  const history = ctx.workspaceState.get<string[]>(INPUT_HISTORY_KEY, []);
  // 避免重复添加相同的最近一条
  if (history[history.length - 1] !== text) {
    history.push(text);
    if (history.length > MAX_HISTORY_SIZE) {
      history.shift();
    }
    await ctx.workspaceState.update(INPUT_HISTORY_KEY, history);
  }
  return { ok: true };
};

export const workspaceHandlers: Record<string, Handler<any, any>> = {
  [Methods.CheckWorkspace]: checkWorkspace,
  [Methods.OpenFolder]: openFolder,
  [Methods.GetInputHistory]: getInputHistory,
  [Methods.AddInputHistory]: addInputHistory,
};
