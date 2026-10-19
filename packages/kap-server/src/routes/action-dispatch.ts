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
