// Returns true when applying `patch` would change at least one own property.
// Used before UI refresh paths so repeated equivalent state patches are cheap.
export function hasPatchChanges<T extends object>(target: T, patch: Partial<T>): boolean {
  for (const key of Object.keys(patch) as Array<keyof T>) {
    if (!Object.is(target[key], patch[key])) return true;
  }
  return false;
}
