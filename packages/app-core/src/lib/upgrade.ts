// packages/app-core/src/lib/upgrade.ts
// The single managed-account upgrade entry, shared by the sidebar user menu,
// the composer's no-usable-model pill, and the settings account tab. Free
// managed accounts (userinfo probe rejected with 402, see ManagedMembership)
// get this link in place of the plan-usage UI.

import { isDesktop } from './desktopFlag';
import type { OAuthRegion } from '../api/types';

// The upgrade landing page is region-dependent (kimi.com vs kimi.ai). The
// host app resolves the server region once at bootstrap (daemon client
// getOAuthRegion — fire-and-forget) and stores it here; until then the link
// stays on the historical .com host.
let cachedRegion: OAuthRegion | null = null;

/** Store the server-resolved region for the upgrade link. `null` (endpoint
    missing / request failed) keeps the previous value — initially 'mainland-cn'. */
export function setUpgradeRegion(region: OAuthRegion | null): void {
  if (region !== null) cachedRegion = region;
}

let refreshSeq = 0;

// The newest in-flight probe. A superseded resolve skips its own write but
// must not return while the cache is still pre-refresh — openUpgrade would
// navigate its placeholder with the old region. It awaits the newest probe
// instead, so every caller reads the fresh value.
let latestProbe: { seq: number; promise: Promise<void> } | null = null;

/** Probe the server region and store it. Concurrent triggers (mount, logout,
    a following login, rapid Upgrade clicks) race — only the newest probe may
    write the cache, and a superseded call defers to the newest outcome
    instead of resolving with the stale one. */
export async function resolveUpgradeRegion(probe: () => Promise<OAuthRegion | null>): Promise<void> {
  const seq = ++refreshSeq;
  const run = (async (): Promise<void> => {
    const region = await probe();
    if (seq === refreshSeq) setUpgradeRegion(region);
  })();
  const wrapped = (async (): Promise<void> => {
    await run;
    // A newer probe started while mine was in flight: defer to its full
    // outcome — the stored promise itself defers further when an even newer
    // probe exists, so a chain of overlapping calls lands on the true newest.
    if (latestProbe !== null && latestProbe.seq > seq) {
      await latestProbe.promise;
    }
  })();
  latestProbe = { seq, promise: wrapped };
  return wrapped;
}

let regionProbe: (() => Promise<OAuthRegion | null>) | null = null;

/** Register the host's region probe once (App bootstrap). openUpgrade runs it
    right before opening, so a just-changed login can never send the user to
    the stale region's site through any entry (menu, banner, pill, card). */
export function setUpgradeRegionProbe(probe: (() => Promise<OAuthRegion | null>) | null): void {
  regionProbe = probe;
}

// An interaction-level bound for the probe: a half-dead remote daemon (or a
// stuck local server) must not leave the placeholder blank until the API
// client's generic request timeout — the cached region opens instead.
const PROBE_TIMEOUT_MS = 5_000;

function probeWithTimeout(probe: () => Promise<OAuthRegion | null>): Promise<OAuthRegion | null> {
  return Promise.race([
    probe(),
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
    }),
  ]);
}

/** Upgrade landing page; the `from` param identifies the host app. */
export function getUpgradeUrl(): string {
  const siteBase = cachedRegion === 'global' ? 'https://www.kimi.ai' : 'https://www.kimi.com';
  return `${siteBase}/code?from=${isDesktop ? 'kimi_code_desktop' : 'kimi_code_web'}`;
}

export function openUpgrade(): void {
  const registered = regionProbe;
  if (registered === null) {
    window.open(getUpgradeUrl(), '_blank', 'noopener');
    return;
  }
  const probe = (): Promise<OAuthRegion | null> => probeWithTimeout(registered);
  // Desktop's openExternal needs no user gesture, so awaiting the probe is
  // fine there. Web must not window.open from a Promise callback (Safari
  // popup blocker) — open the placeholder synchronously inside the gesture
  // and navigate it once the fresh region resolves.
  if (isDesktop) {
    void resolveUpgradeRegion(probe).then(() => {
      window.open(getUpgradeUrl(), '_blank', 'noopener');
    });
    return;
  }
  const placeholder = window.open('', '_blank');
  if (placeholder === null) {
    // Already blocked: fall back to a direct open with the cached region.
    window.open(getUpgradeUrl(), '_blank', 'noopener');
    return;
  }
  // The placeholder is same-origin about:blank, so the opener can still be
  // severed here — the upgrade site must not get a handle on this window.
  try { placeholder.opener = null; } catch { /* best effort */ }
  void resolveUpgradeRegion(probe).then(() => {
    try {
      placeholder.location.href = getUpgradeUrl();
    } catch {
      // The user closed the placeholder — nothing to navigate.
    }
  });
}
