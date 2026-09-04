/**
 * Periodic managed-usage fetcher for the footer's quota progress bars.
 *
 * Calls the same platform endpoint as `/usage` and publishes the latest
 * snapshot into AppState so the footer can render the multi-line quota
 * progress bars (line 2+) and hand the rows to a custom status line command.
 *
 * Polling runs while the current model belongs to a managed provider (Kimi).
 * Failures keep the previous snapshot; switching to a non-managed provider
 * clears it; unchanged snapshots are not re-published. Model / model-list
 * changes are pushed in via `refreshNow()` instead of being discovered by a
 * fast tick, so the timer only ever runs at the fetch cadence.
 *
 * Concurrent fetches are coalesced by a monotonically-increasing `generation`
 * counter: each `refresh()` call captures the current generation before the
 * `await`, and only publishes its response if the counter has not moved. A
 * provider switch (`refreshNow()`) bumps the counter, which silently drops any
 * response still in flight from the previous provider — preventing stale
 * managed-usage data from leaking into a now non-managed state.
 */

import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { isManagedUsageProvider } from '../constant/kimi-tui';
import type { AppState, ManagedUsageSnapshot } from '../types';
import { usageRowLabel, usageRowResetHint, type ManagedUsageRow } from '../../utils/usage/usage-format';

const FETCH_INTERVAL_MS = 60_000;

export interface ManagedUsagePollerOptions {
  readonly harness: KimiHarness;
  readonly getState: () => AppState;
  /** `null` clears the published snapshot (non-managed provider selected). */
  readonly onUpdate: (snapshot: ManagedUsageSnapshot | null) => void;
}

export interface ManagedUsagePoller {
  /**
   * Force an immediate refresh, bypassing the fetch-interval throttle. Called
   * when the model or model list changes, so a provider switch shows up right
   away instead of waiting out the current interval. Concurrent with an in-flight
   * fetch: the in-flight response is discarded by the generation bump so the
   * new provider's data lands first.
   */
  refreshNow(): void;
  dispose(): void;
}

export function createManagedUsagePoller(
  options: ManagedUsagePollerOptions,
): ManagedUsagePoller {
  let lastFetchedAt = 0;
  let lastProviderKey: string | null = null;
  let lastPublishedJson = '';
  let disposed = false;
  let generation = 0;

  async function refresh(): Promise<void> {
    const state = options.getState();
    // The footer renders quota progress bars on line 2+ whenever managed-
    // usage data is available, and custom status line commands also
    // consume it — so we always poll for managed providers.

    const providerKey = state.availableModels[state.model]?.provider;
    if (!isManagedUsageProvider(providerKey)) {
      // Non-managed providers have no quota to show: drop any snapshot a
      // previous managed provider published, and forget the provider key so
      // switching back refetches immediately instead of waiting out the
      // fetch interval.
      lastProviderKey = null;
      // Bump the generation so any response still in flight from a prior
      // managed provider is discarded and cannot republish into this
      // non-managed state.
      generation++;
      if (lastPublishedJson !== '') {
        lastPublishedJson = '';
        options.onUpdate(null);
      }
      return;
    }

    const now = Date.now();
    if (providerKey === lastProviderKey && now - lastFetchedAt < FETCH_INTERVAL_MS) return;

    // Capture the generation at fetch start. Any later refresh() (interval
    // tick or refreshNow()) bumps this counter, which after the await tells
    // us our response belongs to a stale generation and must not publish.
    const myGeneration = ++generation;

    lastProviderKey = providerKey;
    try {
      const res = await options.harness.auth.getManagedUsage(providerKey);
      if (disposed || generation !== myGeneration) return;
      if (res.kind === 'error') return;

      const snapshot: ManagedUsageSnapshot = {
        summary: res.summary !== null && res.summary !== undefined ? toRow(res.summary) : null,
        limits: res.limits.map(toRow),
        fetchedAt: Date.now(),
      };

      // Dedupe on the quota content only — `fetchedAt` changes every fetch.
      const json = JSON.stringify({ summary: snapshot.summary, limits: snapshot.limits });
      if (json === lastPublishedJson) return;
      lastPublishedJson = json;
      options.onUpdate(snapshot);
    } catch {
      // Keep the previous snapshot on failure.
    } finally {
      if (generation === myGeneration) {
        // Throttle only on the winning generation so a superseded fetch
        // does not push the throttle forward and starve the new request.
        lastFetchedAt = Date.now();
      }
    }
  }

  void refresh();
  const timer = setInterval(() => {
    void refresh();
  }, FETCH_INTERVAL_MS);
  timer.unref?.();

  return {
    refreshNow: () => {
      if (disposed) return;
      lastFetchedAt = 0;
      void refresh();
    },
    dispose: () => {
      disposed = true;
      clearInterval(timer);
    },
  };
}

function toRow(row: ManagedUsageRow): ManagedUsageSnapshot['limits'][number] {
  return {
    label: usageRowLabel(row),
    used: row.used,
    limit: row.limit,
    resetHint: usageRowResetHint(row),
  };
}