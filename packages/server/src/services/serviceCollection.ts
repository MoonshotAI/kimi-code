import {
  getSingletonServiceDescriptors,
  ServiceCollection,
  SyncDescriptor,
} from '@moonshot-ai/agent-core';
import * as Services from '@moonshot-ai/agent-core';
import type { Logger as PinoLogger } from 'pino';

import type { FastifyLike } from '#/services/gateway/restGateway';
import type { ServerStartOptions } from '../start';

import { ApprovalService } from '#/services/approval/approvalService';
import { IConnectionRegistry } from '#/services/gateway/connectionRegistry';
import { ConnectionRegistry } from '#/services/gateway/connectionRegistryService';
import { PinoLogger as PinoLoggerAdapter } from './pinoLoggerService';
import { QuestionService } from '#/services/question/questionService';
import { IRestGateway } from '#/services/gateway/restGateway';
import { FastifyRestGateway } from '#/services/gateway/restGatewayService';
import { ISessionClientsService } from '#/services/gateway/sessionClients';
import { SessionClientsService } from '#/services/gateway/sessionClientsService';
import { IWSGateway } from '#/services/gateway/wsGateway';
import { WSGateway } from '#/services/gateway/wsGatewayService';
import { IWSBroadcastService } from '#/services/gateway/wsBroadcast';
import { WSBroadcastService } from '#/services/gateway/wsBroadcastService';
import {
  IModelCatalogRefreshScheduler,
  ModelCatalogRefreshScheduler,
} from '#/services/modelCatalog/modelCatalogRefreshScheduler';
import { ISnapshotService, SnapshotService, loadSnapshotConfig } from '#/services/snapshot';
import { IGuiStoreService } from '#/services/guiStore/guiStore';
import { GuiStoreService } from '#/services/guiStore/guiStoreService';

export interface ServerServiceCollectionOptions {
  readonly server: ServerStartOptions;
  readonly app: FastifyLike;
  readonly pinoLogger: PinoLogger;
  readonly envService: Services.IEnvironmentService;
}

export function createServerServiceCollection(
  input: ServerServiceCollectionOptions,
): ServiceCollection {
  const { server, app, pinoLogger, envService } = input;

  const snapshotConfig = loadSnapshotConfig();

  const services = new ServiceCollection(
    ...getSingletonServiceDescriptors(),
    [IConnectionRegistry, new SyncDescriptor(ConnectionRegistry, [], false)],
    [ISessionClientsService, new SyncDescriptor(SessionClientsService, [], false)],
    [IWSBroadcastService, new SyncDescriptor(WSBroadcastService, [], false)],
    [IModelCatalogRefreshScheduler, new SyncDescriptor(ModelCatalogRefreshScheduler, [], false)],
    [Services.IApprovalService, new SyncDescriptor(ApprovalService, [], false)],
    [Services.IQuestionService, new SyncDescriptor(QuestionService, [], false)],
  );

  if (snapshotConfig.mode !== 'legacy') {
    services.set(ISnapshotService, new SyncDescriptor(SnapshotService, [], false));
  }

  services.set(Services.ILogService, new PinoLoggerAdapter(pinoLogger));
  services.set(
    Services.IFsSearchService,
    new SyncDescriptor(
      Services.FsSearchService,
      [server.coreProcessOptions?.telemetry ?? Services.noopTelemetryClient],
      true,
    ),
  );
  services.set(IRestGateway, new FastifyRestGateway(app));
  services.set(Services.IEnvironmentService, envService);
  services.set(IGuiStoreService, new SyncDescriptor(GuiStoreService, [], false));

  services.set(
    IWSGateway,
    new SyncDescriptor(WSGateway, [server.wsGatewayOptions ?? {}], false),
  );
  services.set(
    Services.ICoreProcessService,
    new SyncDescriptor(Services.CoreProcessService, [server.coreProcessOptions ?? {}], false),
  );

  // `IAuthTokenService` (ROADMAP M2.1) is intentionally NOT registered here:
  // its real instance needs an async-built `TokenStore` + `passwordHash` that
  // are only available in `start.ts` (M5.1). It is therefore supplied via
  // `server.serviceOverrides` (last-wins) — the same seam tests use to inject
  // a fixed-token impl. A silent default would be a security hole, so the
  // absence is deliberate: an unconfigured server has no auth token service.
  for (const [id, override] of server.serviceOverrides ?? []) {
    services.set(id, override);
  }

  return services;
}
