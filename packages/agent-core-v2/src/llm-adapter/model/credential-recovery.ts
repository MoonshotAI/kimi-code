import type { LlmCredentialProvider } from '#human/llm/requester/requester';

export async function runWithCredentialRecovery<T>(
  credentialProvider: LlmCredentialProvider | undefined,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (signal?.aborted === true || credentialProvider?.canRecover?.(error) !== true) throw error;
    credentialProvider?.invalidate?.();
    return run();
  }
}

export async function* streamWithCredentialRecovery<T>(
  credentialProvider: LlmCredentialProvider | undefined,
  stream: () => AsyncIterable<T>,
  signal?: AbortSignal,
): AsyncIterable<T> {
  let recovered = false;
  for (;;) {
    try {
      yield* stream();
      return;
    } catch (error) {
      if (recovered || signal?.aborted === true || credentialProvider?.canRecover?.(error) !== true) {
        throw error;
      }
      recovered = true;
      credentialProvider?.invalidate?.();
    }
  }
}
