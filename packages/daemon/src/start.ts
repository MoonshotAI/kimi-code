import {
  InstantiationService,
  ServiceCollection,
  SyncDescriptor,
  resolveConfigPath,
  resolveKimiHome,
} from '@moonshot-ai/agent-core';
import {
  AuthSummaryServiceImpl,
  HarnessBridge,
  IApprovalBroker,
  IAuthSummaryService,
  IEventBus,
  IHarnessBridge,
  IMcpService,
  IMessageService,
  IOAuthService,
  IPromptService,
  IQuestionBroker,
  ISessionService,
  ITaskService,
  IToolService,
  McpServiceImpl,
  MessageServiceImpl,
  OAuthServiceImpl,
  PromptServiceImpl,
  SessionNotFoundError,
  SessionServiceImpl,
  TaskServiceImpl,
  ToolServiceImpl,
  type HarnessBridgeOptions,
} from '@moonshot-ai/services';
import { ErrorCode } from '@moonshot-ai/protocol';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { ulid } from 'ulid';
import { promises as fspPromises } from 'node:fs';
import { sep as nodePathSep, relative as nodePathRelativeNative } from 'node:path';

import { okEnvelope } from './envelope.js';
import { installErrorHandler } from './error-handler.js';
import { acquireLock, DaemonLockedError } from './lock.js';
import { createDaemonLogger, type DaemonLogLevel, type DaemonLogger } from './logger.js';
import { resolveRequestId } from './request-id.js';
import { registerFsRoutes } from './routes/fs.js';
import { registerFilesRoutes } from './routes/files.js';
import { registerMessagesRoutes } from './routes/messages.js';
import { registerMetaRoute } from './routes/meta.js';
import { registerPromptsRoutes } from './routes/prompts.js';
import { registerApprovalsRoutes } from './routes/approvals.js';
import { registerAuthRoute } from './routes/auth.js';
import { registerOAuthRoutes } from './routes/oauth.js';
import { registerQuestionsRoutes } from './routes/questions.js';
import { registerSessionsRoutes } from './routes/sessions.js';
import { registerTasksRoutes } from './routes/tasks.js';
import { registerToolsRoutes } from './routes/tools.js';
import { DaemonApprovalBroker } from './services/approval-broker.js';
import { ConnectionRegistry, IConnectionRegistry } from './services/connection-registry.js';
import { DaemonEventBus } from './services/event-bus.js';
import { FsServiceImpl, IFsService } from './services/fs-service.js';
import {
  FsGitServiceImpl,
  IFsGitService,
} from './services/fs-git.js';
import {
  FsSearchServiceImpl,
  IFsSearchService,
} from './services/fs-search.js';
import {
  FsWatcherService,
  IFsWatcher,
  FsWatchLimitError,
  createConnectionLookup,
} from './services/fs-watcher.js';
import { FsPathEscapesError, resolveSafePath } from './services/fs-path-safety.js';
import { FileStoreImpl, IFileStore } from './services/file-store.js';
import { ILogger, PinoLogger } from './services/logger.js';
import { DaemonQuestionBroker } from './services/question-broker.js';
import { FastifyRestGateway, IRestGateway } from './services/rest-gateway.js';
import { ISessionClientsService, SessionClientsService } from './services/session-clients.js';
import { IWSGateway, WSGateway, type WSGatewayOptions } from './services/ws-gateway.js';
import { getDaemonVersion } from './version.js';

export interface DaemonStartOptions {
  host: string;
  port: number;
  logLevel?: DaemonLogLevel;
  /** Provide an external logger instead of constructing one. */
  logger?: DaemonLogger;
  /**
   * Override the default lock file path (`~/.kimi/daemon/lock`). Tests use
   * this to point at a tmpdir; production callers leave it undefined.
   */
  lockPath?: string;
  /**
   * Optional `HarnessBridgeOptions` passthrough — extends `KimiCoreOptions`
   * (homeDir, etc.). Tests use this to isolate KimiCore's `~/.kimi` lookup.
   */
  bridgeOptions?: HarnessBridgeOptions;
  /**
   * W5.1: optional WS gateway tunables for tests (`pingIntervalMs`, etc.).
   * Production callers leave this undefined and pick up the WS.md §1.3 / §3.1
   * defaults (30s ping, 10s pong deadline, 1000-event ring buffer).
   */
  wsGatewayOptions?: WSGatewayOptions;
}

export interface RunningDaemon {
  /** Resolved listening address, useful when port=0. */
  readonly address: string;
  /** Logger shared with Fastify; use this for daemon-level events. */
  readonly logger: DaemonLogger;
  /**
   * The DI container — exposed for tests and W5+ external consumers. The
   * container holds the bridge, brokers, and gateway. `close()` disposes it.
   */
  readonly services: InstantiationService;
  /** Stop the listener, dispose the container, release the lock; idempotent. */
  close(): Promise<void>;
}

/** Re-export so CLI / tests can `catch` against the specific lock-conflict type. */
export { DaemonLockedError };

/**
 * Boot the daemon (W4.4 / P0.14, extended in W5.1+W5.2 / P0.15+P0.16): lock
 * → Fastify → `app.ready()` → DI container → services → bridge.ready → listen.
 *
 * **Wiring order matters for teardown** (W3 handoff §Gotchas):
 *   construction order = [ILogger, IRestGateway, IConnectionRegistry,
 *                          ISessionClientsService, IEventBus, IApprovalBroker,
 *                          IQuestionBroker, IWSGateway, IHarnessBridge]
 *   dispose order      = REVERSE of the above (per InstantiationService
 *                        `_constructionOrder` semantics).
 *
 * So at shutdown: HarnessBridge → WSGateway (closes WS conns via the
 * registry) → brokers (Question, Approval, EventBus) → SessionClients →
 * ConnectionRegistry (no-op — gateway already drained it) → RestGateway →
 * Logger. The logger disposing last is critical — every other service's
 * `dispose()` may emit a log line. WSGateway disposing EARLY means brokers
 * never emit into closed sockets; SessionClients dropping AFTER EventBus
 * means the bus has stopped publishing before its subscriber index goes
 * away.
 *
 * **HarnessBridge construction** (post-P2.5 migration): `HarnessBridge` ctor is
 * now decorated `(options, @IEventBus, @IApprovalBroker, @IQuestionBroker)`
 * — services auto-inject. `defaultServicesModule()` still has no
 * `staticArguments` for the `options` slot, so direct
 * `accessor.get(IHarnessBridge)` against the module descriptor would
 * still construct with `undefined` options. We therefore
 * `ix.createInstance(HarnessBridge, opts.bridgeOptions ?? {})` inside an
 * `invokeFunction`, then `services.set(IHarnessBridge, bridge)` so
 * subsequent `a.get(IHarnessBridge)` returns the same singleton and the
 * container records it in its construction-order list.
 *
 * **Post-P2 wire-up shape**: every `ix.createInstance(...)` rest-arg list
 * in this function carries ONLY non-service static args (options bags,
 * closures, external instances). The `a.get(IFoo)` calls that remain
 * are either (a) construction-order "touch" pins or (b) actual consumer
 * dispatch (e.g. `a.get(IRestGateway).listen(...)`).
 *
 * **Anti-corruption invariant**: daemon source has zero direct SDK
 * (`packages/node-sdk`) imports — the bridge is the only path to
 * KimiCore, and we get it via `@moonshot-ai/services` re-exports.
 */
export async function startDaemon(opts: DaemonStartOptions): Promise<RunningDaemon> {
  const pinoLogger: DaemonLogger =
    opts.logger ?? createDaemonLogger({ level: opts.logLevel ?? 'info' });

  // Lock FIRST — if another daemon is alive we fail before reserving the port.
  const lockHandle = acquireLock({ port: opts.port, lockPath: opts.lockPath });

  const app = Fastify({
    loggerInstance: pinoLogger,
    disableRequestLogging: false,
    genReqId: (req) => resolveRequestId(req.headers),
  });
  installErrorHandler(app);

  // Register @fastify/swagger BEFORE routes so it can collect schema
  // metadata via the `onRoute` hook.
  const daemonVersion = getDaemonVersion();
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Kimi Code Daemon API',
        description:
          'REST API for the Kimi Code local daemon. All JSON responses are wrapped in a uniform envelope `{ code, msg, data, request_id }`.',
        version: daemonVersion,
      },
      tags: [
        { name: 'meta', description: 'Daemon metadata' },
        { name: 'auth', description: 'Auth readiness & login state' },
        { name: 'sessions', description: 'Session lifecycle' },
        { name: 'messages', description: 'Message history' },
        { name: 'prompts', description: 'Prompt submission & abort' },
        { name: 'approvals', description: 'Approval resolution' },
        { name: 'questions', description: 'Question resolution & dismiss' },
        { name: 'tools', description: 'Tool & MCP server management' },
        { name: 'tasks', description: 'Background tasks' },
        { name: 'fs', description: 'Filesystem operations' },
        { name: 'files', description: 'File upload & download' },
      ],
    },
  });

  // Seed the container with the two pre-built instances. They become "live"
  // (= recorded in _constructionOrder) only when first accessed via the
  // accessor below — so the order in the later `invokeFunction` block is
  // what actually determines disposal order.
  //
  // We construct the container BEFORE `app.ready()` so route modules can
  // capture `ix` by reference and resolve services at REQUEST time. Fastify
  // locks new route registration after `app.ready()`, so any module that
  // needs to `app.post(...)` etc. must register before the ready gate. The
  // service graph is filled in immediately below — completed BEFORE the
  // first request can land (we still `await app.ready()`, then `bridge.ready()`,
  // then `IRestGateway.listen()`).
  const services = new ServiceCollection(
    [ILogger, new PinoLogger(pinoLogger)],
    // P2.2: RestGateway carries `app: FastifyLike` as the only ctor arg — a
    // pure static dep. Switch from a pre-built instance to a descriptor with
    // `app` as a static argument so the container drives construction. The
    // FastifyLike instance is created above (Fastify needs the pino logger
    // so it can't itself be DI-constructed); we hand it in as a static.
    [IRestGateway, new SyncDescriptor(FastifyRestGateway, [app])],
  );
  const ix = new InstantiationService(services);

  // Register all REST routes under a single `/api/v1` prefix so individual
  // route modules don't hardcode the version segment.
  await app.register(async (apiV1) => {
    apiV1.get('/healthz', {
      schema: {
        description: 'Health check',
        response: {
          200: {
            type: 'object',
            properties: {
              code: { type: 'number' },
              msg: { type: 'string' },
              data: {
                type: 'object',
                properties: { ok: { type: 'boolean' } },
              },
              request_id: { type: 'string' },
            },
          },
        },
      },
    }, async (req, reply) => {
      return reply.send(okEnvelope({ ok: true }, req.id));
    });

    // W6.1 / Chain 1 — `/meta`. Pure daemon-self info, no DI needed. Mint
    // the per-process server_id + boot timestamp once at registration time
    // (ROADMAP P1.1; REST.md §3.1).
    const serverId = ulid();
    const startedAt = new Date().toISOString();
    registerMetaRoute(apiV1, {
      daemonVersion,
      serverId,
      startedAt,
    });

    // P2.1 / Chain P2.1.1 — `GET /auth`. Readiness probe + onboarding gate
    // signal. No body, no auth, always 200. Wired AFTER meta so reverse-
    // dispose order matters not (route registrations are not stateful).
    registerAuthRoute(apiV1 as unknown as Parameters<typeof registerAuthRoute>[0], ix);

    // P2.7 / Chain P2.7.1 — `/oauth/*`. Device-code flow start / poll /
    // cancel + logout. Grouped under the `auth` swagger tag since they're
    // all login-related; the URL prefix `/oauth` keeps them out of
    // `/auth`'s pure-readout namespace.
    registerOAuthRoutes(apiV1 as unknown as Parameters<typeof registerOAuthRoutes>[0], ix);

    // W6.2 / Chain 2 — register `/sessions/*` routes. The route module
    // captures `ix` by reference; per-request `accessor.get(ISessionService)`
    // dispatches against whatever's in the container at that moment. We
    // populate ISessionService below; by the time the first request lands the
    // container is fully wired (we await app.ready() + bridge.ready() before
    // listen() opens the socket).
    registerSessionsRoutes(apiV1 as unknown as Parameters<typeof registerSessionsRoutes>[0], ix);
    // W7.1 / Chain 3 — register `/sessions/{sid}/messages*` routes. Same
    // wiring story: handlers resolve `IMessageService` per-request through ix.
    registerMessagesRoutes(apiV1 as unknown as Parameters<typeof registerMessagesRoutes>[0], ix);
    // W7.2 / Chain 4 — register `/sessions/{sid}/prompts*` routes (submit +
    // abort). Submit triggers `bridge.rpc.prompt(...)` whose synchronous event
    // stream lands on `IEventBus → WS broadcast`. Abort is the REST fallback
    // for the WS abort message handled at `ws/connection.ts` (Chain 4b / W7.3).
    registerPromptsRoutes(apiV1 as unknown as Parameters<typeof registerPromptsRoutes>[0], ix);
    // W8.1 / Chain 5 — register `/sessions/{sid}/approvals/{aid}` route.
    // The reverse-RPC path: agent-core → bridge → DaemonApprovalBroker → WS
    // `event.approval.requested`. The REST handler completes the round-trip
    // by calling `IApprovalBroker.resolve(aid, body)`.
    registerApprovalsRoutes(
      apiV1 as unknown as Parameters<typeof registerApprovalsRoutes>[0],
      ix,
    );
    // W8.2 / Chain 6 — register `/sessions/{sid}/questions/{qid}*` routes.
    // Same reverse-RPC pattern as approval, with first-class `:dismiss`
    // (SCHEMAS §6.3) and 5-kind discriminated-union answer normalization
    // (SCHEMAS §6.4) done by the services adapter at REST-boundary time.
    registerQuestionsRoutes(
      apiV1 as unknown as Parameters<typeof registerQuestionsRoutes>[0],
      ix,
    );
    // W9.1 / Chain 7 — register `/tools` + `/mcp/servers*` routes.
    // Read-only `getTools` + `listMcpServers` plus `:restart` action — the 4th
    // call site of the `:tail` action-suffix pattern, now extracted into
    // `routes/action-suffix.ts`.
    registerToolsRoutes(
      apiV1 as unknown as Parameters<typeof registerToolsRoutes>[0],
      ix,
    );
    // W9.2 / Chain 8 — register `/sessions/{sid}/tasks*` routes.
    // list/get/cancel with 40406 + 40904 + the 5th `:tail` (action :cancel).
    registerTasksRoutes(
      apiV1 as unknown as Parameters<typeof registerTasksRoutes>[0],
      ix,
    );
    // W10 / Chains 9 + 10 — register `/sessions/{sid}/fs:*` routes.
    // POST :list / :read / :list_many / :stat / :stat_many — daemon-OWN
    // service, no agent-core bridge involved. Path safety is the central
    // correctness concern; every input path flows through
    // `resolveSafePath(cwd, input)` before any Node fs syscall.
    registerFsRoutes(
      apiV1 as unknown as Parameters<typeof registerFsRoutes>[0],
      ix,
    );

    // W12.2 / Chain 15 — register `/files*` routes (upload / download /
    // delete). Registers `@fastify/multipart` lazily on the captured
    // Fastify instance. Anti-corruption invariant: handlers resolve
    // `IFileStore` via the DI accessor; no SDK imports.
    registerFilesRoutes(
      apiV1 as unknown as Parameters<typeof registerFilesRoutes>[0],
      ix,
    );
  }, { prefix: '/api/v1' });

  // Register Swagger UI AFTER all routes are collected.
  await app.register(swaggerUi, {
    routePrefix: '/documentation',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });

  // Fastify lazily creates the raw `http.Server`. `WSGateway` (W5.1) needs
  // `app.server` to attach an `'upgrade'` listener — `app.ready()` populates
  // it without binding to a port (that happens later in `IRestGateway.listen`).
  try {
    await app.ready();
  } catch (err) {
    lockHandle.release();
    throw err;
  }

  // Touch logger + gateway in the intended construction order so they're
  // recorded for reverse-teardown. Then build the broker stubs (each takes
  // a positional `ILogger` static arg — brokers aren't @IFoo-decorated yet;
  // their direct-instance ctor is still the only construction path).
  let bridge: HarnessBridge;
  try {
    bridge = ix.invokeFunction((a) => {
      // Force construction-order recording for the two seeded instances —
      // ILogger first so it disposes LAST.
      a.get(ILogger);
      a.get(IRestGateway);

      // Build broker stubs against the resolved ILogger and register them.
      const log = a.get(ILogger);

      // W5.1 / P2.1: register IConnectionRegistry BEFORE event bus / brokers so the
      // reverse-dispose chain tears down WS connections (via IWSGateway, which
      // is constructed LATE → disposes EARLY) before brokers can emit on them.
      //
      // P2.1 migration: switch from `services.set(I, new C())` to a descriptor
      // so the container drives construction through `_createAndCacheServiceInstance`
      // and the @IFoo auto-injection path (ConnectionRegistry has 0 service deps,
      // so the auto-inject step is a no-op — this is the smoke-test commit per
      // Phase 1 handoff #1).
      services.set(IConnectionRegistry, new SyncDescriptor(ConnectionRegistry));
      // Touch BEFORE SessionClients to lock construction order:
      // [..., IConnectionRegistry, ISessionClientsService, IEventBus, ...]
      a.get(IConnectionRegistry);

      // W5.2 / P2.2: register ISessionClientsService BEFORE IEventBus so the bus
      // can hold a reference to it for broadcast fan-out. SessionClients
      // disposes AFTER IEventBus (reverse-order) — by then the bus has
      // already stopped publishing, so dropping the subscriber index is safe.
      //
      // P2.2 migration: descriptor-based registration; @ILogger gets
      // auto-injected.
      services.set(ISessionClientsService, new SyncDescriptor(SessionClientsService));
      a.get(ISessionClientsService);

      services.set(IEventBus, new DaemonEventBus(log, a.get(ISessionClientsService)));
      // Touch the event bus BEFORE constructing brokers so brokers can hold a
      // reference for broadcast (W8.1 / Chain 5).
      const eventBus = a.get(IEventBus) as DaemonEventBus;
      services.set(IApprovalBroker, new DaemonApprovalBroker(log, eventBus));
      services.set(IQuestionBroker, new DaemonQuestionBroker(log, eventBus));

      // Touch the brokers in order so they're recorded for reverse teardown
      // (Question → Approval → EventBus dispose direction).
      a.get(IApprovalBroker);
      a.get(IQuestionBroker);

      // W5.1 / P2.3: WSGateway constructed AFTER brokers but BEFORE HarnessBridge.
      // Reverse-dispose order then runs: Bridge → WSGateway (closes WS conns
      // via registry) → brokers → SessionClients → registry → RestGateway →
      // Logger. That's safe because brokers no longer have active sockets
      // to emit to.
      //
      // P2.3 migration: WSGateway ctor reordered to VSCode-style
      // (eventBus, options, @IRestGateway, @IConnectionRegistry,
      //  @ISessionClientsService, @ILogger). createInstance now only
      // supplies the two static prefix args; the 4 @I services auto-inject.
      const wsGateway = ix.createInstance(
        WSGateway,
        eventBus,
        opts.wsGatewayOptions ?? {},
      );
      services.set(IWSGateway, wsGateway);
      a.get(IWSGateway);

      // P2.5: HarnessBridge ctor migrated to VSCode-style
      // (options, @IEventBus, @IApprovalBroker, @IQuestionBroker).
      // createInstance now only supplies the static options prefix; the
      // 3 service deps auto-inject. The descriptor in
      // `defaultServicesModule()` has no staticArguments so direct
      // `a.get(IHarnessBridge)` against it would still fail — we keep
      // `services.set(IHarnessBridge, built)` so consumer call sites
      // resolve through the same singleton.
      const built = ix.createInstance(HarnessBridge, opts.bridgeOptions ?? {});
      services.set(IHarnessBridge, built);
      // Touch IHarnessBridge so it's recorded for reverse-teardown.
      a.get(IHarnessBridge);

      // W6.2 / Chain 2 — ISessionService. Same wiring pattern as HarnessBridge:
      // W6.2 / Chain 2 / P2.5 — ISessionService. @IHarnessBridge is now
      // auto-injected; createInstance call shrinks to a single arg.
      // construction-order trick: [..., IHarnessBridge, ISessionService].
      // Reverse-dispose then runs ISessionService BEFORE IHarnessBridge —
      // the service's dispose can't accidentally call back into a
      // torn-down bridge.
      const sessionService = ix.createInstance(SessionServiceImpl);
      services.set(ISessionService, sessionService);
      a.get(ISessionService);

      // W7.1 / Chain 3 / P2.5 — IMessageService. Same wiring pattern; insert AFTER
      // ISessionService so reverse-dispose order is
      // [..., IMessageService, ISessionService, IHarnessBridge, ...].
      // Both services depend on a live bridge during their dispose; bridge
      // disposes LAST among them.
      const messageService = ix.createInstance(MessageServiceImpl);
      services.set(IMessageService, messageService);
      a.get(IMessageService);

      // P2.1 / Chain P2.1.2 — IAuthSummaryService. Powers `GET /v1/auth` +
      // the `ensureReady` gate consumed by IPromptService. Constructed
      // BEFORE IPromptService so the prompt impl can @-inject it.
      // Reverse-dispose order: IPromptService → IAuthSummaryService →
      // IMessageService → ISessionService → IHarnessBridge.
      //
      // The ctor takes a static `{homeDir, configPath}` options bag — same
      // shape as `KimiCoreOptions` so the credential-file root and TOML
      // path line up exactly with what HarnessBridge / KimiCore see.
      // Tests pass `bridgeOptions.homeDir`; prod uses XDG defaults via
      // `resolveKimiHome` / `resolveConfigPath`.
      const authHomeDir = resolveKimiHome(opts.bridgeOptions?.homeDir);
      const authConfigPath = resolveConfigPath({
        homeDir: opts.bridgeOptions?.homeDir,
        configPath: opts.bridgeOptions?.configPath,
      });
      const authSummaryService = ix.createInstance(AuthSummaryServiceImpl, {
        homeDir: authHomeDir,
        configPath: authConfigPath,
      });
      services.set(IAuthSummaryService, authSummaryService);
      a.get(IAuthSummaryService);

      // P2.7 — IOAuthService. Same options bag (homeDir + configPath) as
      // IAuthSummaryService. Constructed BEFORE IPromptService so the auth
      // gate sees a fully-wired oauth surface; reverse-dispose runs
      // IOAuthService BEFORE IAuthSummaryService so any in-flight device
      // flow gets aborted before the config readers go away.
      const oauthService = ix.createInstance(OAuthServiceImpl, {
        homeDir: authHomeDir,
        configPath: authConfigPath,
      });
      services.set(IOAuthService, oauthService);
      a.get(IOAuthService);

      // W7.2 / Chain 4 / P2.5 — IPromptService. Ctor takes IHarnessBridge + IEventBus
      // (the impl uses the bus both to publish synthetic prompt.completed /
      // prompt.aborted events AND to register itself as a lifecycle observer
      // so it sees turn.started/turn.ended). Construction order:
      // [..., IMessageService, IPromptService] — reverse dispose runs
      // IPromptService FIRST among the daemon-services, then IMessageService,
      // then ISessionService, then IHarnessBridge.
      const promptService = ix.createInstance(PromptServiceImpl);
      services.set(IPromptService, promptService);
      a.get(IPromptService);
      // Register the service as a lifecycle observer on the bus. The detach
      // function is intentionally not stored — the observer is unregistered
      // when the bus itself disposes (which happens LATER in the dispose
      // chain than IPromptService, so observers automatically stop being
      // invoked once the bus tears down).
      (eventBus as DaemonEventBus).addObserver(promptService);

      // W7.3 — wire the WS abort handler. Both REST and WS abort go through
      // `IPromptService.abort`; the WS connection needs an `AbortHandler`
      // adapter exposing `abort()` + `currentSeq()` so it can populate the
      // ack `at_seq` on idempotent calls. We compose one in-place.
      const wsGw = a.get(IWSGateway);
      wsGw.setAbortHandler({
        abort: (sid, pid) => promptService.abort(sid, pid),
        currentSeq: (sid) => (eventBus as DaemonEventBus).currentSeq(sid),
      });

      // W9.1 / Chain 7 / P2.5 — IToolService + IMcpService. Both depend only on the
      // bridge. Construction order: [..., IPromptService, IToolService,
      // IMcpService]. Reverse dispose runs IMcpService FIRST among the new
      // services, then IToolService, then IPromptService — all BEFORE the
      // bridge.
      const toolService = ix.createInstance(ToolServiceImpl);
      services.set(IToolService, toolService);
      a.get(IToolService);
      const mcpService = ix.createInstance(McpServiceImpl);
      services.set(IMcpService, mcpService);
      a.get(IMcpService);

      // W9.2 / Chain 8 / P2.5 — ITaskService. Same wiring pattern; appended LAST
      // so reverse-dispose closes it first among the W9 additions.
      const taskService = ix.createInstance(TaskServiceImpl);
      services.set(ITaskService, taskService);
      a.get(ITaskService);

      // W10 / Chains 9 + 10 / P2.4 — IFsService. DAEMON-OWN service (not bridged
      // via IHarnessBridge — fs operates on `session.metadata.cwd`
      // directly). Depends only on ISessionService for the cwd lookup.
      // Construction order: [..., ITaskService, IFsService]. Reverse
      // dispose runs IFsService FIRST (clears its .gitignore matcher
      // cache) so the session service is still live during its dispose.
      const fsService = ix.createInstance(FsServiceImpl);
      services.set(IFsService, fsService);
      a.get(IFsService);

      // W11 / Chain 11 / P2.4 — IFsSearchService. DAEMON-OWN like IFsService.
      // Depends on ISessionService (for cwd) + ILogger (for the
      // one-shot "rg missing" warning). Inserted AFTER IFsService so
      // reverse-dispose runs IFsSearchService FIRST among the W11
      // additions, then IFsService, then ISessionService.
      const fsSearchService = ix.createInstance(FsSearchServiceImpl);
      services.set(IFsSearchService, fsSearchService);
      a.get(IFsSearchService);

      // W11 / Chain 12 / P2.4 — IFsGitService. DAEMON-OWN like IFsService.
      // Depends only on ISessionService (for cwd). Inserted AFTER
      // IFsSearchService so reverse-dispose runs IFsGitService FIRST
      // among the W11 additions.
      const fsGitService = ix.createInstance(FsGitServiceImpl);
      services.set(IFsGitService, fsGitService);
      a.get(IFsGitService);

      // W12 / Chain 14 — IFsWatcher. DAEMON-OWN. Wraps a per-session
      // chokidar `FSWatcher`, coalesces events over 200ms windows,
      // truncates at 500 raw events/window, and pushes targeted (NOT
      // broadcast) `event.fs.changed` frames to the connections whose
      // subscribed paths overlap the change.
      //
      // The watcher needs a `connection-lookup` for the targeted push;
      // we use `IConnectionRegistry.get` bound. We also wire the
      // `FsWatchHandler` adapter onto `IWSGateway` so any NEW WS
      // connection captures it at construction — same pattern as W7.3's
      // abort handler. EXISTING connections (during graceful
      // restart-in-place) won't have an fs handler; production wires
      // this before any client can connect.
      //
      // Construction order: AFTER IFsGitService. Reverse-dispose runs
      // IFsWatcher FIRST (closes every chokidar instance), then
      // IFsGitService, etc.
      //
      // P2.6: @ILogger + @ISessionService auto-injected; only `lookup`
      // (closure over the live registry) and `{}` options remain as
      // positional static args.
      const registry = a.get(IConnectionRegistry);
      const fsWatcher = ix.createInstance(
        FsWatcherService,
        createConnectionLookup((id) => registry.get(id)),
        {},
      );
      services.set(IFsWatcher, fsWatcher);
      a.get(IFsWatcher);

      // Build the WS adapter mapping `(sessionId, connId, wirePaths) →
      // resolve cwd → resolveSafePath → IFsWatcher.addPaths/removePaths`.
      // Errors map to wire ack codes:
      //   - FsWatchLimitError  → 42902 fs.watch_limit_exceeded
      //   - FsPathEscapesError → 41304 fs.path_escapes_session
      //   - SessionNotFoundError → 40401 session.not_found
      //   - other              → 50001 internal
      const fsWatchHandler = {
        async add(sessionId: string, connectionId: string, wirePaths: readonly string[]) {
          try {
            const session = await a.get(ISessionService).get(sessionId);
            // `resolveSafePath` realpath's the cwd internally; we must use
            // the SAME realpath here for the absolute→POSIX-relative
            // conversion (macOS routes `/tmp` to `/private/tmp`, etc).
            const realCwd = await fspPromises.realpath(session.metadata.cwd);
            // Bind cwd so the watcher can map absolute → POSIX-relative on emit.
            fsWatcher.bindSessionCwd(sessionId, realCwd);
            const absPaths: string[] = [];
            for (const p of wirePaths) {
              const safe = await resolveSafePath(session.metadata.cwd, p);
              absPaths.push(safe.absolute);
            }
            fsWatcher.addPaths(sessionId, connectionId, absPaths);
            const watched = fsWatcher.watchedPaths(connectionId, sessionId);
            // Convert absolute paths back to POSIX-relative for the wire.
            const wire = watched.map((abs) => toPosixRelativeForCwd(realCwd, abs));
            return {
              ok: true as const,
              watched_paths: wire,
              current_count: fsWatcher.countForConnection(connectionId),
            };
          } catch (err) {
            return mapFsWatchError(err);
          }
        },
        async remove(sessionId: string, connectionId: string, wirePaths: readonly string[]) {
          try {
            const session = await a.get(ISessionService).get(sessionId);
            const realCwd = await fspPromises.realpath(session.metadata.cwd);
            const absPaths: string[] = [];
            for (const p of wirePaths) {
              // Path safety still applies — clients can't unwatch a path that
              // escapes cwd (defensive; we'd reject the corresponding add too).
              const safe = await resolveSafePath(session.metadata.cwd, p);
              absPaths.push(safe.absolute);
            }
            fsWatcher.removePaths(sessionId, connectionId, absPaths);
            const watched = fsWatcher.watchedPaths(connectionId, sessionId);
            const wire = watched.map((abs) => toPosixRelativeForCwd(realCwd, abs));
            return {
              ok: true as const,
              watched_paths: wire,
              current_count: fsWatcher.countForConnection(connectionId),
            };
          } catch (err) {
            return mapFsWatchError(err);
          }
        },
        cleanupConnection(connectionId: string) {
          fsWatcher.forgetConnection(connectionId);
        },
      };
      wsGw.setFsWatchHandler(fsWatchHandler);

      // W12.2 / Chain 15 — IFileStore. DAEMON-OWN like IFsWatcher.
      // Persists uploads under `<homeDir>/.kimi/files/` with a JSON
      // index. Depends only on ILogger. Inserted AFTER IFsWatcher so
      // reverse-dispose runs IFileStore FIRST among the W12 additions
      // (drops the index cache + idle file handles).
      //
      // `homeDir` resolution: prefer `bridgeOptions.homeDir` if the
      // caller set one (tests do this to isolate the store under a
      // tmpdir); fall back to `~/.kimi`. The bridge also lives under
      // the same root so they co-exist (`<homeDir>/files/` vs.
      // `<homeDir>/<other bridge subdirs>`).
      //
      // P2.6: @ILogger auto-injects; only the options bag remains as
      // a positional static arg.
      const fileStoreHomeDir = opts.bridgeOptions?.homeDir;
      const fileStore = ix.createInstance(
        FileStoreImpl,
        fileStoreHomeDir !== undefined ? { homeDir: fileStoreHomeDir } : {},
      );
      services.set(IFileStore, fileStore);
      a.get(IFileStore);

      return built;
    });
  } catch (err) {
    // Container half-built — dispose what we have, drop the lock, rethrow.
    try {
      ix.dispose();
    } catch {
      /* ignore */
    }
    lockHandle.release();
    throw err;
  }

  // Bridge readiness gate — KimiCore plugin init + RPC binding completion.
  // Awaiting before listen() means /healthz only goes live once the
  // services graph is fully usable.
  try {
    await bridge.ready();
  } catch (err) {
    try {
      ix.dispose();
    } catch {
      /* ignore */
    }
    lockHandle.release();
    throw err;
  }
  pinoLogger.info('services bridge ready');

  let address: string;
  try {
    address = await ix.invokeFunction((a) => a.get(IRestGateway).listen(opts.host, opts.port));
  } catch (err) {
    try {
      ix.dispose();
    } catch {
      /* ignore */
    }
    lockHandle.release();
    throw err;
  }
  pinoLogger.info({ address, lockPath: lockHandle.lockPath }, 'daemon listening');

  let closed = false;
  return {
    address,
    logger: pinoLogger,
    services: ix,
    close: async () => {
      if (closed) return;
      closed = true;
      // 1. Close attached WS connections FIRST (with WS code 1001 = going
      //    away). If we let `app.close()` run first it would tear down the
      //    underlying TCP sockets, denying us a clean WS close frame.
      //    The container's reverse-dispose chain runs the same logic via
      //    `WSGateway.dispose()`, but Fastify's `close()` is async and races
      //    its socket-killer against our timing — so we explicitly drain the
      //    WS gateway here first.
      try {
        ix.invokeFunction((a) => a.get(IWSGateway));
        // WSGateway has no public drain method (closes happen on dispose);
        // we trigger it via the registry directly, which is idempotent.
        ix.invokeFunction((a) => a.get(IConnectionRegistry).closeAll('daemon shutting down'));
      } catch {
        // container may be partially disposed — fall through to app.close()
      }
      // 2. Stop accepting new requests + drain in-flight ones. Done
      //    explicitly here (instead of relying on FastifyRestGateway.dispose's
      //    fire-and-forget) so callers see a real `await` boundary.
      try {
        await app.close();
      } catch {
        // continue teardown even if drain throws
      }
      // 3. Dispose container: HarnessBridge → WSGateway → brokers → registry
      //    → gateway → logger (reverse construction order). WSGateway.dispose()
      //    now finds an empty registry; harmless idempotent path.
      try {
        ix.dispose();
      } catch {
        // continue
      }
      // 3. Release the lock LAST so other tooling can rely on lock-absence ==
      //    daemon-fully-shut-down.
      lockHandle.release();
    },
  };
}

/* -------------------------------------------------------------------------
 * Helpers for the FsWatchHandler adapter (W12 / Chain 14)
 * ----------------------------------------------------------------------- */

/**
 * Wire-path conversion for the `watched_paths` ack field. Same algorithm
 * as `fs-path-safety.ts:toPosixRelative` but inlined here so the start.ts
 * adapter doesn't import path-safety internals (the safety module's
 * `toPosixRelative` is private). If a future iteration needs the helper
 * in more places we can hoist it.
 */
function toPosixRelativeForCwd(cwd: string, abs: string): string {
  if (abs === cwd) return '.';
  const rel = nodePathRelativeNative(cwd, abs);
  if (rel === '') return '.';
  return rel.split(nodePathSep).join('/');
}

/**
 * Translate watcher-layer errors into the wire `code` the WS ack carries.
 */
function mapFsWatchError(err: unknown):
  | { ok: false; code: number; msg: string } {
  if (err instanceof FsWatchLimitError) {
    return {
      ok: false,
      code: ErrorCode.FS_WATCH_LIMIT_EXCEEDED,
      msg: err.message,
    };
  }
  if (err instanceof FsPathEscapesError) {
    return {
      ok: false,
      code: ErrorCode.FS_PATH_ESCAPES_SESSION,
      msg: err.message,
    };
  }
  if (err instanceof SessionNotFoundError) {
    return {
      ok: false,
      code: ErrorCode.SESSION_NOT_FOUND,
      msg: 'session not found',
    };
  }
  return {
    ok: false,
    code: ErrorCode.INTERNAL_ERROR,
    msg: err instanceof Error ? err.message : 'fs watch error',
  };
}
