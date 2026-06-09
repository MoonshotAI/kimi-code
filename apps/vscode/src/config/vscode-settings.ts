import * as vscode from "vscode";
import type { ExtensionConfig } from "../../shared/types";

function getConfig() {
  return vscode.workspace.getConfiguration("kimi");
}

export const VSCodeSettings = {
  get yoloMode(): boolean {
    return getConfig().get<boolean>("yoloMode", false);
  },

  get autosave(): boolean {
    return getConfig().get<boolean>("autosave", true);
  },

  get executablePath(): string {
    return getConfig().get<string>("executablePath", "");
  },

  get enableNewConversationShortcut(): boolean {
    return getConfig().get<boolean>("enableNewConversationShortcut", false);
  },

  get useCtrlEnterToSend(): boolean {
    return getConfig().get<boolean>("useCtrlEnterToSend", false);
  },

  get environmentVariables(): Record<string, string> {
    return getConfig().get<Record<string, string>>("environmentVariables", {});
  },

  getExtensionConfig(): ExtensionConfig {
    return {
      executablePath: this.executablePath,
      yoloMode: this.yoloMode,
      autosave: this.autosave,
      useCtrlEnterToSend: this.useCtrlEnterToSend,
      enableNewConversationShortcut: this.enableNewConversationShortcut,
      environmentVariables: this.environmentVariables,
    };
  },
};

export function onSettingsChange(callback: (changedKeys: string[]) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration("kimi")) {
      return;
    }
    const keys = ["yoloMode", "autosave", "executablePath", "enableNewConversationShortcut", "useCtrlEnterToSend", "environmentVariables"];
    const changedKeys = keys.filter((key) => e.affectsConfiguration(`kimi.${key}`));
    if (changedKeys.length > 0) {
      callback(changedKeys);
    }
  });
}
