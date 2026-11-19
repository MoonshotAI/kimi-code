import { DaemonApiError, DaemonNetworkError } from '@moonshot-ai/app-core/api';

export function networkError(): DaemonNetworkError {
  return new DaemonNetworkError({
    message: 'Network error calling POST /sessions/s1/prompts',
    cause: new TypeError('fetch failed'),
    method: 'POST',
    path: '/sessions/s1/prompts',
    url: 'http://127.0.0.1/api/v1/sessions/s1/prompts',
    requestId: 'req-network',
    phase: 'fetch',
    timeoutMs: 60_000,
  });
}

export function promptIdConflict(): DaemonApiError {
  return new DaemonApiError({ code: 40927, msg: 'prompt_id is already in use', requestId: 'req-conflict' });
}
