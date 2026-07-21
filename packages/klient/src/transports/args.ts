/**
 * JSON has no `undefined`: an args tuple ending in optional parameters would
 * cross the wire as `null` and defeat server-side default parameters (and
 * `z.string().optional()`-style fields). Contracts only ever make trailing
 * args optional, so trimming the tail is sufficient.
 */
export function trimTrailingUndefined(args: readonly unknown[]): unknown[] {
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end -= 1;
  return end === args.length ? [...args] : args.slice(0, end);
}
