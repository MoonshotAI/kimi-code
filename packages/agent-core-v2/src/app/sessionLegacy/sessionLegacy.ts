import type { GoalSnapshot } from '#/features/goal/types';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface SessionWireFields {
  readonly id: string;
  readonly workspaceId: string;
  readonly root: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly archivedAt?: number;
  readonly custom?: Record<string, unknown>;
}

export interface ISessionLegacyService {
  readonly _serviceBrand: undefined;

  goal(sessionId: string): Promise<GoalSnapshot | null>;
}

export const ISessionLegacyService: ServiceIdentifier<ISessionLegacyService> =
  createDecorator<ISessionLegacyService>('sessionLegacyService');
