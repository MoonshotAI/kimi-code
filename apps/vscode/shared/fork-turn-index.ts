interface ForkTurnItem {
  readonly type: string;
}

interface ForkTurnMessage {
  readonly role: "user" | "assistant";
  readonly turnIndex?: number;
  readonly forkable?: boolean;
  readonly steps?: readonly {
    readonly items: readonly ForkTurnItem[];
  }[];
}

/** Return the core turnId for an assistant bubble, with a legacy message-derived fallback. */
export function getForkTurnIndex(
  messages: readonly ForkTurnMessage[],
  messageIndex: number,
): number | undefined {
  const target = messages[messageIndex];
  if (target?.role !== "assistant" || target.forkable === false) return undefined;
  if (target.turnIndex !== undefined) return target.turnIndex;

  let visibleTurns = 0;
  for (let index = 0; index <= messageIndex; index += 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.role === "user" && message.forkable !== false) {
      visibleTurns += 1;
      continue;
    }
    if (message.role === "assistant") {
      visibleTurns += countSteers(message);
    }
  }
  return visibleTurns - 1;
}

function countSteers(message: ForkTurnMessage): number {
  return (
    message.steps?.reduce(
      (count, step) => count + step.items.filter((item) => item.type === "steer").length,
      0,
    ) ?? 0
  );
}
