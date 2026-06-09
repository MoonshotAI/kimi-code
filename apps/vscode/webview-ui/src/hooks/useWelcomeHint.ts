import { useState, useEffect, useMemo } from "react";
import { bridge } from "@/services";

export interface WelcomeHint {
  title: string;
  description: string;
  slashCommand?: string;
}

const HINT_AGENT_MD: WelcomeHint = {
  title: "Help me understand your codebase",
  description: "Type /init and I'll analyze your project and generate documentation",
  slashCommand: "/init",
};

const HINT_FIRST_TIME: WelcomeHint = {
  title: "Not sure where to begin?",
  description: 'Try asking: "What does this project do?"',
};

const HINTS_POOL: WelcomeHint[] = [
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
    description: "Enable YOLO mode to auto-approve actions",
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
    // 30% chance to show AGENT.md hint if missing
    if (hasAgentMd === false && withProbability(0.3)) {
      return HINT_AGENT_MD;
    }
    // 20% chance to show first-time hint if no history
    if (hasHistory === false && withProbability(0.2)) {
      return HINT_FIRST_TIME;
    }
    return pickRandom(HINTS_POOL);
  }, [hasAgentMd, hasHistory]);
}
