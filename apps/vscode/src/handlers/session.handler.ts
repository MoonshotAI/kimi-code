import * as path from "node:path";
import * as vscode from "vscode";
import type { SessionSummary } from "@moonshot-ai/kimi-code-sdk";

import { Events, Methods } from "../../shared/bridge";
import type { SessionInfo } from "../../shared/legacy-sdk";
import type { BaselineSession } from "../managers/baseline.manager";
import { replaySessionToWebviewEvents } from "../runtime/replay-adapter";
import { areSameFsPath, isFsPathInsideOrEqual } from "../utils/fs-path";
import {
  isWorkspacePathContained,
  workDirUriFromPath,
} from "../utils/workspace-path";
import type { Handler } from "./types";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

interface LoadHistoryParams {
  kimiSessionId: string;
}

interface DeleteSessionParams {
  sessionId: string;
}

interface ForkSessionParams {
  sessionId: string;
  turnIndex: number;
}

export const sessionHandlers: Record<string, Handler<any, any>> = {
  [Methods.GetKimiSessions]: async (_, ctx): Promise<SessionInfo[]> => {
    if (!ctx.workDir) return [];
    return (await ctx.harness.listSessions({ workDir: ctx.workDir })).map(toSessionInfo);
  },

  [Methods.GetAllKimiSessions]: async (_, ctx): Promise<SessionInfo[]> => {
    if (!ctx.workspaceRoot) return [];
    return (await ctx.harness.listSessions())
      .filter((session) => isInsideOrEqual(ctx.workspaceRoot!, session.workDir))
      .map(toSessionInfo);
  },

  [Methods.GetRegisteredWorkDirs]: async (_, ctx): Promise<string[]> => {
    if (!ctx.workspaceRoot) return [];
    const sessions = await ctx.harness.listSessions();
    return [
      ...new Set(
        sessions
          .map((session) => session.workDir)
          .filter((workDir) => isInsideOrEqual(ctx.workspaceRoot!, workDir)),
      ),
    ].toSorted();
  },

  [Methods.SetWorkDir]: async (params: { workDir: string | null }, ctx) => {
    if (!ctx.workspaceRoot || !ctx.workspaceRootUri) return { ok: false };
    const target = params.workDir;
    if (target) {
      const targetUri = workDirUriFromPath(ctx.workspaceRootUri, ctx.workspaceRoot, target);
      if (targetUri === undefined || !(await isWorkspacePathContained(ctx.workspaceRootUri, targetUri))) {
        return { ok: false };
      }
    }
    try {
      await ctx.setCustomWorkDir(target);
    } catch {
      return { ok: false };
    }
    return { ok: true, workDir: target ?? ctx.workspaceRoot };
  },

  [Methods.BrowseWorkDir]: async (_, ctx) => {
    if (!ctx.workspaceRoot || !ctx.workspaceRootUri) return { ok: false, workDir: null };
    const workspaceUri = ctx.workspaceRootUri;
    let subdirectories: string[] = [];
    try {
      const entries = await vscode.workspace.fs.readDirectory(workspaceUri);
      subdirectories = entries
        .filter(([name, type]) => type === vscode.FileType.Directory && !name.startsWith("."))
        .map(([name]) => name)
        .toSorted();
    } catch {
      // The native picker remains available when directory enumeration fails.
    }

    const picked = await vscode.window.showQuickPick(
      [
        { label: "$(folder) Browse...", description: "Open folder picker", alwaysShow: true },
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        ...subdirectories.map((name) => ({
          label: `$(folder) ${name}`,
          description: path.join(ctx.workspaceRoot!, name),
        })),
      ],
      { placeHolder: "Select a subdirectory or browse...", title: "Working Directory" },
    );
    if (!picked) return { ok: false, workDir: null };

    let selectedUri: vscode.Uri;
    if (picked.label === "$(folder) Browse...") {
      const result = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: workspaceUri,
        openLabel: "Select Working Directory",
      });
      if (!result?.[0]) return { ok: false, workDir: null };
      selectedUri = result[0];
    } else if (picked.description) {
      const pickedUri = workDirUriFromPath(workspaceUri, ctx.workspaceRoot, picked.description);
      if (pickedUri === undefined) return { ok: false, workDir: null };
      selectedUri = pickedUri;
    } else {
      return { ok: false, workDir: null };
    }

    if (!(await isWorkspacePathContained(workspaceUri, selectedUri))) {
      await vscode.window.showWarningMessage("Selected directory must be within the workspace.");
      return { ok: false, workDir: null };
    }
    const selected = selectedUri.fsPath;
    await ctx.setCustomWorkDir(selected === ctx.workspaceRoot ? null : selected);
    return { ok: true, workDir: selected };
  },

  [Methods.LoadKimiSessionHistory]: async (params: LoadHistoryParams, ctx) => {
    if (!ctx.workDir || !isSessionId(params.kimiSessionId)) return [];
    const runtime = await ctx.resumeSession(params.kimiSessionId);
    if (!areSameFsPath(runtime.session.workDir, ctx.workDir)) {
      await ctx.closeSession();
      throw new Error("The selected session belongs to a different working directory.");
    }

    let history: ReturnType<typeof replaySessionToWebviewEvents>;
    try {
      const resumeState = runtime.session.getResumeState();
      if (resumeState?.agents["main"] === undefined) {
        throw new Error("Session history is unavailable.");
      }
      history = replaySessionToWebviewEvents(resumeState, runtime.id);
    } catch (error) {
      await ctx.closeSession();
      throw error;
    }

    ctx.fileManager.clearTracked(ctx.webviewId);
    const baseline = baselineSession(runtime.summary ?? {
      id: runtime.id,
      workDir: runtime.session.workDir,
    });
    try {
      const changes = await ctx.baselineManager.getChanges(baseline);
      for (const change of changes) {
        ctx.fileManager.trackFile(ctx.webviewId, path.join(baseline.workDir, change.path));
      }
      ctx.broadcast(Events.FileChangesUpdated, changes, ctx.webviewId);
    } catch (error) {
      ctx.logError("Unable to restore session file changes", error);
      ctx.broadcast(Events.FileChangesUpdated, [], ctx.webviewId);
      void Promise.resolve(
        vscode.window.showWarningMessage(
          "Kimi: This conversation opened, but its file change history is unavailable.",
          "Show Logs",
        ),
      )
        .then((action) => {
          if (action === "Show Logs") ctx.showLogs();
        })
        .catch((noticeError: unknown) => {
          ctx.logError("Unable to show the file change warning", noticeError);
        });
    }
    return history;
  },

  [Methods.DeleteKimiSession]: async (params: DeleteSessionParams, ctx): Promise<{ ok: boolean }> => {
    if (!isSessionId(params.sessionId) || !ctx.workspaceRoot) return { ok: false };
    const summary = (await ctx.harness.listSessions({ sessionId: params.sessionId }))[0];
    if (summary === undefined || !isInsideOrEqual(ctx.workspaceRoot, summary.workDir)) {
      return { ok: false };
    }
    const affectedViews = ctx.runtime.getSession(params.sessionId)?.subscribers ?? [];
    await ctx.runtime.deleteSession(params.sessionId);
    await ctx.baselineManager.deleteSession(params.sessionId);
    for (const webviewId of affectedViews) {
      ctx.fileManager.clearSession(webviewId);
      ctx.broadcast(Events.FileChangesUpdated, [], webviewId);
      if (webviewId !== ctx.webviewId) {
        ctx.broadcast(Events.NewConversation, {}, webviewId);
      }
    }
    return { ok: true };
  },

  [Methods.ForkKimiSession]: async (params: ForkSessionParams, ctx) => {
    if (!ctx.workDir || !isSessionId(params.sessionId) || !Number.isInteger(params.turnIndex) || params.turnIndex < 0) {
      return null;
    }
    const summaries = await ctx.harness.listSessions({ sessionId: params.sessionId });
    const sourceSummary = summaries[0];
    if (
      sourceSummary === undefined ||
      !ctx.workspaceRoot ||
      !isInsideOrEqual(ctx.workspaceRoot, sourceSummary.workDir)
    ) return null;

    const forkSettledSession = async () => {
      const fork = await ctx.harness.forkSession({ id: params.sessionId, turnIndex: params.turnIndex });
      const targetSummary = fork.summary;
      if (targetSummary === undefined) {
        await fork.close();
        throw new Error("Forked session metadata is unavailable.");
      }

      let materializeError: unknown;
      try {
        await ctx.baselineManager.materializeToFork(
          baselineSession(sourceSummary),
          baselineSession(targetSummary),
        );
      } catch (error) {
        materializeError = error;
      }

      try {
        await fork.close();
      } catch (error) {
        ctx.logError("Unable to close a forked session", error);
      }
      if (materializeError !== undefined) {
        await ctx.harness.deleteSession(targetSummary.id).catch((error: unknown) => {
          ctx.logError(`Unable to remove failed fork "${targetSummary.id}"`, error);
        });
        await ctx.baselineManager.deleteSession(targetSummary.id).catch((error: unknown) => {
          ctx.logError(`Unable to remove failed fork baseline "${targetSummary.id}"`, error);
        });
        throw materializeError instanceof Error
          ? materializeError
          : new Error("Unable to materialize the forked session baseline.", {
              cause: materializeError,
            });
      }
      return { sessionId: targetSummary.id };
    };

    const active = ctx.runtime.getSession(params.sessionId);
    return active === undefined
      ? forkSettledSession()
      : active.runExclusiveAfterCancelling(forkSettledSession);
  },
};

function toSessionInfo(summary: SessionSummary): SessionInfo {
  return {
    id: summary.id,
    workDir: summary.workDir,
    updatedAt: summary.updatedAt,
    brief: summary.title ?? summary.lastPrompt ?? "",
  };
}

function baselineSession(summary: Pick<SessionSummary, "id" | "workDir" | "metadata">): BaselineSession {
  return { id: summary.id, workDir: summary.workDir, metadata: summary.metadata };
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  return isFsPathInsideOrEqual(root, candidate);
}

function isSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}
