import {
  isSessionOccupiedError,
  isSessionStaleError,
  sessionOccupiedHolderClient,
  sessionOccupiedHolderDisplayName,
} from '@moonshot-ai/app-core/api';
import { isDesktop } from '@moonshot-ai/app-core/lib';
import { track } from '../contracts';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import { sessionsStore } from '../stores/sessions';
import { warningsStore } from '../stores/warnings';
import { getKimiWebApi, t } from './deps';

function openerClient(): 'web' | 'desktop' {
  return isDesktop ? 'desktop' : 'web';
}

function sessionOccupiedMessage(err: unknown): string {
  const client = sessionOccupiedHolderDisplayName(err);
  return client === undefined
    ? t('warnings.sessionOccupied.message')
    : t('warnings.sessionOccupied.messageWithClient', { client });
}

function pushSessionOccupiedWarning(err: unknown): void {
  warningsStore().pushWarning({
    severity: 'warning',
    title: t('warnings.sessionOccupied.title'),
    message: sessionOccupiedMessage(err),
  });
}

export async function confirmSessionOccupied(err: unknown, sessionId: string): Promise<boolean> {
  const dialog = useConfirmDialog();
  if (dialog.isConfirmOpen.value) {
    pushSessionOccupiedWarning(err);
    return false;
  }
  track('occupied_prompt_shown', {
    holder_client: sessionOccupiedHolderClient(err),
    opener_client: openerClient(),
  });
  const ok = await dialog.confirm({
    title: t('warnings.sessionOccupied.title'),
    message: sessionOccupiedMessage(err),
    confirmLabel: t('warnings.sessionOccupied.retry'),
    variant: 'primary',
  });
  track('occupied_choice', { choice: ok ? 'retry' : 'cancel' });
  return ok && sessionsStore().activeSessionId === sessionId;
}

async function confirmSessionTakeover(err: unknown, sessionId: string): Promise<boolean> {
  const dialog = useConfirmDialog();
  if (dialog.isConfirmOpen.value) {
    pushSessionOccupiedWarning(err);
    return false;
  }
  const ok = await dialog.confirm({
    title: t('warnings.sessionOccupied.stillTitle'),
    message: t('warnings.sessionOccupied.takeoverMessage'),
    confirmLabel: t('warnings.sessionOccupied.takeover'),
    variant: 'danger',
    initialFocus: 'cancel',
    action: () => getKimiWebApi().takeoverSessionLock(sessionId),
  });
  track('occupied_choice', { choice: ok ? 'takeover' : 'cancel' });
  return ok && sessionsStore().activeSessionId === sessionId;
}

export async function retryWhileOccupied<T>(
  sessionId: string,
  run: () => Promise<T>,
  onRetry?: () => void,
): Promise<T> {
  let retried = false;
  for (;;) {
    try {
      return await run();
    } catch (err) {
      if (!isSessionOccupiedError(err)) throw err;
      const confirmed = retried
        ? await confirmSessionTakeover(err, sessionId)
        : await confirmSessionOccupied(err, sessionId);
      if (!confirmed) throw err;
      retried = true;
      onRetry?.();
    }
  }
}

export function notifySessionOccupied(err: unknown): boolean {
  if (!isSessionOccupiedError(err)) return false;
  pushSessionOccupiedWarning(err);
  return true;
}

export function notifySessionStale(err: unknown, origin: 'send' | 'operation'): boolean {
  if (!isSessionStaleError(err)) return false;
  track('session_stale_shown', { opener_client: openerClient() });
  warningsStore().pushWarning({
    severity: 'warning',
    title: t('warnings.sessionStale.title'),
    message: t(
      origin === 'operation'
        ? 'warnings.sessionStale.retryMessage'
        : 'warnings.sessionStale.message',
    ),
  });
  return true;
}
