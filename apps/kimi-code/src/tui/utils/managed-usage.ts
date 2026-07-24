/**
 * Shared managed-plan usage loader.
 *
 * Used by `/usage`, `/status`, and the footer quota segment. Returns
 * `undefined` when the active model is not on a managed provider (the
 * feature simply does not apply); fetch failures come back as `{ error }`
 * and are never thrown, so callers can silently keep stale data or hide.
 */

import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import type { ManagedUsageReport } from '../components/messages/usage-panel';
import { isManagedUsageProvider } from '../constant/kimi-tui';
import type { AppState } from '../types';
import { formatErrorMessage } from './event-payload';

export interface ManagedUsageFetchResult {
  readonly usage?: ManagedUsageReport;
  readonly error?: string;
}

export async function fetchManagedUsageReport(
  harness: KimiHarness,
  appState: AppState,
): Promise<ManagedUsageFetchResult | undefined> {
  const providerKey = appState.availableModels[appState.model]?.provider;
  if (!isManagedUsageProvider(providerKey)) return undefined;

  let res;
  try {
    res = await harness.auth.getManagedUsage(providerKey);
  } catch (error) {
    return { error: formatErrorMessage(error) };
  }
  if (res.kind === 'error') {
    return { error: res.message };
  }
  return { usage: { summary: res.summary, limits: res.limits, extraUsage: res.extraUsage } };
}
