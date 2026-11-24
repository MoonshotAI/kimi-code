import type { GoalSnapshot } from '#/features/goal/types';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionLegacyService {
  readonly _serviceBrand: undefined;

  goal(sessionId: string): Promise<GoalSnapshot | null>;
}

export const ISessionLegacyService: ServiceIdentifier<ISessionLegacyService> =
  createDecorator<ISessionLegacyService>('sessionLegacyService');
