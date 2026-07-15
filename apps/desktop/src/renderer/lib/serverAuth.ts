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
// The credential is held in memory and mirrored to localStorage for up to 7
// days so it survives tab close and browser restarts without becoming a
// permanent browser-profile secret. The token is already persisted server-side
// at <KIMI_CODE_HOME>/server.token and handed to the browser in the launch URL.
// `kimi server rotate-token` invalidates a stale copy, and the next 401 clears
// it here.

const STORAGE_KEY = 'kimi-web.server-credential';
const FRAGMENT_PARAM = 'token';
const CREDENTIAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredCredential {
  version: 1;
  credential: string;
  expiresAt: number;
}

let memory: StoredCredential | undefined;

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

function createStoredCredential(credential: string): StoredCredential {
  return {
    version: 1,
    credential,
    expiresAt: Date.now() + CREDENTIAL_TTL_MS,
  };
}

function encodeStoredCredential(stored: StoredCredential): string {
  return JSON.stringify(stored);
}

function decodeStoredCredential(raw: string): StoredCredential | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (
      record['version'] !== 1 ||
      typeof record['credential'] !== 'string' ||
      record['credential'].length === 0 ||
      typeof record['expiresAt'] !== 'number' ||
      !Number.isFinite(record['expiresAt'])
    ) {
      return undefined;
    }
    return {
      version: 1,
      credential: record['credential'],
      expiresAt: record['expiresAt'],
    };
  } catch {
    return undefined;
  }
}

function persistCredential(stored: StoredCredential): void {
  globalThis.localStorage?.setItem(
    STORAGE_KEY,
    encodeStoredCredential(stored),
  );
}

function loadStored(): StoredCredential | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const stored = decodeStoredCredential(raw);
      if (stored === undefined) {
        // Upgrade values written by the initial localStorage implementation,
        // before persisted credentials carried an expiry timestamp.
        const migrated = createStoredCredential(raw);
        let migrationRecorded = false;
        try {
          persistCredential(migrated);
          migrationRecorded = true;
        } catch {
          // If the expiring record cannot be written, remove the undated value
          // so a reload cannot grant it a fresh 7-day window again.
        }
        if (!migrationRecorded) {
          try {
            if (globalThis.localStorage?.getItem(STORAGE_KEY) === raw) {
              globalThis.localStorage?.removeItem(STORAGE_KEY);
            }
            migrationRecorded = true;
          } catch {
            // Neither persisting nor removing succeeded; do not use a value
            // whose lifetime cannot be bounded.
          }
        }
        try {
          globalThis.sessionStorage?.removeItem(STORAGE_KEY);
        } catch {
          // The local migration result above still determines whether it is safe.
        }
        return migrationRecorded ? migrated : undefined;
      }
      if (stored.expiresAt > Date.now()) return stored;
      // Do not revive an expired local credential from a leftover legacy
      // sessionStorage copy. Clear that tab-local copy first; if it cannot be
      // removed, keep the expired local record as a tombstone that prevents
      // the legacy value from receiving a new 7-day window on reload.
      globalThis.sessionStorage?.removeItem(STORAGE_KEY);
      if (globalThis.localStorage?.getItem(STORAGE_KEY) === raw) {
        globalThis.localStorage?.removeItem(STORAGE_KEY);
      }
      return undefined;
    }
    // One-time upgrade: older builds kept the credential in sessionStorage
    // (tab-scoped). Adopt it into localStorage so the update itself does not
    // force the re-entry this change is meant to eliminate.
    const legacy = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    if (legacy) {
      const migrated = createStoredCredential(legacy);
      let migrationRecorded = false;
      try {
        persistCredential(migrated);
        migrationRecorded = true;
      } catch {
        // Fall through and try to discard the undated session copy instead.
      }
      try {
        globalThis.sessionStorage?.removeItem(STORAGE_KEY);
        migrationRecorded = true;
      } catch {
        // If both operations fail, its lifetime cannot be bounded.
      }
      return migrationRecorded ? migrated : undefined;
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

/** Current unexpired credential, or undefined if none is available. */
export function getCredential(): string | undefined {
  if (memory === undefined) return undefined;
  if (memory.expiresAt <= Date.now()) {
    clearExpiredCredential(memory);
    return undefined;
  }
  return memory.credential;
}

function clearExpiredCredential(expired: StoredCredential): void {
  memory = undefined;
  try {
    // Keep the expired local record as a tombstone if the legacy session copy
    // cannot be cleared; otherwise a reload could migrate it into a fresh TTL.
    globalThis.sessionStorage?.removeItem(STORAGE_KEY);
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const stored = raw === null || raw === undefined
      ? undefined
      : decodeStoredCredential(raw);
    const matchesExpired = stored === undefined
      ? raw === expired.credential
      : stored.credential === expired.credential &&
        stored.expiresAt === expired.expiresAt;
    if (matchesExpired) {
      globalThis.localStorage?.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

/** Store a credential in memory and in localStorage for up to 7 days. */
export function setCredential(value: string): void {
  const stored = createStoredCredential(value);
  memory = stored;
  try {
    persistCredential(stored);
  } catch {
    // Storage may be unavailable (private mode) — memory still works.
  }
  try {
    // Drop any legacy sessionStorage copy so the two stores cannot diverge.
    // Best-effort even when localStorage is blocked — otherwise a stale
    // session-scoped value left behind gets re-migrated (and 401s) on the
    // next reload.
    globalThis.sessionStorage?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
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
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const stored = raw === null || raw === undefined
      ? undefined
      : decodeStoredCredential(raw);
    const persistedCredential = stored?.credential ?? raw;
    const matchesRejected = rejected !== undefined &&
      persistedCredential === rejected.credential;
    if (matchesRejected) {
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
