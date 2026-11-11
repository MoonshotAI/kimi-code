import type { LlmPolicy } from './policy';
import type { LlmRecovery } from './recovery';
import type { LlmResolver } from './resolver';
import type { LlmRetryable } from './retry';

export interface PolicyRegistry {
  addResolver(resolver: LlmResolver): () => void;
  addRecovery(recovery: LlmRecovery): () => void;
  addRetryable(retryable: LlmRetryable): () => void;
  readonly resolvers: readonly LlmResolver[];
  readonly recoveries: readonly LlmRecovery[];
  readonly retryables: readonly LlmRetryable[];
  asPolicy(): LlmPolicy;
}

export function createPolicyRegistry(): PolicyRegistry {
  const resolvers: LlmResolver[] = [];
  const recoveries: LlmRecovery[] = [];
  const retryables: LlmRetryable[] = [];
  const remove = <T>(list: T[], value: T): void => {
    const index = list.indexOf(value);
    if (index >= 0) list.splice(index, 1);
  };
  const policy: LlmPolicy = {
    resolvers: () => [...resolvers],
    recoveries: () => [...recoveries],
    retryables: () => [...retryables],
  };
  return {
    addResolver: (resolver) => {
      resolvers.push(resolver);
      return () => {
        remove(resolvers, resolver);
      };
    },
    addRecovery: (recovery) => {
      recoveries.push(recovery);
      return () => {
        remove(recoveries, recovery);
      };
    },
    addRetryable: (retryable) => {
      retryables.push(retryable);
      return () => {
        remove(retryables, retryable);
      };
    },
    get resolvers() {
      return [...resolvers];
    },
    get recoveries() {
      return [...recoveries];
    },
    get retryables() {
      return [...retryables];
    },
    asPolicy: () => policy,
  };
}
