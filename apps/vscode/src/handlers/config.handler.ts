import * as vscode from "vscode";
import { Methods } from "../../shared/bridge";
import { VSCodeSettings } from "../config/vscode-settings";
import { parseConfig, saveDefaultModel } from "@moonshot-ai/kimi-code-vscode-agent-sdk";
import type { SessionConfig, ExtensionConfig } from "../../shared/types";
import type { KimiConfig, AgentMode } from "@moonshot-ai/kimi-code-vscode-agent-sdk";
import type { Handler } from "./types";

const saveConfig: Handler<SessionConfig, { ok: boolean }> = async (params) => {
  saveDefaultModel(params.model, params.thinking);
  return { ok: true };
};

const setMode: Handler<{ mode: AgentMode }, { ok: boolean }> = async (params, ctx) => {
  // Mode is ephemeral per conversation. Hot-apply it to the live ACP session;
  // the webview also passes it on the next streamChat.
  const session = ctx.getSession();
  if (session) {
    session.mode = normalizeMode(params.mode);
    await session.applyConfigNow();
  }
  return { ok: true };
};

const setYoloMode: Handler<{ enabled: boolean }, { ok: boolean }> = async (params, ctx) => {
  return setMode({ mode: params.enabled ? "yolo" : "default" }, ctx);
};

const getExtensionConfig: Handler<void, ExtensionConfig> = async () => {
  return VSCodeSettings.getExtensionConfig();
};

const openSettings: Handler<void, { ok: boolean }> = async () => {
  await vscode.commands.executeCommand("workbench.action.openSettings", "kimi");
  return { ok: true };
};

const reloadPlugin: Handler<void, { ok: boolean }> = async (_params, ctx) => {
  // Reload ONLY the Kimi webview (re-runs its init → re-reads config.toml
  // models, MCP and extension config) without reloading the whole window.
  ctx.reloadWebview();
  return { ok: true };
};

const getModels: Handler<void, KimiConfig> = async () => {
  return parseConfig();
};

export const configHandlers = {
  [Methods.SaveConfig]: saveConfig,
  [Methods.SetMode]: setMode,
  [Methods.SetYoloMode]: setYoloMode,
  [Methods.GetExtensionConfig]: getExtensionConfig,
  [Methods.OpenSettings]: openSettings,
  [Methods.ReloadPlugin]: reloadPlugin,
  [Methods.GetModels]: getModels,
} as Record<string, Handler<any, any>>;

function normalizeMode(mode: AgentMode): AgentMode {
  return mode === "plan" || mode === "auto" || mode === "yolo" ? mode : "default";
}
