// packages/app-client/src/lib/oauthAutoOpen.ts
// Auto-open drivers for the OAuth device-flow verification page, plugged into
// useOAuthLoginFlow as the `autoOpen` option. One contract, two platforms:
//
// - web: the verification URL arrives asynchronously, well after the click
//   gesture, so a direct `window.open(url)` at that point would be popup
//   blocked. The driver opens an about:blank placeholder tab synchronously
//   inside the gesture and navigates it once the URL lands; a blocked (or
//   user-closed) placeholder makes `openUrl` return false, which the
//   composable surfaces as `autoOpenBlocked` so the UI can show a prominent
//   manual-open button.
// - desktop: no popup blocker behind the preload bridge — `openExternal` goes
//   straight to the system browser once the URL lands, so no placeholder is
//   needed and there is nothing to settle.

/** How the flow composable drives the platform's auto-open. */
export interface OAuthAutoOpenDriver {
  /** Runs synchronously at the start of every flow (re)start, still inside
      the user's click gesture — the web driver opens its placeholder tab
      here, before transient activation expires. */
  onGesture?(): void;
  /** Called on every flow arrival as soon as its verification URL is known.
      The drivers own idempotence: the web driver navigates its placeholder
      per URL (a same-URL re-arrival focuses the live tab instead of reloading
      it); the desktop driver opens the system browser once per flow id (a
      retry can re-issue the same id, and a second browser window is pure
      noise). Returns false — synchronously (popup blocked, tab closed, bridge
      missing) or as a promise resolving false (the desktop bridge call
      rejects asynchronously when no browser can take the URL) — when the URL
      could not be delivered, so the UI can surface a manual-open button. */
  openUrl(url: string, flowId: string): boolean | Promise<boolean>;
  /** The flow reached a terminal state. `ok` keeps a navigated tab (the auth
      completion page is worth showing); failure/cancel closes it, and `ok`
      still closes a placeholder that never got a URL (the already-
      authenticated fast path). `keepNavigated` on a failure keeps a tab that
      already navigated to the auth site (a poll hiccup must not interrupt an
      authorization the user may be mid-way through) while still cleaning up a
      blank placeholder. */
  settle(ok: boolean, opts?: { keepNavigated?: boolean }): void;
}

/** The minimal tab handle the web driver needs — injectable for tests. */
export interface AutoOpenTab {
  readonly closed: boolean;
  navigate(url: string): void;
  /** Bring the tab forward (same-URL re-arrival). Best effort — browsers may
      ignore it outside a user gesture. */
  focus(): void;
  close(): void;
}

// The verification URL comes from the daemon over the wire (an external
// server in desktop's remote mode is not necessarily trusted input), so only
// http(s) is ever handed to the browser — a `file:`/`javascript:`/custom-scheme
// payload must fall back to the manual buttons, not reach `openExternal`.
// Shared with the login components' manual-open buttons (the auto-open
// drivers are not the only path that can hand the URL to the browser).
export function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function defaultOpenTab(): AutoOpenTab | null {
  const win = window.open('', '_blank');
  if (!win) return null;
  // The placeholder is same-origin about:blank, so the opener can still be
  // severed here — the auth page must not get a handle on this window.
  try { win.opener = null; } catch { /* best effort */ }
  return {
    get closed() { return win.closed; },
    navigate(url) { win.location.href = url; },
    focus() { win.focus(); },
    close() { win.close(); },
  };
}

/** Web driver: placeholder-tab auto-open (see the file header). */
export function createWebOAuthAutoOpen(
  openTab: () => AutoOpenTab | null = defaultOpenTab,
): OAuthAutoOpenDriver {
  let tab: AutoOpenTab | null = null;
  let navigatedUrl: string | null = null;

  function closeTab(): void {
    if (tab) {
      try { tab.close(); } catch { /* best effort — a dead flow must not throw */ }
    }
    tab = null;
    navigatedUrl = null;
  }

  return {
    onGesture() {
      // A leftover tab from an unsettled attempt would linger — drop it first.
      closeTab();
      tab = openTab();
    },
    openUrl(url, _flowId) {
      // A URL that can never be delivered leaves a blank placeholder behind —
      // close it on the way out, or it lingers next to the manual fallback
      // for the rest of the flow.
      if (!isHttpUrl(url)) { closeTab(); return false; }
      if (!tab || tab.closed) { tab = null; navigatedUrl = null; return false; }
      if (navigatedUrl === url) {
        // The same flow's URL arrived again (a retry can re-issue the same
        // flow id, and with it the same link) — bring the live tab forward
        // instead of reloading an authorization the user may be mid-way
        // through. flowId is not needed on web: the URL already identifies
        // the flow (the device code is embedded).
        try { tab.focus(); } catch { /* best effort */ }
        return true;
      }
      try { tab.navigate(url); } catch { closeTab(); return false; }
      navigatedUrl = url;
      return true;
    },
    settle(ok, opts) {
      // Success keeps the navigated completion page. A failure with
      // `keepNavigated` (a poll hiccup — the auth site itself may still be
      // fine and the user mid-authorization) also keeps a navigated tab;
      // everything else closes it — a blank placeholder or a dead flow's page
      // is just litter.
      if (navigatedUrl !== null && (ok || opts?.keepNavigated === true)) {
        tab = null;
        navigatedUrl = null;
        return;
      }
      closeTab();
    },
  };
}

/** Subset of the preload `kimiDesktop` bridge this driver needs. Older desktop
    builds without `openExternal` probe as absent and degrade to the manual
    buttons on the waiting page. */
interface OpenExternalBridge {
  openExternal?: (url: string) => Promise<void>;
}

/** Desktop driver: hand the URL to the system browser through the preload
    bridge, once per flow id (a retry can re-issue the same id — the already
    opened browser page is still valid, so a repeat is skipped). `wrapUrl`
    attaches the desktop login-source marker (the component passes
    `withDesktopLoginSource`). No placeholder, nothing to settle.
    The bridge call resolves asynchronously, so delivery failure (no browser
    available, openExternal rejected) surfaces as a promise resolving false —
    the composable then flips the waiting page to the manual fallback, and the
    flow id is deliberately not latched so a later attempt retries. */
export function createDesktopOAuthAutoOpen(wrapUrl: (url: string) => string): OAuthAutoOpenDriver {
  let lastOpened: { flowId: string; result: Promise<boolean> } | null = null;
  return {
    openUrl(url, flowId) {
      if (lastOpened?.flowId === flowId) return lastOpened.result;
      const wrapped = wrapUrl(url);
      if (!isHttpUrl(wrapped)) return false;
      const bridge = (window as { kimiDesktop?: OpenExternalBridge }).kimiDesktop;
      if (!bridge?.openExternal) return false;
      let result: Promise<boolean>;
      try {
        result = bridge.openExternal(wrapped).then(
          () => true,
          () => false,
        );
      } catch {
        return false;
      }
      lastOpened = { flowId, result };
      // A failed open clears the latch — a later arrival for the same flow
      // (e.g. the flow re-issued on retry) must try the browser again.
      void result.then((ok) => {
        if (!ok && lastOpened?.flowId === flowId) lastOpened = null;
      });
      return result;
    },
    settle() { /* the system browser owns the tab — nothing to close */ },
  };
}
