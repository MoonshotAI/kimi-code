import { DaemonApiError, DaemonNetworkError } from '@moonshot-ai/app-core/api';

export function networkError(): DaemonNetworkError {
  return new DaemonNetworkError({
    message: 'Network error calling PUT /sessions/s1/prompts/msg_network',
    cause: new TypeError('fetch failed'),
    method: 'PUT',
    path: '/sessions/s1/prompts/msg_network',
    url: 'http://127.0.0.1/api/v1/sessions/s1/prompts/msg_network',
    requestId: 'req-network',
    phase: 'fetch',
    timeoutMs: 60_000,
  });
}

export function promptIdConflict(): DaemonApiError {
  return new DaemonApiError({ code: 40927, msg: 'prompt_id is already in use', requestId: 'req-conflict' });
}
