/**
 * `sessionLegacy` domain (L7 edge adapter) — v1-compatible session actions.
 *
 * Implements `POST /sessions/{id}/profile` (`updateProfile` — title rename,
 * metadata merge, and the cross-domain `agent_config` patch),
 * `GET /sessions/{id}/status` (`status`), and `GET /sessions/{id}/goal`
 * (`goal`). The thin pass-through actions (`fork` / `compact` / `abort` /
 * `archive`), the `:undo` action, and the `/sessions/{id}/children` endpoints
 * are deliberately NOT wrapped here because none of them carries v1-only
 * projection worth centralizing; only `updateProfile`, `status`, and `goal`
 * stay in this adapter (the `agent_config` patch, the best-effort status
 * rollup, and the current-goal read). Bound at App scope — it is a stateless
 * dispatcher that resolves the target session/agent per call.
 */

import type { GoalSnapshot } from '#/agent/goal/types';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { SessionStatusResponse, UpdateSessionProfileRequest } from './sessionProtocol';

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

  updateProfile(sessionId: string, body: UpdateSessionProfileRequest): Promise<SessionWireFields>;
  status(sessionId: string): Promise<SessionStatusResponse>;
  goal(sessionId: string): Promise<GoalSnapshot | null>;
}

export const ISessionLegacyService: ServiceIdentifier<ISessionLegacyService> =
  createDecorator<ISessionLegacyService>('sessionLegacyService');
