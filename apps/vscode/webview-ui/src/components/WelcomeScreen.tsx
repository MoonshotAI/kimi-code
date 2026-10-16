import { KimiMascot } from "./KimiMascot";
import { DesktopBanner } from "./DesktopBanner";
import { useWelcomeHint } from "@/hooks/useWelcomeHint";

export function WelcomeScreen() {
  const hint = useWelcomeHint();

  return (
    <div className="flex w-full min-w-0 flex-col items-center gap-3 px-4 py-6">
      <KimiMascot className="h-12" />
      <div className="text-center space-y-0.5">
        <p className="text-xs font-medium text-foreground">{hint.title}</p>
        {hint.description ? <p className="text-xs text-muted-foreground">{hint.description}</p> : null}
      </div>
      <DesktopBanner />
      {hint.component}
    </div>
  );
}
