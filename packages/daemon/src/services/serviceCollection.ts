/**
 * `createDaemonServiceCollection` — central wiring for the daemon's DI graph.
 * Mirrors the VSCode `electron-main/main.ts:162-233`
 * pattern: hybrid `ServiceCollection`, with:
 *
 *   - **Prebuilt** `services.set(I, new C(...))` for services that capture
 *     runtime handles or closures the container can't synthesize
 *     (`PinoLogger` wraps the Fastify-shared `pino.Logger`;
 *     `FastifyRestGateway` wraps the `FastifyLike` instance;
 *     `IEnvironmentService` carries CLI-resolved `homeDir` / `configPath`).
 *   - **Descriptor** `services.set(I, new SyncDescriptor(C, [], false))` for
 *     services whose ctor is pure `@I…` injection. The container drives
 *     construction via `_createAndCacheServiceInstance` so decorators auto-inject.
 *     A handful of services still take a leading options bag (e.g.
 *     `CoreProcessService` with `coreProcessOptions`, `WSGateway` with
 *     `wsGatewayOptions`); those use `new SyncDescriptor(C, [options], false)`.
 *
 * `supportsDelayedInstantiation = false` for every descriptor here to preserve
 * the `_constructionOrder` discipline that powers reverse-dispose order. The
 * `a.get(IX)` touch sequence in `start.ts` still pins the ordering.
 *
 * # Why a helper (not inline in start.ts)?
 *
 * Centralizing all `services.set(... new SyncDescriptor(...))` in one place
 * keeps the wiring shape auditable in a single file while `start.ts` retains
 * the construction-order touch list + post-collection adapters
 * (`IFsWatcher` closure construction,
 * `setUnexpectedErrorHandler`, WS abort + fs-watch handler wiring).
 *
 * # Why `IFsWatcher` stays in start.ts
 *
 * `FsWatcherService` ctor takes a `connection-lookup` closure built from
 * `IConnectionRegistry.get` at runtime. That closure isn't serializable
 * into a `SyncDescriptor` static-arg slot, so we keep its construction
 * inside the `ix.invokeFunction` block in `start.ts` post-collection.
 */

import {
  ServiceCollection,
  SyncDescriptor,
} from '@moonshot-ai/agent-core';
import {
  AuthSummaryService,
  CoreProcessService,
  defaultServicesModule,
  EventService,
  IApprovalService,
  IAuthSummaryService,
  IEnvironmentService,
  IEventService,
  ICoreProcessService,
  IMcpService,
  IMessageService,
  IOAuthService,
  IPromptService,
  IQuestionService,
  ISessionService,
  ITaskService,
  IToolService,
  McpService,
  MessageService,
  OAuthService,
  PromptService,
  SessionService,
  TaskService,
  ToolService,
} from '@moonshot-ai/services';
import type { Logger as PinoLogger } from 'pino';

import type { FastifyLike } from '#/services/gateway/restGateway';
import type { DaemonStartOptions } from '../start';

import { ApprovalService } from '#/services/approval/approvalService';
import { IConnectionRegistry } from '#/services/gateway/connectionRegistry';
import { ConnectionRegistry } from '#/services/gateway/connectionRegistryService';
import { IFsService } from '#/services/fs/fs';
import { FsService } from '#/services/fs/fsService';
import { IFsGitService } from '#/services/fs/fsGit';
import { FsGitService } from '#/services/fs/fsGitService';
import { IFsSearchService } from '#/services/fs/fsSearch';
import { FsSearchService } from '#/services/fs/fsSearchService';
import { IFileStore } from '#/services/fileStore/fileStore';
import { FileStore } from '#/services/fileStore/fileStoreService';
import { ILogService } from '#/services/logger/logger';
import { PinoLogger as PinoLoggerAdapter } from '#/services/logger/loggerService';
import { QuestionService } from '#/services/question/questionService';
import { IRestGateway } from '#/services/gateway/restGateway';
import { FastifyRestGateway } from '#/services/gateway/restGatewayService';
import { ISessionClientsService } from '#/services/gateway/sessionClients';
import { SessionClientsService } from '#/services/gateway/sessionClientsService';
import {
  IWorkspaceFsService,
  IWorkspaceRegistry,
  WorkspaceFsService,
  WorkspaceRegistryService,
} from '#/services/workspace';
import { IWSGateway } from '#/services/gateway/wsGateway';
import { WSGateway } from '#/services/gateway/wsGatewayService';
import { IWSBroadcastService } from '#/services/gateway/wsBroadcast';
import { WSBroadcastService } from '#/services/gateway/wsBroadcastService';

export interface DaemonServiceCollectionOptions {
  /** Original `startDaemon` options bag — carries the per-service tunables. */
  readonly daemon: DaemonStartOptions;
  /** Resolved Fastify instance (`app`) — needed by `FastifyRestGateway`. */
  readonly app: FastifyLike;
  /** Fastify-shared pino logger — wrapped by `PinoLoggerAdapter`. */
  readonly pinoLogger: PinoLogger;
  /** Pre-resolved environment paths (homeDir / configPath). */
  readonly envService: IEnvironmentService;
}

/**
 * Assemble the daemon's `ServiceCollection`. The returned collection has
 * EVERY singleton seeded — either as a prebuilt instance (runtime-handle
 * services) or as a `SyncDescriptor` (descriptor-first singletons).
 *
 * One singleton NOT registered here, by design:
 *   - `IFsWatcher` — needs a closure over `IConnectionRegistry.get` at
 *     construction time; built inline in `start.ts` (see file header).
 */
export function createDaemonServiceCollection(
  input: DaemonServiceCollectionOptions,
): ServiceCollection {
  const { daemon, app, pinoLogger, envService } = input;

  const services = new ServiceCollection(
    // Registry entries from `@moonshot-ai/services` (self-registered by each
    // impl file at module-load time). These supply the default descriptors
    // for services whose ctor is pure `@I…` injection.
    ...defaultServicesModule(),
    // Daemon-only services not shipped by `@moonshot-ai/services`.
    [IConnectionRegistry, new SyncDescriptor(ConnectionRegistry, [], false)],
    [ISessionClientsService, new SyncDescriptor(SessionClientsService, [], false)],
    [IWSBroadcastService, new SyncDescriptor(WSBroadcastService, [], false)],
    [IApprovalService, new SyncDescriptor(ApprovalService, [], false)],
    [IQuestionService, new SyncDescriptor(QuestionService, [], false)],
    [IFsService, new SyncDescriptor(FsService, [], false)],
    [IFsSearchService, new SyncDescriptor(FsSearchService, [], false)],
    [IFsGitService, new SyncDescriptor(FsGitService, [], false)],
    [IWorkspaceFsService, new SyncDescriptor(WorkspaceFsService, [], false)],
  );

  // -- Prebuilt: services that need runtime handles / external closures ------
  services.set(ILogService, new PinoLoggerAdapter(pinoLogger));
  services.set(IRestGateway, new FastifyRestGateway(app));
  services.set(IEnvironmentService, envService);

  // -- Override registry entries with runtime static args --------------------
  services.set(
    IWSGateway,
    new SyncDescriptor(WSGateway, [daemon.wsGatewayOptions ?? {}], false),
  );
  services.set(
    ICoreProcessService,
    new SyncDescriptor(CoreProcessService, [daemon.coreProcessOptions ?? {}], false),
  );

  // `IFileStore` + `IWorkspaceRegistry` derive their on-disk base from
  // `IEnvironmentService.homeDir` (which itself reads
  // `opts.coreProcessOptions?.homeDir`). No static args here — the impls
  // inject `IEnvironmentService` directly.
  services.set(IFileStore, new SyncDescriptor(FileStore, [], false));
  services.set(IWorkspaceRegistry, new SyncDescriptor(WorkspaceRegistryService, [], false));

  return services;
}
