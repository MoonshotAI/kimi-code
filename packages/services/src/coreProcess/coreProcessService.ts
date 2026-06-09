/**
 * `CoreProcessService` — implementation of `ICoreProcessService`.
 */

import {
  createRPC,
  Disposable,
  KimiCore,
  registerSingleton,
  SyncDescriptor,
  type CoreAPI,
  type CoreRPC,
  type OAuthTokenProviderResolver,
  type SDKAPI,
} from '@moonshot-ai/agent-core';
import {
  createKimiDefaultHeaders,
  type KimiHostIdentity,
} from '@moonshot-ai/kimi-code-oauth';
import { KimiAuthFacade } from '@moonshot-ai/kimi-code-sdk';

import { BridgeClientAPI } from './coreProcessClient';
import { IApprovalService } from '../approval/approval';
import { IEnvironmentService } from '../environment/environment';
import { IEventService } from '../event/event';
import { IQuestionService } from '../question/question';
import { ICoreProcessService, type CoreProcessServiceOptions } from './coreProcess';

export class CoreProcessService extends Disposable implements ICoreProcessService {
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
  ) {
    super();

    // 1. Build the in-process RPC pair. Left/Right are typed; `coreRpc` is the
    //    function KimiCore receives, `sdkRpc` is the one we satisfy.
    const [coreRpc, sdkRpc] = createRPC<CoreAPI, SDKAPI>();

    // Default-wire the OAuth token resolver. Without this, KimiCore's
    // `ProviderManager.resolveAuth` sees `resolveOAuthTokenProvider ===
    // undefined` and synthesizes a closure that ALWAYS throws
    // `AUTH_LOGIN_REQUIRED` — even after a successful device-code login that
    // persisted a fresh token to disk. The daemon's `/auth` readiness probe
    // is a different code path (file existence on the credentials store) so
    // it stays green; the failure only surfaces inside the prompt turn, as
    // an `auth.login_required` error after `turn.step.started`. We bridge
    // the gap by default-constructing a `KimiAuthFacade` against the same
    // home + config paths KimiCore will use, and handing its
    // `resolveOAuthTokenProvider` into the core. Callers (e.g. node-sdk
    // tests) can still override via `options.resolveOAuthTokenProvider`.
    const resolveOAuthTokenProvider: OAuthTokenProviderResolver =
      options.resolveOAuthTokenProvider ??
      CoreProcessService._defaultOAuthTokenResolver(env.homeDir, env.configPath);

    // Default-wire the Kimi request headers (User-Agent + X-Msh-* device
    // identity). Without this, KimiCore's outbound fetch carries the
    // default Node fetch User-Agent and the managed Kimi-for-Coding
    // endpoint rejects with 40340 ("only available for Coding Agents
    // such as Kimi CLI, Claude Code, …"). Mirrors what `SDKRpcClient`
    // does for the in-process TUI path (node-sdk's sdk-rpc-client.ts).
    // Caller-supplied `kimiRequestHeaders` always wins; absent that, we
    // synthesize from `options.identity`. Hosts that pass neither
    // (no identity, no headers) still construct — but their requests will
    // trip the 40340 guard.
    const kimiRequestHeaders: Record<string, string> | undefined =
      options.kimiRequestHeaders ??
      CoreProcessService._defaultKimiRequestHeaders(env.homeDir, options.identity);

    // `appVersion` flows into Session records (`app_version`) and tool
    // call ctx. Prefer explicit > identity.version so callers can pin
    // a different value if they need to.
    const appVersion: string | undefined =
      options.appVersion ?? options.identity?.version;

    // 2. Construct the core. KimiCore's ctor wires itself into `coreRpc` and
    //    exposes `this.sdk: Promise<SDKRPC>` for the reverse direction.
    this._core = new KimiCore(coreRpc, {
      ...options,
      homeDir: env.homeDir,
      configPath: env.configPath,
      kimiRequestHeaders,
      appVersion,
      resolveOAuthTokenProvider,
    });

    // 3. Satisfy the SDK side with a BridgeClientAPI that routes to peer services.
    //    sdkRpc returns Promise<RPCMethods<CoreAPI>> — these are the methods
    //    in-package services will dispatch on.
    const clientApi = new BridgeClientAPI({
      eventService,
      approvalService,
      questionService,
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

  override dispose(): void {
    if (this._isDisposed) return;
    // KimiCore does not currently expose a dispose() — when it does, we'll
    // await/call it here BEFORE super.dispose(). For now, disposing the
    // service flips _disposed, which makes future rpc.* invocations reject
    // before they reach KimiCore.
    super.dispose();
  }

  private _buildRpcProxy(): CoreRPC {
    const rpcPromise = this._coreRpcPromise;
    const isDisposedRef = () => this._isDisposed;

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
    const facade = new KimiAuthFacade({ homeDir, configPath });
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
//  @IQuestionService)` — the leading `options` slot is a pure data bag so we
// register with `[{}]` as a sane default. Daemon-side `start.ts` overrides
// this descriptor via `services.set(ICoreProcessService, new
// SyncDescriptor(CoreProcessService, [opts.coreProcessOptions ?? {}], false))`
// when it has access to the real options bag. Later registrations win — both
// at registry level and at `ServiceCollection` level.
// `supportsDelayedInstantiation = false` preserves current reverse-dispose
// semantics.
registerSingleton(
  ICoreProcessService,
  new SyncDescriptor(CoreProcessService, [{} as CoreProcessServiceOptions], false),
);
