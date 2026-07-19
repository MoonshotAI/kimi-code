/**
 * `kosong/model` domain (L2) — the pure-data `Model`, the auth-provider
 * contract, and the `IModelCatalog` interface.
 *
 * A `Model` is exactly the configuration-derived data the rest of v2 needs to
 * talk about one configured model: endpoint, auth closure, wire protocol,
 * wire-facing name, headers, capability matrix, and budget knobs. It is NOT
 * a request executor and carries no `with*` morphs — per-turn intent flows
 * through `LLMCallParams` on `ModelRequester.request(...)` instead (see
 * `modelRequester.ts`). Construction happens exactly once per config
 * generation, in `ModelCatalog` (`catalogService.ts`) — the only place that
 * assembles Models.
 *
 * `IModelCatalog` is the single lookup the edge layers consume, in one of
 * three shapes (see the refactor plan's appendix B):
 *   - want data    → `get(id)`          → the pure-data Model;
 *   - want requests → `getRequester(id)` → the ModelRequester;
 *   - want types/pure functions → import `kosong/contract/*` directly.
 * `findByName` is the reverse map for many-to-many name/alias routing.
 *
 * The catalog caches assembled Models by id and invalidates on the
 * model/provider/platform config-change events. Tests that mutate config
 * BEHIND the service's back (bypassing those events) must call
 * `ModelCatalog.notifyConfigChanged()` to drop the cache — see
 * `catalogService.ts`.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { ProviderRequestAuth } from '#/kosong/contract/provider';
import type { Protocol, ProtocolProviderOptions } from '#/kosong/protocol/protocol';

import type { ModelRequester } from './modelRequester';

/**
 * Resolves per-request wire credentials for one Model. Implementations backed
 * by OAuth set `canRefresh` and honor `force` to re-fetch a fresh token (the
 * requester replays a request once on a 401 after a forced refresh).
 */
export interface AuthProvider {
  readonly canRefresh?: boolean;

  getAuth(options?: { readonly force?: boolean }): Promise<ProviderRequestAuth | undefined>;
}

/** Static api-key credentials; never refreshes. */
export class StaticAuthProvider implements AuthProvider {
  readonly canRefresh = false;

  constructor(private readonly apiKey: string | undefined) {}
  async getAuth(): Promise<ProviderRequestAuth | undefined> {
    if (this.apiKey === undefined || this.apiKey.trim().length === 0) return undefined;
    return { apiKey: this.apiKey };
  }
}

/**
 * The configuration-derived data of one configured model. Pure data: every
 * field is settled at assembly time and the interface exposes no behavior
 * beyond the auth closure (itself part of the assembled data).
 */
export interface Model {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly protocol: Protocol;
  readonly baseUrl?: string;
  readonly headers: Readonly<Record<string, string>>;

  readonly capabilities: ModelCapability;
  readonly maxContextSize: number;
  readonly maxOutputSize?: number;
  readonly displayName?: string;
  readonly reasoningKey?: string;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly alwaysThinking: boolean;
  readonly providerType?: string;
  readonly providerName: string;

  readonly authProvider: AuthProvider;
  /** Construction knobs the wire bases understand (assembled from config). */
  readonly providerOptions?: ProtocolProviderOptions;
}

export interface IModelCatalog {
  readonly _serviceBrand: undefined;

  /** The primary path: resolve the globally-unique `[models.<id>]` id. */
  get(id: string): Model;
  /** The request path: the cached request executor for the same id. */
  getRequester(id: string): ModelRequester;
  /** Reverse map: every Model id whose `name`/`model`/`aliases` match. */
  findByName(name: string): readonly string[];
}

// The decorator name matches the deleted legacy `IModelResolver` contract
// (`createDecorator` caches by name): `IModelCatalog` is the drop-in
// replacement, and keeping the legacy name preserves the service identity
// every caller already resolves by.
export const IModelCatalog: ServiceIdentifier<IModelCatalog> =
  createDecorator<IModelCatalog>('modelResolver');
