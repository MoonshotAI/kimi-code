/**
 * `provider` domain (L2) — in-memory `IProviderService` test double.
 *
 * Stores provider configuration by name for App-scope consumer tests.
 */

import { IProviderService, type ProviderConfig } from '#/kosong/provider/provider';

export function stubProviderService(
  providers: Readonly<Record<string, ProviderConfig>> = {},
  ready: Promise<void> = Promise.resolve(),
): IProviderService {
  return {
    _serviceBrand: undefined,
    ready,
    onDidChangeProviders: () => ({ dispose: () => {} }),
    get: (name: string) => providers[name],
    list: () => providers,
    set: async () => {},
    delete: async () => {},
  };
}
