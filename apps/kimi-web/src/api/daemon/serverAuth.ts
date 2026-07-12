// apps/kimi-web/src/api/daemon/serverAuth.ts
// Minimal server-transport credential store for the Web UI.
//
// The local server now requires a bearer credential on every non-bypass API
// and WebSocket call (the persistent server token, or the KIMI_CODE_PASSWORD
// password). The Web UI obtains that credential in one of two ways:
//   1. From the URL fragment (`#token=<...>`) that `kimi web` appends when it
//      opens the browser — read once at boot, then scrubbed from the URL so it
//      does not linger in history or screenshots.
//   2. From a token the user types into the ServerAuthDialog modal.
//
// The credential is held in memory and mirrored to localStorage so it survives
// tab close and browser restarts — entering it once per device is enough. The
// token is already persisted server-side at <KIMI_CODE_HOME>/server.token and
// handed to the browser in the launch URL, so keeping it in the browser profile
// does not materially widen exposure for this local tool. `kimi server
// rotate-token` invalidates a stale copy, and the next 401 clears it here.

const STORAGE_KEY = 'kimi-web.server-credential';
const FRAGMENT_PARAM = 'token';

let memory: string | undefined;

type AuthRequiredListener = () => void;
const listeners = new Set<AuthRequiredListener>();

function readFragmentToken(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const hash = window.location.hash ?? '';
  if (!hash.startsWith('#')) return undefined;
  const params = new URLSearchParams(hash.slice(1));
  const token = params.get(FRAGMENT_PARAM);
  if (!token) return undefined;
  // Scrub the fragment (keep path + query) so the token is not left in the
  // address bar, browser history, or any screenshot of the window.
  const url = new URL(window.location.href);
  url.hash = '';
  window.history.replaceState(
    window.history.state,
    '',
    `${url.pathname}${url.search}`,
  );
  return token;
}

function loadStored(): string | undefined {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (stored) return stored;
    // One-time upgrade: older builds kept the credential in sessionStorage
    // (tab-scoped). Adopt it into localStorage so the update itself does not
    // force the re-entry this change is meant to eliminate.
    const legacy = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    if (legacy) {
      globalThis.localStorage?.setItem(STORAGE_KEY, legacy);
      globalThis.sessionStorage?.removeItem(STORAGE_KEY);
      return legacy;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Initialize the credential store. Call once at app boot (before the first
 * API/WS call). Prefers a fragment token over a stored one. Returns true if a
 * credential is available afterwards (so the caller can skip the modal).
 */
export function initServerAuth(): boolean {
  const fragment = readFragmentToken();
  if (fragment) {
    setCredential(fragment);
    return true;
  }
  memory = loadStored();
  return memory !== undefined;
}

/** Current credential, or undefined if none has been provided yet. */
export function getCredential(): string | undefined {
  return memory;
}

/** Store a credential (memory + localStorage) for subsequent requests. */
export function setCredential(value: string): void {
  memory = value;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, value);
    // Drop any legacy sessionStorage copy so the two stores cannot diverge.
    globalThis.sessionStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Storage may be unavailable (private mode) — memory still works.
  }
}

/** Drop the credential (memory + localStorage). */
export function clearCredential(): void {
  const rejected = memory;
  memory = undefined;
  try {
    // Only clear the persisted copy when it still holds the credential this
    // tab was using. localStorage is shared across tabs, so an unconditional
    // removal would let a stale tab erase a newer token another tab stored
    // (e.g. right after `kimi server rotate-token`).
    if (
      rejected !== undefined &&
      globalThis.localStorage?.getItem(STORAGE_KEY) === rejected
    ) {
      globalThis.localStorage?.removeItem(STORAGE_KEY);
    }
    // sessionStorage is tab-scoped (legacy store) — clearing it cannot
    // affect other tabs.
    globalThis.sessionStorage?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Register a listener invoked when the server rejects our credential (HTTP 401
 * / envelope code 40101). Returns an unsubscribe function.
 */
export function onAuthRequired(listener: AuthRequiredListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Called by the HTTP/WS transport when the server rejects the current
 * credential. Clears it and notifies listeners (the App shows the modal).
 */
export function markAuthRequired(): void {
  clearCredential();
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // a failing listener must not break transport handling
    }
  }
}
