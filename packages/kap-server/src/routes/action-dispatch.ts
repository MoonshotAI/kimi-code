import { z } from 'zod';

import { parseActionSuffix } from './action-suffix';

export interface ActionHandler<TExtra> {
  readonly body?: z.ZodTypeAny;
  handle(ctx: TExtra & { readonly id: string; readonly body: unknown }): Promise<void> | void;
}

export type ActionTable<TAction extends string, TExtra> = Readonly<
  Record<TAction, ActionHandler<TExtra>>
>;

export function actionNames<TAction extends string, TExtra>(
  actions: ActionTable<TAction, TExtra>,
): readonly TAction[] {
  return Object.keys(actions) as unknown as readonly TAction[];
}

/**
 * Parse an `{id}:{action}` path tail against the table's action names.
 * Returns the resolved target, or `{ message }` for the validation-failure
 * response when the tail is not a known action.
 */
export function resolveActionTarget<TAction extends string, TExtra>(opts: {
  readonly tail: string;
  readonly actions: ActionTable<TAction, TExtra>;
  readonly resourceLabel: string;
}): { readonly id: string; readonly action: TAction } | { readonly message: string } {
  const parsed = parseActionSuffix({
    tail: opts.tail,
    allowedActions: actionNames(opts.actions),
    resourceLabel: opts.resourceLabel,
  });
  if (parsed.kind !== 'action') {
    return {
      message: parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${opts.tail}`,
    };
  }
  return { id: parsed.id, action: parsed.action };
}

/**
 * Invoke the table entry for `action`, validating the raw body against the
 * entry's schema first when it declares one. Returns false when no entry
 * matches, leaving the unsupported-action response to the caller.
 */
export async function runAction<TAction extends string, TExtra>(opts: {
  readonly action: string;
  readonly id: string;
  readonly actions: ActionTable<TAction, TExtra>;
  readonly extra: TExtra;
  readonly body?: unknown;
}): Promise<boolean> {
  const entry = opts.actions[opts.action as TAction];
  if (entry === undefined) {
    return false;
  }
  const body = entry.body === undefined ? opts.body : entry.body.parse(opts.body);
  await entry.handle({ ...opts.extra, id: opts.id, body });
  return true;
}

/**
 * Resolve the tail and invoke the matching handler in one step, for routes
 * whose parse guard needs no site-specific logic. `onUnsupported` produces
 * the route's validation-failure response; the return value reports whether
 * a handler ran.
 */
export async function dispatchAction<TAction extends string, TExtra>(opts: {
  readonly tail: string;
  readonly actions: ActionTable<TAction, TExtra>;
  readonly resourceLabel: string;
  readonly extra: TExtra;
  readonly body?: unknown;
  readonly onUnsupported: (message: string) => void;
}): Promise<boolean> {
  const target = resolveActionTarget(opts);
  if ('message' in target) {
    opts.onUnsupported(target.message);
    return false;
  }
  return runAction({
    action: target.action,
    id: target.id,
    actions: opts.actions,
    extra: opts.extra,
    body: opts.body,
  });
}
