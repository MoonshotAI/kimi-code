export const hookChainResultMarker: unique symbol = Symbol('hook.chain.result');

export interface HookFailure {
  readonly hookId?: string;
  readonly error: unknown;
  readonly paused: boolean;
  readonly blocking: boolean;
  readonly suspend?: () => void;
}

export interface HookChainResult<D> {
  readonly [hookChainResultMarker]: true;
  readonly decision?: D;
  readonly blocked?: unknown;
  readonly failures: readonly HookFailure[];
}

export function wrapHookChainResult<D>(result: {
  readonly decision?: D;
  readonly blocked?: unknown;
  readonly failures: readonly HookFailure[];
}): D {
  return { [hookChainResultMarker]: true, ...result } as D;
}

export function readHookChainResult(value: unknown): HookChainResult<unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const result = value as Partial<HookChainResult<unknown>>;
  return result[hookChainResultMarker] === true ? result as HookChainResult<unknown> : undefined;
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== 'object' && typeof value !== 'function') return false;
  if (value === null) return false;
  return typeof (value as { readonly then?: unknown }).then === 'function';
}
