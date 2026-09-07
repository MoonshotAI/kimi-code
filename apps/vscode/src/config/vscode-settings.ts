import * as vscode from "vscode";
import type { ExtensionConfig } from "../../shared/types";

declare const __EXTENSION_VERSION__: string;
const EXTENSION_VERSION = typeof __EXTENSION_VERSION__ !== "undefined" ? __EXTENSION_VERSION__ : "0.0.0";

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

  get enableNewConversationShortcut(): boolean {
    return getConfig().get<boolean>("enableNewConversationShortcut", false);
  },

  get useCtrlEnterToSend(): boolean {
    return getConfig().get<boolean>("useCtrlEnterToSend", false);
  },

  get showThinkingContent(): boolean {
    return getConfig().get<boolean>("showThinkingContent", false);
  },

  get showThinkingExpanded(): boolean {
    return getConfig().get<boolean>("showThinkingExpanded", false);
  },

  get editorContext(): "never" | "onConversationStart" | "onFileChange" {
    return getConfig().get<"never" | "onConversationStart" | "onFileChange">("editorContext", "never");
  },

  getExtensionConfig(): ExtensionConfig {
    return {
      yoloMode: this.yoloMode,
      autosave: this.autosave,
      useCtrlEnterToSend: this.useCtrlEnterToSend,
      enableNewConversationShortcut: this.enableNewConversationShortcut,
      showThinkingContent: this.showThinkingContent,
      showThinkingExpanded: this.showThinkingExpanded,
      version: EXTENSION_VERSION,
    };
  },
};

export function onSettingsChange(callback: (changedKeys: string[]) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration("kimi")) {
      return;
    }
    const keys = ["yoloMode", "autosave", "enableNewConversationShortcut", "useCtrlEnterToSend", "showThinkingContent", "showThinkingExpanded", "editorContext"];
    const changedKeys = keys.filter((key) => e.affectsConfiguration(`kimi.${key}`));
    if (changedKeys.length > 0) {
      callback(changedKeys);
    }
  });
}
