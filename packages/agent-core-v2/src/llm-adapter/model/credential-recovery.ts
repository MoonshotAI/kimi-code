import type { LlmCredentialProvider } from '#human/llm/requester/requester';

export async function runWithCredentialRecovery<T>(
  credentials: LlmCredentialProvider | undefined,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (signal?.aborted === true || credentials?.canRecover?.(error) !== true) throw error;
    credentials?.invalidate?.();
    return run();
  }
}

export async function* streamWithCredentialRecovery<T>(
  credentials: LlmCredentialProvider | undefined,
  stream: () => AsyncIterable<T>,
  signal?: AbortSignal,
): AsyncIterable<T> {
  let recovered = false;
  for (;;) {
    try {
      yield* stream();
      return;
    } catch (error) {
      if (recovered || signal?.aborted === true || credentials?.canRecover?.(error) !== true) {
        throw error;
      }
      recovered = true;
      credentials?.invalidate?.();
    }
  }
}
