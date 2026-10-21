export function trimTrailingUndefined(args: readonly unknown[]): unknown[] {
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end -= 1;
  return end === args.length ? [...args] : args.slice(0, end);
}
