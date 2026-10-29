import { execFile, spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import * as vscode from "vscode";
import { Methods } from "../../shared/bridge";
import type { Handler } from "./types";
import type { WorkspaceStatus } from "shared/types";

const INPUT_HISTORY_KEY = "kimi.inputHistory";
const MAX_HISTORY_SIZE = 100;
const LINUX_OPENER_OBSERVATION_MS = 1000;
const DESKTOP_PROTOCOL = "kimi-code";

const checkWorkspace: Handler<void, WorkspaceStatus> = async (_, ctx) => {
  return {
    hasWorkspace: ctx.workDir !== null,
    path: ctx.workDir ?? undefined,
    workspaceRoot: ctx.workspaceRoot ?? undefined,
    isRemote: Boolean(vscode.env.remoteName),
  };
};

const openFolder: Handler<void, { ok: boolean }> = async () => {
  await vscode.commands.executeCommand("vscode.openFolder");
  return { ok: true };
};

function openDesktopUrlOnLinux(url: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore", env });
  let timer: NodeJS.Timeout;

  const errorResult = new Promise<boolean>((resolve) => {
    child.once("error", () => {
      resolve(false);
    });
  });
  const exitResult = new Promise<boolean>((resolve) => {
    child.once("exit", (code) => {
      resolve(code === 0);
    });
  });
  const timeoutResult = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(true);
    }, LINUX_OPENER_OBSERVATION_MS);
  });

  return Promise.race([errorResult, exitResult, timeoutResult]).finally(() => {
    clearTimeout(timer);
    child.removeAllListeners();
    child.unref();
  });
}

function openDesktopApp(workDir: string): Promise<boolean> {
  const env = { ...process.env };
  delete env["ELECTRON_RUN_AS_NODE"];

  const url = `${DESKTOP_PROTOCOL}://open?root=${encodeURIComponent(resolvePath(workDir))}&new=1`;
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return openDesktopUrlOnLinux(url, env);
  }

  const command: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : [
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(
              `if (-not (Test-Path 'Registry::HKEY_CLASSES_ROOT\\${DESKTOP_PROTOCOL}\\shell\\open\\command')) { exit 1 } ` +
                `try { Start-Process -FilePath '${url.replaceAll("'", "''")}' -ErrorAction Stop } catch { exit 1 }`,
              "utf16le",
            ).toString("base64"),
          ],
        ];

  return new Promise((resolve) => {
    execFile(command[0], command[1], { windowsHide: true, env }, (error) => {
      resolve(error === null);
    });
  });
}

const openInDesktop: Handler<void, { ok: boolean }> = async (_, ctx) => {
  if (ctx.workDir === null || vscode.env.remoteName) return { ok: false };
  return { ok: await openDesktopApp(ctx.workDir) };
};

const installDesktop: Handler<void, { ok: boolean }> = async () => {
  return { ok: await vscode.env.openExternal(vscode.Uri.parse("https://www.kimi.com/code")) };
};

const getInputHistory: Handler<void, string[]> = async (_, ctx) => {
  return ctx.workspaceState.get<string[]>(INPUT_HISTORY_KEY, []);
};

const addInputHistory: Handler<{ text: string }, { ok: boolean }> = async ({ text }, ctx) => {
  const history = ctx.workspaceState.get<string[]>(INPUT_HISTORY_KEY, []);
  // 避免重复添加相同的最近一条
  if (history.at(-1) !== text) {
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
  [Methods.OpenInDesktop]: openInDesktop,
  [Methods.InstallDesktop]: installDesktop,
  [Methods.GetInputHistory]: getInputHistory,
  [Methods.AddInputHistory]: addInputHistory,
};
