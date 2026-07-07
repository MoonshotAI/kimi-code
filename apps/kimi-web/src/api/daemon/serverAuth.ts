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
// The credential is held in memory and mirrored to sessionStorage so a page
// refresh keeps working without re-prompting (sessionStorage is tab-scoped and
// cleared when the tab closes — we deliberately do NOT use localStorage, since
// the credential authenticates as the server).

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
    return globalThis.sessionStorage?.getItem(STORAGE_KEY) ?? undefined;
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

/** Store a credential (memory + sessionStorage) for subsequent requests. */
export function setCredential(value: string): void {
  memory = value;
  try {
    globalThis.sessionStorage?.setItem(STORAGE_KEY, value);
  } catch {
    // sessionStorage may be unavailable (private mode) — memory still works.
  }
}

/** Drop the credential (memory + sessionStorage). */
export function clearCredential(): void {
  memory = undefined;
  try {
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
