/**
 * Collapses consecutive same-role "user" turns in a provider's already-converted
 * wire message list into one turn.
 *
 * Strict providers (Anthropic, Gemini/Vertex) reject consecutive user turns with
 * HTTP 400 ("roles must alternate"). Consecutive user turns arise naturally:
 *   - after compaction, whose shape is `[kept user prompts, user-role summary,
 *     injected reminders]` — all role 'user'; and
 *   - when a user turn (steer/injection) follows a tool result.
 *
 * Both only become visible once tool messages have been converted to user-role
 * turns, which is why this runs at each provider's conversion boundary rather
 * than in the provider-agnostic projector: the projector deliberately preserves
 * message structure for lenient providers (OpenAI/Kimi) that accept — and read
 * more clearly — distinct turns, while strict providers normalize for their own
 * protocol here. Keeping the algorithm in one place stops a provider from
 * silently omitting it (the original cause of the Gemini regression).
 *
 * The merge is asymmetric, keyed on whether the running turn is tool-result-only:
 *   - a tool-result-only running turn absorbs whatever follows — another
 *     tool-result-only turn (the parallel-tool-use spec requires all tool
 *     results answering parallel calls to share one user turn) or a following
 *     text turn, yielding a valid `[tool_result, …, text]` turn;
 *   - a text running turn absorbs only a following text turn, never a leading
 *     tool-result turn (a tool-result must answer the immediately preceding
 *     assistant tool_use, which a text turn is not — though in well-formed
 *     transcripts this ordering never arises).
 *
 * @typeParam T - the provider's wire message type (e.g. Anthropic `MessageParam`
 *   or Google `Content`).
 * @param messages - the converted wire messages, in order.
 * @param ops - provider-specific predicates and a content merger.
 * @param ops.isUser - whether a wire message is a user-role turn.
 * @param ops.isToolResultOnly - whether a user-role turn carries only tool
 *   results (no plain text/media).
 * @param ops.merge - produces a new wire message combining `last` and `next`
 *   (must not mutate its arguments).
 * @returns a new array with consecutive user turns merged.
 */
export function mergeConsecutiveUserMessages<T>(
  messages: readonly T[],
  ops: {
    readonly isUser: (message: T) => boolean;
    readonly isToolResultOnly: (message: T) => boolean;
    readonly merge: (last: T, next: T) => T;
  },
): T[] {
  const out: T[] = [];
  for (const message of messages) {
    const lastIndex = out.length - 1;
    const last = lastIndex >= 0 ? out[lastIndex] : undefined;
    if (
      last !== undefined &&
      ops.isUser(last) &&
      ops.isUser(message) &&
      (ops.isToolResultOnly(last) || !ops.isToolResultOnly(message))
    ) {
      out[lastIndex] = ops.merge(last, message);
    } else {
      out.push(message);
    }
  }
  return out;
}
