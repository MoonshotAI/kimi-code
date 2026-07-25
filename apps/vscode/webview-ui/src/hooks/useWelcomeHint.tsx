import { useState, useEffect, useMemo } from "react";
import { bridge } from "@/services";

export interface WelcomeHint {
  title: string;
  description: string;
  slashCommand?: string;
  component?: React.ReactNode;
}

function ShortcutRow({ kbd, children }: { kbd: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-start gap-3">
      <kbd className="kbd shrink-0">{kbd}</kbd>
      <span className="text-right">{children}</span>
    </div>
  );
}

function ShortcutGuide() {
  return (
    <div className="text-left text-xs mt-2 space-y-5 w-full max-w-96">
      <div>
        <div className="font-medium text-foreground mb-1.5">⚡ Commands</div>
        <div className="text-muted-foreground space-y-1">
          <ShortcutRow kbd="/">View all commands</ShortcutRow>
          <ShortcutRow kbd="/init">Scan project and generate AGENTS.md file</ShortcutRow>
          <ShortcutRow kbd="/compact">Trim context so that I focus on the essentials</ShortcutRow>
        </div>
      </div>
      <div>
        <div className="font-medium text-foreground mb-1.5">💡 Tips</div>
        <div className="text-muted-foreground space-y-1">
          <ShortcutRow kbd="↑">Browse input history</ShortcutRow>
          <ShortcutRow kbd="@">Add/Search files to reference</ShortcutRow>
          <ShortcutRow kbd="Alt+K">Add selected code directly from editor</ShortcutRow>
        </div>
      </div>
      <div>
        <div className="font-medium text-foreground mb-1.5">🚀 Pro Tips</div>
        <div className="text-muted-foreground space-y-1">
          <div>• Use YOLO mode to auto-approve tool calls</div>
          <div>• AGENTS.md helps me understand your codebase</div>
          <div>• Enable Thinking for complex tasks</div>
        </div>
      </div>
    </div>
  );
}

const HINT_FIRST_TIME: WelcomeHint = {
  title: "Quick Start Guide",
  description: "",
  component: <ShortcutGuide />,
};

const HINT_AGENT_MD: WelcomeHint = {
  title: "Let me map your codebase",
  description: "Run /init to scan the project and generate docs",
  slashCommand: "/init",
};

const HINTS_POOL: WelcomeHint[] = [
  HINT_FIRST_TIME,
  HINT_AGENT_MD,
  {
    title: "Reference specific code",
    description: "Type @ to select files, or press Alt+K with code highlighted",
  },
  {
    title: "See what I can do",
    description: "Type / for all commands—like /compact to trim context",
  },
  {
    title: "Need deeper analysis?",
    description: "Enable thinking mode for complex architecture or debugging",
  },
  {
    title: "More than code",
    description: "Paste a screenshot or design and I'll help implement it",
  },
  {
    title: "Add more tools",
    description: "Connect external services via MCP servers in settings",
  },
  {
    title: "Prefer fewer interruptions?",
    description: "Enable YOLO mode to auto-approve",
  },
  {
    title: "Context getting long?",
    description: "Type /compact to keep only the essentials",
    slashCommand: "/compact",
  },
];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function withProbability(p: number): boolean {
  return Math.random() < p;
}

export function useWelcomeHint(): WelcomeHint {
  const [hasAgentMd, setHasAgentMd] = useState<boolean | null>(null);
  const [hasHistory, setHasHistory] = useState<boolean | null>(null);

  useEffect(() => {
    bridge
      .checkFileExists("AGENT.md")
      .then(setHasAgentMd)
      .catch(() => setHasAgentMd(false));
    bridge
      .getKimiSessions()
      .then((s) => setHasHistory(s.length > 0))
      .catch(() => setHasHistory(false));
  }, []);

  return useMemo(() => {
    // First time user: show shortcut guide
    if (hasHistory === false) {
      return HINT_FIRST_TIME;
    }
    // 30% chance to show AGENT.md hint if missing
    if (hasAgentMd === false && withProbability(0.3)) {
      return HINT_AGENT_MD;
    }
    return pickRandom(HINTS_POOL);
  }, [hasAgentMd, hasHistory]);
}
