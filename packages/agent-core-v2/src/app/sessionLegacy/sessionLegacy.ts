/**
 * `sessionLegacy` domain (L7 edge adapter) — v1-compatible session reads.
 *
 * Implements `GET /sessions/{id}/status` (`status` — the best-effort status
 * rollup) and `GET /sessions/{id}/goal` (`goal` — the current-goal read), the
 * two endpoints that hold real cross-domain adaptation. Everything else is
 * deliberately NOT wrapped here: the thin pass-through actions (`fork` /
 * `compact` / `abort` / `archive`), the `:undo` action, the
 * `/sessions/{id}/children` endpoints, and `POST /sessions/{id}/profile`
 * (title/metadata patch and `agent_config` dispatch) are plain wire-to-native
 * translations composed by the kap-server routes directly. `SessionWireFields`
 * stays exported here as the profile route's projection shape, consumed by the
 * kap-server helper (`routes/sessionProfile.ts`) via deep-path import. Bound
 * at App scope — it is a stateless dispatcher that resolves the target
 * session/agent per call.
 */

import type { GoalSnapshot } from '#/agent/goal/types';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { SessionStatusResponse } from './sessionProtocol';

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

  status(sessionId: string): Promise<SessionStatusResponse>;
  goal(sessionId: string): Promise<GoalSnapshot | null>;
}

export const ISessionLegacyService: ServiceIdentifier<ISessionLegacyService> =
  createDecorator<ISessionLegacyService>('sessionLegacyService');
