import * as vscode from "vscode";
import { Methods } from "../../shared/bridge";
import type { Handler } from "./types";
import { WorkspaceStatus } from "shared/types";

const checkWorkspace: Handler<void, WorkspaceStatus> = async (_, ctx) => {
  return {
    hasWorkspace: ctx.workDir !== null,
    path: ctx.workDir ?? undefined,
  };
};

const openFolder: Handler<void, { ok: boolean }> = async () => {
  await vscode.commands.executeCommand("vscode.openFolder");
  return { ok: true };
};

export const workspaceHandlers: Record<string, Handler<any, any>> = {
  [Methods.CheckWorkspace]: checkWorkspace,
  [Methods.OpenFolder]: openFolder,
};
