import type { DisplayEffect } from "@moonshot-ai/kimi-code-vscode-display-model";
import { bridge } from "@/services";

export function runDisplayEffects(effects: DisplayEffect[]): void {
  for (const effect of effects) {
    switch (effect.type) {
      case "TrackFiles":
        void bridge.trackFiles(effect.paths);
        break;
      case "ClearTrackedFiles":
        void bridge.clearTrackedFiles();
        break;
      case "OpenApproval":
      case "ClearApprovals":
      case "UpdateStatus":
      case "UpdateAvailableCommands":
      case "Notify":
        break;
    }
  }
}
