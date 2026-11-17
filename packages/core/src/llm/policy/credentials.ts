import type { LlmRecovery } from '#/llm/policy/recovery';
import type { LlmCredentialProvider } from '#/llm/request';

export async function runWithCredentialRecovery<T>(
  credentialProvider: LlmCredentialProvider | undefined,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (signal?.aborted === true || credentialProvider?.canRecover?.(error) !== true) throw error;
    credentialProvider.invalidate?.();
    return run();
  }
}

export const credentialRecovery: LlmRecovery = {
  propose: ({ error, appliedRecoveries, endpoint }) => {
    const provider = endpoint?.credentials;
    if (
      provider?.canRecover?.(error) !== true ||
      appliedRecoveries.some((record) => record.strategy === 'credentials')
    ) {
      return undefined;
    }
    return {
      strategy: 'credentials',
      action: 'refresh',
      beforeNextAttempt: () => provider.invalidate?.(),
    };
  },
};
