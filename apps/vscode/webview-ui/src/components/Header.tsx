import { useState } from "react";
import { IconPlus, IconChevronDown } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { KimiLogo } from "./KimiLogo";
import { SessionList } from "./SessionList";
import { useChatStore, useSettingsStore } from "@/stores";
import { bridge } from "@/services";
import type { AgentMode } from "@moonshot-ai/kimi-code-vscode-agent-sdk";

const MODE_OPTIONS: Array<{ value: AgentMode; label: string }> = [
  { value: "default", label: "Default" },
  { value: "plan", label: "Plan" },
  { value: "auto", label: "Auto" },
  { value: "yolo", label: "YOLO" },
];

function ModeSelector() {
  const mode = useSettingsStore((state) => state.mode);
  const setMode = useSettingsStore((state) => state.setMode);

  const changeMode = (next: AgentMode) => {
    setMode(next);
    bridge.setMode(next);
  };

  return (
    <Select value={mode} onValueChange={(value) => changeMode(value as AgentMode)}>
      <SelectTrigger size="sm" className="h-6 min-w-20 rounded border-border px-1.5 text-[11px]" title="ACP mode">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end" className="min-w-28">
        {MODE_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value} className="text-xs">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function Header() {
  const [showSessionList, setShowSessionList] = useState(false);
  const startNewConversation = useChatStore((state) => state.startNewConversation);

  const handleNewSession = async () => {
    await startNewConversation();
    setShowSessionList(false);
  };

  return (
    <header className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0 @container">
      <div className="flex items-center gap-2">
        <KimiLogo className="size-5" />
        <span className="text-sm font-semibold">Kimi Code</span>
      </div>
      <div className="flex items-center gap-1.5">
        <ModeSelector />
        <Popover open={showSessionList} onOpenChange={setShowSessionList}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="xs" className="gap-1 h-6">
              <span className="text-xs @max-[280px]:hidden">History</span>
              <IconChevronDown className="size-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-0">
            <SessionList onClose={() => setShowSessionList(false)} />
          </PopoverContent>
        </Popover>
        <Button variant="ghost" size="icon-xs" onClick={handleNewSession}>
          <IconPlus className="size-3.5" />
        </Button>
      </div>
    </header>
  );
}
