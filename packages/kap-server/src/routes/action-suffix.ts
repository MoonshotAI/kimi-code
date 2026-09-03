export type ActionSuffixParse<TAction extends string> =
  | { readonly kind: 'bare'; readonly id: string }
  | { readonly kind: 'action'; readonly id: string; readonly action: TAction }
  | { readonly kind: 'invalid'; readonly reason: string };

export interface ParseActionSuffixOptions<TAction extends string> {
  readonly tail: string;
  readonly allowedActions: readonly TAction[];
  readonly defaultAction?: TAction;
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
