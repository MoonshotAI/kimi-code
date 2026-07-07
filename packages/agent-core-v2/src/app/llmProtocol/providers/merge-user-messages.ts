export function mergeConsecutiveUserMessages<T>(
  messages: readonly T[],
  mergePolicy: {
    readonly isUser: (message: T) => boolean;
    readonly isToolResultOnly: (message: T) => boolean;
    readonly merge: (last: T, next: T) => T;
  },
): T[] {
  const out: T[] = [];
  for (const message of messages) {
    const lastIndex = out.length - 1;
    const last = lastIndex >= 0 ? out[lastIndex] : undefined;
    if (
      last !== undefined &&
      mergePolicy.isUser(last) &&
      mergePolicy.isUser(message) &&
      (mergePolicy.isToolResultOnly(last) || !mergePolicy.isToolResultOnly(message))
    ) {
      out[lastIndex] = mergePolicy.merge(last, message);
    } else {
      out.push(message);
    }
  }
  return out;
}
