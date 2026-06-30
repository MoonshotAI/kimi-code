/** Generate a UUID-like string. Falls back to a time+random based id when `crypto.randomUUID` is unavailable. */
export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // ignore and fall through
    }
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
