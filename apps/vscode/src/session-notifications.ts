export interface BackgroundSessionNotice {
  readonly sessionId: string;
  readonly kind: "info" | "error";
  readonly message: string;
}

export class BackgroundSessionNotificationTracker {
  private readonly events = new WeakSet<object>();

  next(event: unknown, activeSessionId: string | undefined): BackgroundSessionNotice | null {
    if (typeof event !== "object" || event === null || this.events.has(event)) return null;
    this.events.add(event);
    return getBackgroundSessionNotice(event, activeSessionId);
  }
}

export function getBackgroundSessionNotice(
  event: unknown,
  activeSessionId: string | undefined,
): BackgroundSessionNotice | null {
  if (!isRecord(event)) return null;
  const sessionId = event["_sessionId"];
  const type = event["type"];
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId === activeSessionId) return null;

  if (type === "QuestionRequest") {
    return { sessionId, kind: "info", message: "needs your answer" };
  }
  if (type === "ApprovalRequest") {
    return { sessionId, kind: "info", message: "needs your approval" };
  }
  if (type === "stream_complete") {
    const result = event["result"];
    if (!isRecord(result) || result["status"] === "cancelled") return null;
    return { sessionId, kind: "info", message: "finished" };
  }
  if (type === "error" && event["terminal"] !== false) {
    return { sessionId, kind: "error", message: "failed" };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
