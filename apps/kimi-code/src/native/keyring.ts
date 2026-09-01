/**
 * OS keychain backend registration for OAuth token storage.
 *
 * `@napi-rs/keyring` is an optional native dependency owned by this app (the
 * packages/ layer stays pure TypeScript and receives the binding through
 * `registerKeyringBackend`). In a SEA binary the require below is redirected
 * to the extracted native-asset cache by `installNativeModuleHook`; outside
 * SEA it resolves from node_modules. When the binding cannot be loaded we
 * warn and skip registration, and the OAuth toolkit keeps the plaintext-file
 * token store. Whether the keychain is actually used is decided per process
 * by the toolkit's `resolveTokenStorage` (the `credentials_store` config,
 * the `KIMI_DISABLE_KEYRING` kill switch, and a capability probe) —
 * registration here is unconditional.
 */

import { createRequire } from 'node:module';

import type {
  KeyringApi,
  KeyringEntry,
  KeyringStorageObserver,
} from '@moonshot-ai/kimi-code-oauth';
import { registerKeyringBackend } from '@moonshot-ai/kimi-code-oauth';
import { log } from '@moonshot-ai/kimi-code-sdk';
import { track } from '@moonshot-ai/kimi-telemetry';

/** The slice of the `@napi-rs/keyring` module shape the storage contract needs. */
interface NapiKeyringModule {
  Entry: new (service: string, account: string) => KeyringEntry;
  findCredentials: (service: string) => Array<{ account: string; password: string }>;
}

function adaptNapiKeyring(mod: NapiKeyringModule): KeyringApi {
  return {
    createEntry(service, account) {
      return new mod.Entry(service, account);
    },
    findAccounts(service) {
      return mod.findCredentials(service).map((credential) => credential.account);
    },
  };
}

const keyringObserver: KeyringStorageObserver = {
  onBackendSelected(backend, reason) {
    log.info('oauth token storage backend selected', { backend, reason });
    track('keyring_backend_selected', { backend, reason });
  },
  onKeyringDegraded(operation, message) {
    log.warn('oauth keyring backend degraded to file storage', { operation, message });
    track('keyring_degraded', { operation });
  },
  onMigrated(name) {
    log.info('oauth token migrated to the OS keychain', { name });
    track('keyring_token_migrated');
  },
};

export function installKeyringBackend(): void {
  let mod: NapiKeyringModule;
  try {
    const require = createRequire(import.meta.url);
    mod = require('@napi-rs/keyring') as NapiKeyringModule;
  } catch (error) {
    log.warn('@napi-rs/keyring native binding failed to load; oauth tokens stay in the file store', { error });
    return;
  }
  registerKeyringBackend(adaptNapiKeyring(mod), keyringObserver);
}
