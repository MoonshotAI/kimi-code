import {
  isSessionOccupiedError,
  isSessionStaleError,
  sessionOccupiedHolderDisplayName,
} from '@moonshot-ai/app-core/api';
import { t } from '../client/deps';

export function sessionOccupiedMessage(err: unknown): string {
  const client = sessionOccupiedHolderDisplayName(err);
  return client === undefined
    ? t('warnings.sessionOccupied.message')
    : t('warnings.sessionOccupied.messageWithClient', { client });
}

export function sessionConflictErrorMessage(err: unknown): string | undefined {
  if (isSessionOccupiedError(err)) return sessionOccupiedMessage(err);
  if (isSessionStaleError(err)) return t('warnings.sessionStale.retryMessage');
  return undefined;
}
