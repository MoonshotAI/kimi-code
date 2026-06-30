import { IconAlertTriangle, IconTerminal2, IconLoader2, IconFolderOpen } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { KimiMascot } from "./KimiMascot";
import { bridge } from "@/services";

interface Props {
  type: "loading" | "cli-error" | "no-models" | "no-workspace";
  errorMessage?: string | null;
}

export function ConfigErrorScreen({ type, errorMessage }: Props) {
  if (type === "loading") {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="text-center space-y-4">
          <KimiMascot className="h-10 mx-auto opacity-50" />
          <div className="inline-flex items-center gap-2 text-muted-foreground">
            <IconLoader2 className="size-4 animate-spin" />
            <span className="text-sm">Initializing...</span>
          </div>
        </div>
      </div>
    );
  }

  if (type === "no-workspace") {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="max-w-sm text-center space-y-6">
          <KimiMascot className="h-10 mx-auto opacity-50" />
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 text-amber-500">
              <IconFolderOpen className="size-5" />
              <span className="text-sm font-medium">No Workspace Open</span>
            </div>
            <p className="text-xs text-muted-foreground">Please open a folder to start using Kimi Code.</p>
          </div>
          <Button onClick={() => bridge.openFolder()} className="gap-2">
            <IconFolderOpen className="size-4" />
            Open Folder
          </Button>
        </div>
      </div>
    );
  }

  if (type === "cli-error") {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="max-w-sm text-center space-y-6">
          <KimiMascot className="h-10 mx-auto opacity-50" />
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 text-amber-500">
              <IconAlertTriangle className="size-5" />
              <span className="text-sm font-medium">CLI Error</span>
            </div>
            {errorMessage && <p className="text-xs text-muted-foreground">{errorMessage}</p>}
          </div>
          <div className="bg-muted/50 rounded-lg p-4 text-left space-y-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <IconTerminal2 className="size-4" />
              <span>Manual install:</span>
            </div>
            <code className="block text-xs bg-background rounded px-3 py-2 font-mono select-all">uv tool install --python 3.13 kimi-code</code>
          </div>
        </div>
      </div>
    );
  }

  // no models or CLI not configured
  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="max-w-sm text-center space-y-6">
        <KimiMascot className="h-10 mx-auto opacity-50" />
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 text-amber-500">
            <IconAlertTriangle className="size-5" />
            <span className="text-sm font-medium">Configuration Required</span>
          </div>
          <p className="text-xs text-muted-foreground">Kimi Code is not configured. Please run setup first.</p>
        </div>
        <div className="bg-muted/50 rounded-lg p-4 text-left space-y-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <IconTerminal2 className="size-4" />
            <span>Run in terminal:</span>
          </div>
          <code className="block text-xs bg-background rounded px-3 py-2 font-mono select-all">kimi-code setup</code>
        </div>
      </div>
    </div>
  );
}
