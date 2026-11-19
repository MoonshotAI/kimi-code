import { isDaemonApiError } from '@moonshot-ai/app-core/api';
import { AUTH_MODEL_NOT_RESOLVED_CODE, type ChatGateVerdict } from '../lib/chatGate';
import { t } from './deps';
import { notifySessionOccupied, notifySessionStale } from './sessionOccupancy';

export interface SendFailureNotifierDeps {
  pushOperationFailure: (
    operation: string,
    err: unknown,
    opts?: { title?: string; message?: string; sessionId?: string },
  ) => void;
  mapSendAuthFailure?: (err: unknown, sid?: string) => Promise<ChatGateVerdict | null>;
}

export class PromptFailedError extends Error {
  constructor(readonly promptId: string) {
    super(`prompt ${promptId} failed before its turn started`);
    this.name = 'PromptFailedError';
  }
}

function isDefaultModelMissing(err: unknown): boolean {
  if (!isDaemonApiError(err) || err.code !== AUTH_MODEL_NOT_RESOLVED_CODE) return false;
  const details: unknown = err.details;
  if (details === null || typeof details !== 'object') return true;
  return typeof (details as { model_id?: unknown }).model_id !== 'string';
}

function failureCopy(err: unknown): { title?: string; message?: string } {
  if (isDefaultModelMissing(err)) {
    return { title: t('warnings.sendFailedTitle'), message: t('warnings.sendFailedNoDefaultModelMessage') };
  }
  if (err instanceof PromptFailedError) {
    return { title: t('warnings.sendFailedTitle'), message: t('warnings.promptFailedMessage') };
  }
  return {};
}

export function createSendFailureNotifier(
  deps: SendFailureNotifierDeps,
): (operation: string, err: unknown, sid: string) => void {
  return (operation, err, sid) => {
    if (notifySessionOccupied(err)) return;
    if (notifySessionStale(err, 'send')) return;
    deps.pushOperationFailure(operation, err, { sessionId: sid, ...failureCopy(err) });
    if (deps.mapSendAuthFailure !== undefined) void deps.mapSendAuthFailure(err, sid);
  };
}
