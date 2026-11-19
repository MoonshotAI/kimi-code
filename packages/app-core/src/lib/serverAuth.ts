
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
        const migrated = createStoredCredential(raw);
        let migrationRecorded = false;
        try {
          persistCredential(migrated);
          migrationRecorded = true;
        } catch {}
        if (!migrationRecorded) {
          try {
            if (globalThis.localStorage?.getItem(STORAGE_KEY) === raw) {
              globalThis.localStorage?.removeItem(STORAGE_KEY);
            }
            migrationRecorded = true;
          } catch {}
        }
        try {
          globalThis.sessionStorage?.removeItem(STORAGE_KEY);
        } catch {}
        return migrationRecorded ? migrated : undefined;
      }
      if (stored.expiresAt > Date.now()) return stored;
      globalThis.sessionStorage?.removeItem(STORAGE_KEY);
      if (globalThis.localStorage?.getItem(STORAGE_KEY) === raw) {
        globalThis.localStorage?.removeItem(STORAGE_KEY);
      }
      return undefined;
    }
    const legacy = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    if (legacy) {
      const migrated = createStoredCredential(legacy);
      let migrationRecorded = false;
      try {
        persistCredential(migrated);
        migrationRecorded = true;
      } catch {}
      try {
        globalThis.sessionStorage?.removeItem(STORAGE_KEY);
        migrationRecorded = true;
      } catch {}
      return migrationRecorded ? migrated : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function initServerAuth(): boolean {
  const fragment = readFragmentToken();
  if (fragment) {
    setCredential(fragment);
    return true;
  }
  memory = loadStored();
  return memory !== undefined;
}

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
  } catch {}
}

export function setCredential(value: string): void {
  const stored = createStoredCredential(value);
  memory = stored;
  try {
    persistCredential(stored);
  } catch {}
  try {
    globalThis.sessionStorage?.removeItem(STORAGE_KEY);
  } catch {}
}

export function clearCredential(): void {
  const rejected = memory;
  memory = undefined;
  try {
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
    globalThis.sessionStorage?.removeItem(STORAGE_KEY);
  } catch {}
}

export function onAuthRequired(listener: AuthRequiredListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function markAuthRequired(): void {
  clearCredential();
  for (const listener of listeners) {
    try {
      listener();
    } catch {}
  }
}
