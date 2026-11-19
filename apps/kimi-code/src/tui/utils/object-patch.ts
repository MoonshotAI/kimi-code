export function hasPatchChanges<T extends object>(target: T, patch: Partial<T>): boolean {
  for (const key of Object.keys(patch) as Array<keyof T>) {
    if (!Object.is(target[key], patch[key])) return true;
  }
  return false;
}
