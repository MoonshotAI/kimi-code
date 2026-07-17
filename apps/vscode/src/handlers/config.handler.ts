import * as vscode from "vscode";
import {
  effectiveModelAlias,
  type KimiConfig as SdkKimiConfig,
  type ModelAlias,
  type ThinkingEffort,
} from "@moonshot-ai/kimi-code-sdk";

import { Methods } from "../../shared/bridge";
import type {
  KimiConfig as WebviewKimiConfig,
  ModelConfig,
  SlashCommandInfo,
} from "../../shared/legacy-sdk";
import type { ExtensionConfig, SessionConfig } from "../../shared/types";
import { VSCodeSettings } from "../config/vscode-settings";
import type { Handler } from "./types";

const SLASH_COMMANDS: SlashCommandInfo[] = [
  { name: "init", aliases: [], description: "Analyze the codebase and generate AGENTS.md" },
  { name: "compact", aliases: [], description: "Compact the conversation context" },
  { name: "clear", aliases: ["reset"], description: "Clear the context" },
  { name: "yolo", aliases: [], description: "Toggle YOLO mode (auto-approve tool actions; may still ask questions)" },
  {
    name: "auto",
    aliases: ["afk"],
    description: "Toggle Auto mode (fully autonomous; the agent will not ask questions)",
  },
  { name: "plan", aliases: [], description: "Toggle plan mode. Usage: /plan [on|off|view|clear]" },
  {
    name: "add-dir",
    aliases: [],
    description: "Add a directory to the workspace. Usage: /add-dir <path>",
  },
  { name: "export", aliases: [], description: "Export current session context to a markdown file" },
  { name: "import", aliases: [], description: "Import context from a file or session ID" },
];

const saveConfig: Handler<SessionConfig, { ok: boolean }> = async (params, ctx) => {
  const effort = sessionConfigEffort(params);
  await ctx.harness.setConfig({
    defaultModel: params.model,
    thinking: thinkingConfig(effort),
  });

  const runtime = ctx.getSession();
  if (runtime !== undefined) {
    const status = await runtime.session.getStatus();
    if (status.model !== params.model) await runtime.session.setModel(params.model);
    if (status.thinkingEffort !== effort) await runtime.session.setThinking(effort);
  }
  return { ok: true };
};

const getExtensionConfig: Handler<void, ExtensionConfig> = async () => {
  return VSCodeSettings.getExtensionConfig();
};

const openSettings: Handler<void, { ok: boolean }> = async () => {
  await vscode.commands.executeCommand("workbench.action.openSettings", "kimi");
  return { ok: true };
};

const getModels: Handler<void, WebviewKimiConfig> = async (_, ctx) => {
  const config = await ctx.harness.getConfig({ reload: true });
  return toWebviewConfig(config);
};

const getSlashCommands: Handler<void, SlashCommandInfo[]> = async (_, ctx) => {
  if (!ctx.workDir) return SLASH_COMMANDS;
  try {
    const skills = await ctx.harness.listWorkspaceSkills(ctx.workDir);
    const skillCommands = skills
      .filter((skill) => isUserActivatableSkill(skill.type))
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map((skill) => ({
        name: `skill:${skill.name}`,
        aliases: [],
        description: skill.description ?? "",
      }));
    return [...SLASH_COMMANDS, ...skillCommands];
  } catch (error) {
    ctx.logError("Unable to list workspace skills", error);
    return SLASH_COMMANDS;
  }
};

const showLogs: Handler<void, { ok: boolean }> = async (_, ctx) => {
  ctx.showLogs();
  return { ok: true };
};

const reloadWebview: Handler<void, { ok: boolean }> = async (_, ctx) => {
  await ctx.closeSession();
  ctx.fileManager.clearTracked(ctx.webviewId);
  ctx.reloadWebview();
  return { ok: true };
};

export const configHandlers = {
  [Methods.SaveConfig]: saveConfig,
  [Methods.GetExtensionConfig]: getExtensionConfig,
  [Methods.OpenSettings]: openSettings,
  [Methods.GetModels]: getModels,
  [Methods.GetSlashCommands]: getSlashCommands,
  [Methods.ShowLogs]: showLogs,
  [Methods.ReloadWebview]: reloadWebview,
} as Record<string, Handler<any, any>>;

export function toWebviewConfig(config: SdkKimiConfig): WebviewKimiConfig {
  const models: ModelConfig[] = Object.entries(config.models ?? {})
    .map(([id, model]) => toWebviewModel(id, model))
    .toSorted((left, right) => left.name.localeCompare(right.name));
  return {
    defaultModel: config.defaultModel ?? models[0]?.id ?? null,
    defaultThinking: config.thinking?.enabled !== false,
    defaultThinkingEffort: config.thinking?.effort,
    models,
  };
}

function toWebviewModel(id: string, model: ModelAlias): ModelConfig {
  const effective = effectiveModelAlias(model);
  return {
    id,
    name: effective.displayName ?? effective.model ?? id,
    provider: effective.provider,
    capabilities: [...(effective.capabilities ?? [])],
    adaptive_thinking: effective.adaptiveThinking,
    support_efforts:
      effective.supportEfforts === undefined ? undefined : [...effective.supportEfforts],
    default_effort: effective.defaultEffort,
  };
}

function sessionConfigEffort(config: SessionConfig): ThinkingEffort {
  if (config.effort !== undefined) return config.effort as ThinkingEffort;
  return config.thinking === true ? "on" : "off";
}

function thinkingConfig(effort: ThinkingEffort): { enabled: boolean; effort?: string } {
  if (effort === "off") return { enabled: false };
  if (effort === "on") return { enabled: true };
  return { enabled: true, effort };
}

function isUserActivatableSkill(type: string | undefined): boolean {
  return type === undefined || type === "prompt" || type === "inline" || type === "flow";
}
