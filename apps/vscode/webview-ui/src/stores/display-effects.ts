import type { DisplayEffect } from "@moonshot-ai/kimi-code-vscode-display-model";
import { bridge } from "@/services";

export function runDisplayEffects(effects: DisplayEffect[]): void {
  for (const effect of effects) {
    switch (effect.type) {
      case "TrackFiles":
        bridge.trackFiles(effect.paths).catch((err) => {
          console.warn("Failed to track files:", err);
        });
        break;
      case "ClearTrackedFiles":
        bridge.clearTrackedFiles().catch((err) => {
          console.warn("Failed to clear tracked files:", err);
        });
        break;
      // These effects are handled through dedicated state paths in the webview
      // (approvals, session status, available commands, notifications) rather
      // than via the bridge, so they are intentionally no-ops here.
      case "OpenApproval":
      case "ClearApprovals":
      case "UpdateStatus":
      case "UpdateAvailableCommands":
      case "Notify":
        break;
    }
  }
}
