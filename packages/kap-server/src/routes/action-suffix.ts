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
  if (suffix === '') {
    if (defaultAction !== undefined) {
      return { kind: 'bare', id: tail };
    }
    return { kind: 'invalid', reason: `unsupported action: ${tail}` };
  }
  if (id.length === 0) {
    return { kind: 'invalid', reason: `invalid ${resourceLabel}_id in path` };
  }
  const matched = (allowedActions as readonly string[]).find((a) => a === suffix);
  if (matched === undefined) {
    return { kind: 'invalid', reason: `unsupported action: ${tail}` };
  }
  return { kind: 'action', id, action: matched as TAction };
}
