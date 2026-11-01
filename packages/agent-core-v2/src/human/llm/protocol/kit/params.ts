import { assign, shake } from 'radashi';

export function withExtras<TParams extends object>(
  params: TParams,
  extras: object | undefined,
): TParams {
  return shake(
    assign(params as Record<string, unknown>, (extras ?? {}) as Record<string, unknown>),
  ) as TParams;
}
