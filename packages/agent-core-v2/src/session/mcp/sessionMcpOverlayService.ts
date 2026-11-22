import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';

import { ISessionMcpOverlayConnection } from './sessionMcpOverlay';

export interface ISessionMcpOverlayService {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
}

export const ISessionMcpOverlayService: ServiceIdentifier<ISessionMcpOverlayService> =
  createDecorator<ISessionMcpOverlayService>('sessionMcpOverlayService');

export class SessionMcpOverlayService extends Service implements ISessionMcpOverlayService {
  declare readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  constructor(@ISessionMcpOverlayConnection connection: ISessionMcpOverlayConnection) {
    super();
    this.ready = connection.ready;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionMcpOverlayService,
  SessionMcpOverlayService,
  ScopeActivation.OnDemand,
  'sessionMcpOverlay',
);
