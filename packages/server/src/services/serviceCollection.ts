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

  const services = new ServiceCollection(
    ...getSingletonServiceDescriptors(),
    [IConnectionRegistry, new SyncDescriptor(ConnectionRegistry, [], false)],
    [ISessionClientsService, new SyncDescriptor(SessionClientsService, [], false)],
    [IWSBroadcastService, new SyncDescriptor(WSBroadcastService, [], false)],
    [Services.IApprovalService, new SyncDescriptor(ApprovalService, [], false)],
    [Services.IQuestionService, new SyncDescriptor(QuestionService, [], false)],
  );

  services.set(Services.ILogService, new PinoLoggerAdapter(pinoLogger));
  services.set(IRestGateway, new FastifyRestGateway(app));
  services.set(Services.IEnvironmentService, envService);

  services.set(
    IWSGateway,
    new SyncDescriptor(WSGateway, [server.wsGatewayOptions ?? {}], false),
  );
  services.set(
    Services.ICoreProcessService,
    new SyncDescriptor(Services.CoreProcessService, [server.coreProcessOptions ?? {}], false),
  );

  for (const [id, override] of server.serviceOverrides ?? []) {
    services.set(id, override);
  }

  return services;
}
