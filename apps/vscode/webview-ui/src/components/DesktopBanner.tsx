import { bridge } from "@/services";
import { useSettingsStore } from "@/stores";
import { Button } from "./ui/button";
import { toast } from "./ui/sonner";

async function openInDesktop() {
  const result = await bridge.openInDesktop().catch(() => ({ ok: false }));
  if (!result.ok) toast.error("Could not open Kimi Code Desktop. Install it and try again.");
}

export function DesktopBanner() {
  const canOpenInDesktop = useSettingsStore((state) => state.workspaceRoot !== null && !state.isRemote);

  return (
    <div className="w-full min-w-0 max-w-96 rounded-lg border border-border bg-card p-3 text-left text-card-foreground shadow-sm">
      <p className="text-xs font-medium">✦ Kimi Code Desktop is here</p>
      <p className="mt-1 text-xs text-muted-foreground">Everything you love about Kimi Code, now on desktop</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {canOpenInDesktop ? (
          <Button
            type="button"
            size="xs"
            className="bg-foreground text-background hover:bg-foreground/80"
            onClick={() => void openInDesktop()}
          >
            Open in Desktop
          </Button>
        ) : null}
        <Button type="button" variant="secondary" size="xs" onClick={() => void bridge.installDesktop()}>
          Install
        </Button>
      </div>
    </div>
  );
}
