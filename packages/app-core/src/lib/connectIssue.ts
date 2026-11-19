import { isDaemonApiError, isDaemonNetworkError, isDaemonTimeoutError } from '../api/errors';

export type ConnectIssueKind = 'network' | 'timeout' | 'api' | 'unknown';

export interface ConnectIssue {
  readonly kind: ConnectIssueKind;
  readonly message: string;
}

export function classifyConnectIssue(err: unknown): ConnectIssue {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 140);
  if (isDaemonTimeoutError(err)) return { kind: 'timeout', message };
  if (isDaemonNetworkError(err)) return { kind: 'network', message };
  if (isDaemonApiError(err)) return { kind: 'api', message };
  return { kind: 'unknown', message };
}
