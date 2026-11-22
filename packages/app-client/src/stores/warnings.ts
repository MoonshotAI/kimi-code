import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { AppNotice, AppNoticeDetail, AppWarning, ReadRequestOptions } from '@moonshot-ai/app-core/api';
import { isDaemonApiError, isDaemonNetworkError, isDaemonTimeoutError } from '@moonshot-ai/app-core/api';
import {
  errorInfo,
  errorStack,
  formatDetailValue,
  formatDuration,
  formatTimestamp,
} from '@moonshot-ai/app-core/client';
import { logError } from '@moonshot-ai/app-core/lib';
import { getKimiWebApi, t, traceKeyEvent } from '../client/deps';
import { sessionConflictErrorMessage } from '../lib/sessionConflictErrors';
import { clientPinia } from './pinia';
import { connectionStore } from './connection';
import { sessionsStore } from './sessions';

export function warningKey(warning: AppNotice): string {
  return `notice:${warning.severity}:${warning.title}:${warning.message ?? ''}:${JSON.stringify(warning.details ?? [])}:${JSON.stringify(warning.copyLink ?? null)}`;
}

function isErrorWarningText(warning: string): boolean {
  return warning.startsWith(`${t('warnings.errorLabel')}:`) || /\b4\d\d\b|error|失败|failed/i.test(warning);
}

function normalizeWarning(warning: AppWarning): AppNotice {
  if (typeof warning === 'string') {
    return {
      severity: isErrorWarningText(warning) ? 'error' : 'warning',
      title: warning,
      position: 'bottom-right',
    };
  }
  return { ...warning, position: warning.position ?? 'bottom-right' };
}

export function warningDetail(labelKey: string, value: unknown): AppNoticeDetail | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return { label: t(`warnings.details.${labelKey}`), value: formatDetailValue(value) };
}

function errorDetails(operation: string, err: unknown, sessionId?: string): AppNoticeDetail[] {
  const network = isDaemonNetworkError(err);
  const api = isDaemonApiError(err);
  const timestamp = network || api ? err.timestamp : undefined;
  const durationMs = network || api ? err.durationMs : undefined;

  const details: Array<AppNoticeDetail | undefined> = [
    warningDetail('operation', operation),
    warningDetail('sessionId', sessionId ?? sessionsStore().activeSessionId),
    warningDetail('connection', connectionStore().connection),
    warningDetail('timestamp', formatTimestamp(timestamp ?? Date.now())),
  ];

  if (network) {
    details.push(
      warningDetail('duration', formatDuration(durationMs)),
      warningDetail('request', `${err.method} ${err.path}`),
      warningDetail('endpoint', err.url),
      warningDetail('requestId', err.requestId),
      warningDetail('phase', err.phase),
      warningDetail('timeout', `${err.timeoutMs}ms`),
      warningDetail('status', err.status === undefined ? undefined : `${err.status} ${err.statusText ?? ''}`.trim()),
      warningDetail('contentType', err.contentType),
      warningDetail('responsePreview', err.bodyPreview),
      warningDetail('cause', err.cause),
    );
  } else if (api) {
    details.push(
      warningDetail('duration', formatDuration(durationMs)),
      warningDetail('code', err.code),
      warningDetail('requestId', err.requestId),
      warningDetail('message', err.message),
      warningDetail('details', err.details),
    );
  } else {
    const info = errorInfo(err);
    details.push(
      warningDetail('errorName', info.name),
      warningDetail('message', info.message ?? formatDetailValue(err)),
      warningDetail('stack', errorStack(err)),
    );
  }

  return details.filter((detail): detail is AppNoticeDetail => detail !== undefined);
}

export function operationFailureNotice(
  operation: string,
  err: unknown,
  opts: { title?: string; message?: string; sessionId?: string } = {},
): AppNotice {
  const network = isDaemonNetworkError(err);
  const api = isDaemonApiError(err);
  const timeout = isDaemonTimeoutError(err);
  const title =
    opts.title ??
    (network
      ? timeout
        ? t('warnings.daemonTimeoutTitle')
        : t('warnings.daemonNetworkTitle')
      : api
        ? t('warnings.daemonApiTitle')
        : t('warnings.operationFailedTitle'));
  const message =
    opts.message ??
    (network
      ? timeout
        ? t('warnings.daemonTimeoutMessage')
        : t('warnings.daemonNetworkMessage')
      : api
        ? (sessionConflictErrorMessage(err) ?? err.message)
        : t('warnings.operationFailedMessage'));
  return {
    severity: 'error',
    title,
    message,
    details: errorDetails(operation, err, opts.sessionId),
  };
}

export const useWarningsStore = defineStore('kimi.warnings', () => {
  const warnings = ref<AppNotice[]>([]);
  const shownSessionWarningKeys = new Map<string, Set<string>>();

  function refreshSessionWarnings(sessionId: string, options?: ReadRequestOptions): void {
    if (options?.signal?.aborted) return;
    const api = getKimiWebApi();
    void (options === undefined
      ? api.getSessionWarnings(sessionId)
      : api.getSessionWarnings(sessionId, options))
      .then((list) => {
        if (options?.signal?.aborted || !sessionsStore().sessions.some((s) => s.id === sessionId)) return;
        const shown = shownSessionWarningKeys.get(sessionId) ?? new Set<string>();
        shownSessionWarningKeys.set(sessionId, shown);
        const label = t('warnings.noteLabel');
        for (const warning of list) {
          const key = `${warning.code} ${warning.message}`;
          if (shown.has(key)) continue;
          shown.add(key);
          pushWarning({ severity: warning.severity, title: `${label}: ${warning.message}` });
        }
      })
      .catch(() => {
      });
  }

  function markSessionWarningShown(sessionId: string, key: string): void {
    const shown = shownSessionWarningKeys.get(sessionId) ?? new Set<string>();
    shown.add(key);
    shownSessionWarningKeys.set(sessionId, shown);
  }

  function forgetSessionWarnings(sessionId: string): void {
    shownSessionWarningKeys.delete(sessionId);
  }

  function setWarnings(next: AppWarning[]): void {
    warnings.value = next.map(normalizeWarning);
  }

  function pushWarning(warning: AppWarning): void {
    warnings.value = [...warnings.value, normalizeWarning(warning)];
  }

  function dismissWarning(target: AppNotice): void {
    const idx = warnings.value.findIndex((warning) => warning === target);
    if (idx === -1) return;
    const list = [...warnings.value];
    list.splice(idx, 1);
    warnings.value = list;
  }

  function dismissWsError(): void {
    const title = t('warnings.wsTitle');
    const next = warnings.value.filter(
      (w) => !(typeof w === 'object' && w !== null && w.severity === 'error' && w.title === title),
    );
    if (next.length !== warnings.value.length) {
      warnings.value = next;
    }
  }

  function pushOperationFailure(
    operation: string,
    err: unknown,
    opts?: { title?: string; message?: string; sessionId?: string },
  ): void {
    logError(`[kimi-code] operation failed: ${operation}`, err);
    const api = isDaemonApiError(err);
    const network = isDaemonNetworkError(err);
    traceKeyEvent('operation:failed', {
      sessionId: opts?.sessionId,
      status: 'failed',
      operation,
      errorName: err instanceof Error ? err.name : typeof err,
      errorCode: api ? err.code : undefined,
      requestId: api || network ? err.requestId : undefined,
      phase: network ? err.phase : undefined,
      httpStatus: network ? err.status : undefined,
    });
    pushWarning(operationFailureNotice(operation, err, opts));
  }

  function resetWarnings(): void {
    warnings.value = [];
  }

  return {
    warnings,
    refreshSessionWarnings,
    markSessionWarningShown,
    forgetSessionWarnings,
    setWarnings,
    pushWarning,
    dismissWarning,
    dismissWsError,
    pushOperationFailure,
    resetWarnings,
  };
});

export function warningsStore() {
  return useWarningsStore(clientPinia);
}
