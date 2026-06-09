/**
 * `parseActionSuffix` — shared helper for the `:action` URL convention
 * (REST.md §1.6) introduced because Fastify's path syntax cannot disambiguate
 * `:resource_id` from `:resource_id:action` on the same path prefix.
 *
 * Pattern: routes register a path `/...prefix/:tail` and pass the captured
 * `tail` segment to this helper along with the list of allowed actions. The
 * helper returns one of:
 *   - `{kind: 'bare', id: tail}`           — no action suffix, action defaulted
 *   - `{kind: 'action', id, action}`       — `id:action` parse
 *   - `{kind: 'invalid', reason}`          — unknown action or empty id
 *
 * Callers emit a `40001 VALIDATION_FAILED` envelope on `invalid`. The default
 * action (when the caller's resource has a bare form) is encoded by the
 * `defaultAction` parameter — pass `undefined` if the route disallows the
 * bare form.
 *
 * Examples (allowedActions = ['dismiss'], defaultAction = 'resolve'):
 *   'q123'         → {kind:'bare',   id:'q123'}    → resolve
 *   'q123:dismiss' → {kind:'action', id:'q123', action:'dismiss'}
 *   'q123:foo'     → {kind:'invalid', reason:'unsupported action: q123:foo'}
 *   ':dismiss'     → {kind:'invalid', reason:'invalid <resource>_id in path'}
 *
 * **Why `lastIndexOf(':')`**: resource ids may CONTAIN a colon (e.g. mcp tool
 * qualified names like `mcp:lark:search` if ever used in path position). We
 * only treat the FINAL `:` as the action separator so internal colons survive.
 */

export type ActionSuffixParse<TAction extends string> =
  | { readonly kind: 'bare'; readonly id: string }
  | { readonly kind: 'action'; readonly id: string; readonly action: TAction }
  | { readonly kind: 'invalid'; readonly reason: string };

export interface ParseActionSuffixOptions<TAction extends string> {
  readonly tail: string;
  readonly allowedActions: readonly TAction[];
  /**
   * When set, a bare `<id>` (no action suffix) is accepted and reported as
   * `{kind:'bare'}`. When `undefined`, bare ids are rejected with
   * `unsupported action: <tail>` — appropriate for resources where every
   * REST action is an explicit `:verb` (e.g. `/sessions/{sid}/prompts/`).
   */
  readonly defaultAction?: TAction;
  /**
   * Resource label used in the error message for empty-id failures, e.g.
   * `'question'` → `"invalid question_id in path"`. Defaults to `'resource'`.
   */
  readonly resourceLabel?: string;
}

export function parseActionSuffix<TAction extends string>(
  opts: ParseActionSuffixOptions<TAction>,
): ActionSuffixParse<TAction> {
  const { tail, allowedActions, defaultAction, resourceLabel = 'resource' } = opts;
  const idx = tail.lastIndexOf(':');
  // No colon → bare id (allowed iff defaultAction is set).
  if (idx <= 0) {
    if (tail.length === 0) {
      return { kind: 'invalid', reason: `invalid ${resourceLabel}_id in path` };
    }
    if (defaultAction !== undefined) {
      return { kind: 'bare', id: tail };
    }
    return { kind: 'invalid', reason: `unsupported action: ${tail}` };
  }
  const id = tail.slice(0, idx);
  const suffix = tail.slice(idx + 1);
  // Trailing colon with empty suffix.
  if (suffix === '') {
    if (defaultAction !== undefined) {
      return { kind: 'bare', id: tail };
    }
    return { kind: 'invalid', reason: `unsupported action: ${tail}` };
  }
  if (id.length === 0) {
    return { kind: 'invalid', reason: `invalid ${resourceLabel}_id in path` };
  }
  // Type narrowing: only allow declared actions through.
  const matched = (allowedActions as readonly string[]).find((a) => a === suffix);
  if (matched === undefined) {
    return { kind: 'invalid', reason: `unsupported action: ${tail}` };
  }
  return { kind: 'action', id, action: matched as TAction };
}
