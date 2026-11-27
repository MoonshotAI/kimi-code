import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CREDENTIAL_KEY = 'kimi-web.server-credential';

let store: Map<string, string>;

function stubStorage(): void {
  store = new Map<string, string>();
  const session = new Map<string, string>();
  const make = (backing: Map<string, string>) => ({
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
  });
  vi.stubGlobal('localStorage', make(store));
  vi.stubGlobal('sessionStorage', make(session));
}

async function importModules(): Promise<{
  auth: typeof import('@moonshot-ai/app-core/lib');
  embedded: typeof import('../../src/renderer/lib/embeddedServerAuth');
}> {
  vi.resetModules();
  const auth = await import('@moonshot-ai/app-core/lib');
  const embedded = await import('../../src/renderer/lib/embeddedServerAuth');
  return { auth, embedded };
}

function storeEnvelope(credential: string): void {
  store.set(
    CREDENTIAL_KEY,
    JSON.stringify({ version: 1, credential, expiresAt: Date.now() + 60_000 }),
  );
}

beforeEach(() => {
  stubStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('clearEmbeddedServerCredential', () => {
  it('drops a stale stored credential from a previous version on a fresh boot', async () => {
    const { auth, embedded } = await importModules();
    storeEnvelope('stale-server-token');

    expect(embedded.clearEmbeddedServerCredential('?kimi_desktop=1&kimi_embedded=1')).toBe(true);

    expect(store.has(CREDENTIAL_KEY)).toBe(false);
    expect(auth.getCredential()).toBeUndefined();
  });

  it('drops a legacy undated credential as well', async () => {
    const { auth, embedded } = await importModules();
    store.set(CREDENTIAL_KEY, 'legacy-raw-token');

    expect(embedded.clearEmbeddedServerCredential('?kimi_embedded=1')).toBe(true);

    expect(store.has(CREDENTIAL_KEY)).toBe(false);
    expect(auth.getCredential()).toBeUndefined();
  });

  it('drops a credential already loaded into memory', async () => {
    const { auth, embedded } = await importModules();
    auth.setCredential('stale-server-token');
    expect(store.has(CREDENTIAL_KEY)).toBe(true);

    expect(embedded.clearEmbeddedServerCredential('?kimi_embedded=1')).toBe(true);

    expect(auth.getCredential()).toBeUndefined();
    expect(store.has(CREDENTIAL_KEY)).toBe(false);
  });

  it('keeps the credential when the page was not loaded for the embedded server', async () => {
    const { embedded } = await importModules();
    storeEnvelope('external-server-token');

    expect(embedded.clearEmbeddedServerCredential('?kimi_desktop=1')).toBe(false);

    expect(store.has(CREDENTIAL_KEY)).toBe(true);
  });

  it('is a no-op when there is nothing stored', async () => {
    const { embedded } = await importModules();

    expect(embedded.clearEmbeddedServerCredential('?kimi_embedded=1')).toBe(true);
    expect(store.has(CREDENTIAL_KEY)).toBe(false);
  });
});
