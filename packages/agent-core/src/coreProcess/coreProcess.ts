/**
 * `CoreProcessService` — the in-process RPC adapter owned by the services
 * package. Internally:
 *
 *   1. `createRPC<CoreAPI, SDKAPI>()` produces a `[coreRpc, sdkRpc]` pair of
 *      `RPCClient` functions (packages/agent-core/src/rpc/client.ts:31-103).
 *   2. `new KimiCore(coreRpc, options)` — the core is constructed with the
 *      core-side RPC client (it calls into the SDK side over `coreRpc`).
 *   3. `sdkRpc(new BridgeClientAPI({ ... }))` — the SDK side of the pair is
 *      satisfied by a `BridgeClientAPI` instance whose `SDKAPI` methods route
 *      to DI-resolved peer services. Returns `Promise<RPCMethods<CoreAPI>>` —
 *      the core RPC methods that downstream services (`SessionService`,
 *      `PromptService`, …) dispatch on through the proxy below.
 *
 * The result is wrapped in a small `SDKRpcClient`-shaped proxy so that
 * service impls get SDK-style RPC ergonomics. The proxy is exposed as `rpc` for in-package
 * consumers; the public package barrel does NOT re-export `SDKRpcClientBase`,
 * so daemon-side code stays one abstraction layer away.
 *
 * Facade:
 *   - `ICoreRuntime` is the public runtime facade: `rpc`, `ready()`,
 *     `dispose()`, and `getCoreApi()` (in-process wire-controller access).
 *     Consumers inject `@ICoreRuntime`.
 *
 * DI token:
 *   - The decorator string remains `'coreProcessService'` for now (renaming it
 *     to `'coreRuntime'` is deferred — see M7.1 STATUS). The deprecated
 *     process-service alias was removed in M7.1; `ICoreRuntime` is now the
 *     sole identifier and resolves against that unchanged string token.
 *
 * Lifecycle:
 *   - `ready()` resolves when both the `KimiCore` plugin/config load AND the
 *     SDK-side RPC binding have settled. Construction is eager (Singleton
 *     pattern); awaiting `ready()` is the safe gate before issuing RPC calls.
 *   - `dispose()` is idempotent. It flips an internal flag so future `rpc`
 *     method dispatch throws before reaching `KimiCore`, then walks the
 *     `Disposable` child stack. `KimiCore` itself has no `dispose()` today —
 *     tearing down its `SessionHost` instances is async (`SessionHost.close()`)
 *     and cannot be awaited from this synchronous `dispose()` contract, so
 *     core tear-down is deferred (see M6.3 notes); the adapter-level dispose
 *     still short-circuits `rpc.*` / `getCoreApi()` post-dispose.
 *
 * Role: cross-process adapter — see `packages/services/AGENTS.md`.
 */

import { createDecorator } from '#/_base/di';
import type { CoreRPC, KimiCoreOptions } from '../rpc';
import { type KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';

export interface CoreProcessServiceOptions extends KimiCoreOptions {
  /**
   * Host identity (product name + version). When set and
   * `kimiRequestHeaders` is omitted, the adapter default-wires
   * `createKimiDefaultHeaders({ homeDir, ...identity })` into KimiCore so
   * upstream sees `User-Agent: <product>/<version>` + `X-Msh-Platform: …`.
   * Without this, the managed Kimi-for-Coding endpoint rejects requests
   * with 40340 ("only available for Coding Agents") because the default
   * fetch User-Agent doesn't match any known coding-agent product.
   *
   * `identity.version` also feeds `appVersion` so session records carry
   * the host CLI version — same wiring `SDKRpcClient` does in node-sdk.
   *
   * Callers can still pass explicit `kimiRequestHeaders` (or `appVersion`)
   * to override; the explicit values win.
   */
  readonly identity?: KimiHostIdentity;
}

export interface ICoreRuntime {
  readonly _serviceBrand: undefined;

  /** The core RPC methods. Service impls call e.g. `core.rpc.createSession(...)`. */
  readonly rpc: CoreRPC;

  /**
   * Resolves once `KimiCore` is fully constructed and the SDK side of the
   * in-process RPC has been bound. Repeated calls return the cached promise.
   */
  ready(): Promise<void>;

  /**
   * Tear down the adapter. After dispose, `rpc.<method>(...)` rejects with a
   * "core process disposed" error before reaching `KimiCore`, and
   * `getCoreApi()` throws. Idempotent.
   */
  dispose(): void;

  /**
   * In-process (zero-serialization) CoreAPI handle. Returns the underlying
   * `KimiCore` directly so in-package services (e.g. `PromptService`) can
   * route per-agent calls without crossing the `createRPC` JSON
   * serialize/deserialize boundary that backs the `rpc` proxy.
   *
   * Method signatures and return shapes are identical to `rpc`; the only
   * difference is the absence of the serialize hop. Throws after dispose,
   * mirroring the `rpc` proxy's post-dispose contract.
   */
  getCoreApi(): CoreRPC;
}

// The decorator string stays `'coreProcessService'` (rename deferred; see
// M7.1 STATUS). `createDecorator` keys identifiers by name, so this string is
// the canonical DI token every consumer resolves against.
// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ICoreRuntime = createDecorator<ICoreRuntime>('coreProcessService');
