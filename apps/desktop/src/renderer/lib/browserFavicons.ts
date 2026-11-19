import { shallowRef } from 'vue';
import type { BrowserFaviconSource } from '@moonshot-ai/app-components';

const REFRESH_INTERVAL_MS = 30_000;

interface FaviconRecord {
  url: string;
  favicon?: string;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

function digest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function browserFaviconSignature(tabs: readonly { id: string; favicon?: string }[]): string {
  return tabs.map((tab) => `${tab.id}:${tab.favicon === undefined ? '' : `${tab.favicon.length}:${digest(tab.favicon)}`}`).join(',');
}

export function createBrowserFaviconSource(
  load: () => Promise<{ history: readonly FaviconRecord[] }>,
  now: () => number = Date.now,
): BrowserFaviconSource & { reload(): void } {
  const byHost = shallowRef<ReadonlyMap<string, string>>(new Map());
  let pending = false;
  let queued = false;
  let loadedAt = Number.NEGATIVE_INFINITY;
  const run = (force: boolean) => {
    if (pending) {
      queued ||= force;
      return;
    }
    if (!force && now() - loadedAt < REFRESH_INTERVAL_MS) return;
    pending = true;
    void load().then((data) => {
      const next = new Map<string, string>();
      for (const entry of data.history) {
        const host = hostOf(entry.url);
        if (host !== undefined && entry.favicon && !next.has(host)) next.set(host, entry.favicon);
      }
      byHost.value = next;
      loadedAt = now();
    }).catch(() => undefined).finally(() => {
      pending = false;
      if (!queued) return;
      queued = false;
      run(true);
    });
  };
  return {
    refresh: () => run(false),
    reload: () => run(true),
    favicon(url) {
      const host = hostOf(url);
      return host === undefined ? undefined : byHost.value.get(host);
    },
  };
}
