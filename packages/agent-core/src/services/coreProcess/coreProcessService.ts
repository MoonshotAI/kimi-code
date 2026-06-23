/**
 * `CoreProcessService` — implementation of `ICoreRuntime`.
 */

import { createRPC, KimiCore } from '../../rpc';
import { Disposable, IInstantiationService, registerSingleton, SyncDescriptor } from '../../_base/di';
import type { CoreAPI, CoreRPC, SDKAPI } from '../../rpc';
import type { OAuthTokenProviderResolver } from '../../session/provider-manager';
import {
  createKimiDefaultHeaders,
  type KimiHostIdentity,
} from '@moonshot-ai/kimi-code-oauth';

import { createManagedAuthFacade } from '../auth/managedAuth';
import { BridgeClientAPI } from './coreProcessClient';
import { IApprovalService } from '#/approval';
import { IEnvironmentService } from '../environment/environment';
import { IEventService } from '../event/event';
import { ILogService } from '../logger/logger';
import { IQuestionService } from '../question/question';
import { ICoreRuntime, type CoreProcessServiceOptions } from './coreProcess';

export class CoreProcessService extends Disposable implements ICoreRuntime {
  readonly _serviceBrand: undefined;

  /**
   * Service-facing RPC handle. This is a `Proxy` over the awaited
   * `RPCMethods<CoreAPI>` so callers don't have to await a promise themselves
   * — `core.rpc.createSession({...})` returns a `Promise<SessionSummary>`
   * directly. After dispose, the proxy rejects on every method invocation.
   */
  public readonly rpc: CoreRPC;

  /**
   * The in-process `KimiCore` instance. Kept private so daemon-side code can't
   * grab it and bypass the peer-service indirection.
   */
  private readonly _core: KimiCore;

  /**
   * Promise that resolves to the resolved RPC methods. The `rpc` proxy awaits
   * this on every dispatch (cheap — controlled-promise resolves synchronously
   * on the second call).
   */
  private readonly _coreRpcPromise: Promise<CoreRPC>;

  /**
   * Cached readiness signal. We treat "SDK-side RPC bound" as the readiness
   * marker today; once `KimiCore.pluginsReady` is publicly exposed we can
   * combine them here.
   */
  private readonly _ready: Promise<void>;

  constructor(
    options: CoreProcessServiceOptions,
    @IEnvironmentService env: IEnvironmentService,
    @IEventService eventService: IEventService,
    @IApprovalService approvalService: IApprovalService,
    @IQuestionService questionService: IQuestionService,
    @ILogService logService: ILogService,
    @IInstantiationService private readonly ix: IInstantiationService,
  ) {
    super();

    // 1. Build the in-process RPC pair. Left/Right are typed; `coreRpc` is the
    //    function KimiCore receives, `sdkRpc` is the one we satisfy.
    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();

    // 2. Construct the core. KimiCore's ctor wires itself into `coreRpc` and
    //    exposes `this.sdk: Promise<SDKRPC>` for the reverse direction.
    //
    //    The cross-cutting defaults (OAuth token resolver, Kimi request
    //    headers, identity-derived `appVersion`) are computed by the host
    //    bootstrap (`packages/server/src/start.ts`) and handed in via
    //    `options`. This adapter is intentionally thin: it forwards
    //    `options` through to KimiCore and only overrides `homeDir` /
    //    `configPath` from the resolved environment so the daemon's
    //    canonical paths win over any caller-supplied values, and injects
    //    the DI `instantiationService`. See `_defaultOAuthTokenResolver` /
    //    `_defaultKimiRequestHeaders` for the default-wiring logic the
    //    bootstrap now owns.
    this._core = new KimiCore(coreRpc, {
      ...options,
      homeDir: env.homeDir,
      configPath: env.configPath,
      instantiationService: this.ix,
    });

    // 3. Satisfy the SDK side with a BridgeClientAPI that routes to peer services.
    //    sdkRpc returns Promise<RPCMethods<CoreAPI>> — these are the methods
    //    in-package services will dispatch on.
    const clientApi = new BridgeClientAPI({
      eventService,
      approvalService,
      questionService,
      logService,
    });
    this._coreRpcPromise = sdkRpc(clientApi);

    // 4. Readiness is "the RPC pair is bound on both sides". Plugin load
    //    happens inside KimiCore's ctor and self-heals (the worker captures
    //    the error rather than surfacing it; see core-impl.ts:170-172).
    this._ready = this._coreRpcPromise.then(() => undefined);

    // 5. Build the dispatch proxy. Each method on the proxy awaits the resolved
    //    RPC methods then forwards. After dispose, dispatch rejects eagerly.
    this.rpc = this._buildRpcProxy();
  }

  async ready(): Promise<void> {
    return this._ready;
  }

  /**
   * In-process (zero-serialization) CoreAPI handle. Returns the underlying
   * `KimiCore` directly so in-package services (e.g. `PromptService`) can
   * route per-agent calls without crossing the `createRPC` JSON
   * serialize/deserialize boundary that backs the `rpc` proxy (see
   * `simulateNetwork` in `src/rpc/client.ts`).
   *
   * Method signatures and return shapes are identical to `rpc`; the only
   * difference is the absence of the serialize hop and the
   * controlled-promise dispatch. Throws after dispose, mirroring the `rpc`
   * proxy's post-dispose contract.
   *
   * Advertised on the `ICoreRuntime` facade (promoted from a concrete-only
   * seam in M6.3) so the in-process, serialization-free path is part of the
   * runtime contract rather than a localized cast.
   */
  getCoreApi(): CoreRPC {
    if (this._store.isDisposed) {
      throw new Error('CoreProcessService has been disposed');
    }
    // `KimiCore` implements `PromisableMethods<CoreAPI>`; `CoreRPC` is the
    // promisified `RPCMethods<CoreAPI>` (adds an optional `options` param).
    // At runtime the KimiCore methods satisfy the `CoreRPC` contract — they
    // accept the payload, ignore the extra options arg, and return promises
    // — so the cast is a type-level accommodation only.
    return this._core as unknown as CoreRPC;
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    // KimiCore does not currently expose a dispose(), and its session
    // tear-down (`SessionHost.close()`) is async — it disposes agents, stops
    // crons, cancels active turns (with a timeout), shuts down MCP, and
    // closes log sinks — which cannot be awaited from this synchronous
    // `IDisposable`-style contract. Bridging it with fire-and-forget would
    // risk unhandled rejections and partial teardown, so core tear-down is
    // deferred (M6.3). Disposing the service flips `_disposed`, which makes
    // future `rpc.*` invocations and `getCoreApi()` reject/throw before they
    // reach KimiCore, then walks the Disposable child stack.
    super.dispose();
  }

  private _buildRpcProxy(): CoreRPC {
    const rpcPromise = this._coreRpcPromise;
    const isDisposedRef = () => this._store.isDisposed;

    // We don't know the concrete method set at compile time here (CoreAPI is
    // a structural interface; `RPCMethods<CoreAPI>` is a mapped type).
    // The Proxy lets us intercept every property access and return a function
    // that awaits the underlying RPC and forwards.
    return new Proxy({} as CoreRPC, {
      get(_target, prop) {
        // Symbols / well-known properties (Symbol.toPrimitive, then-able
        // probe, etc.) should not be RPC-dispatched.
        if (typeof prop !== 'string') return undefined;
        // Returning a function keeps `typeof rpc.foo === 'function'` true,
        // which downstream code may probe.
        return (...args: unknown[]) => {
          if (isDisposedRef()) {
            return Promise.reject(new Error('CoreProcessService has been disposed'));
          }
          return rpcPromise.then((methods) => {
            const fn = (methods as unknown as Record<string, unknown>)[prop];
            if (typeof fn !== 'function') {
              return Promise.reject(
                new Error(`CoreProcessService.rpc.${prop} is not a function`),
              );
            }
            return (fn as (...args: unknown[]) => unknown)(...args);
          });
        };
      },
    });
  }

  /**
   * Build the default `resolveOAuthTokenProvider` from the same home + config
   * paths KimiCore resolves internally. Mirrors `SDKRpcClient`'s default in
   * `packages/node-sdk/src/sdk-rpc-client.ts` so the daemon and the SDK
   * runtimes share OAuth credentials when both run against the same
   * `~/.kimi-code`.
   *
   * Exposed as `static` so tests can assert the wiring without exercising the
   * full agent-core turn loop.
   */
  static _defaultOAuthTokenResolver(
    homeDir: string,
    configPath: string,
  ): OAuthTokenProviderResolver {
    const facade = createManagedAuthFacade({ homeDir, configPath });
    return facade.resolveOAuthTokenProvider;
  }

  /**
   * Build the default `kimiRequestHeaders` from `options.identity` so the
   * outbound `User-Agent` + device-identity headers identify this process
   * as a real Coding Agent host (e.g. `kimi-code-cli/<ver>`). Without
   * these, the managed Kimi-for-Coding endpoint rejects with 40340.
   *
   * Returns `undefined` when no identity is provided — preserves the
   * pre-fix contract for hosts that pass headers explicitly via
   * `options.kimiRequestHeaders` (or for legacy callers / tests that
   * don't talk to the managed endpoint at all).
   *
   * `homeDir` resolution matches KimiCore's so the per-device id (minted
   * + cached at `<homeDir>/device_id` on first call) lives in the same
   * root as everything else KimiCore touches.
   *
   * Exposed as `static` so tests can assert the wiring without booting
   * the service.
   */
  static _defaultKimiRequestHeaders(
    homeDir: string,
    identity?: KimiHostIdentity,
  ): Record<string, string> | undefined {
    if (identity === undefined) return undefined;
    return createKimiDefaultHeaders({
      homeDir,
      ...identity,
    });
  }
}

// Self-register under the global singleton registry. Ctor signature is
// `(options, @IEnvironmentService, @IEventService, @IApprovalService,
//  @IQuestionService, @ILogService)` — the leading `options` slot is a pure data bag so we
// register with `[{}]` as a sane default. Daemon-side `start.ts` overrides
// this descriptor via `services.set(ICoreRuntime, new
// SyncDescriptor(CoreProcessService, [opts.coreProcessOptions ?? {}], false))`
// when it has access to the real options bag. Later registrations win — both
// at registry level and at `ServiceCollection` level.
// `supportsDelayedInstantiation = false` preserves current reverse-dispose
// semantics.
registerSingleton(
  ICoreRuntime,
  new SyncDescriptor(CoreProcessService, [{} as CoreProcessServiceOptions], false),
);
