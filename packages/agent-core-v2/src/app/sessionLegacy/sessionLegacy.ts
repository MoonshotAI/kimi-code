/**
 * `sessionLegacy` domain (L7 edge adapter) — v1-compatible session actions.
 *
 * Implements `POST /sessions/{id}/profile` (`updateProfile` — title rename,
 * metadata merge, and the cross-domain `agent_config` patch),
 * `GET /sessions/{id}/status` (`status`), and `GET /sessions/{id}/goal`
 * (`goal`) on top of the native v2 services
 * (`ISessionLifecycleService`, `IAgentProfileService`, …).
 *
 * The thin pass-through actions (`fork` / `compact` / `abort` / `archive`), the
 * `:undo` action, and the `/sessions/{id}/children` endpoints are deliberately
 * NOT wrapped here: the edge route calls the native services directly —
 * `ISessionLifecycleService.fork` / `archive` / `createChild`,
 * `IAgentFullCompactionService.begin`, `IAgentRPCService.cancel`,
 * `IAgentPromptService.undo`, and `ISessionIndex.list({ childOf })` — because
 * none of them carries v1-only projection worth centralizing beyond what the
 * native services already provide. Only `updateProfile`, `status`, and `goal`
 * stay in this adapter (the `agent_config` patch, the best-effort status
 * rollup, and the current-goal read). The native services
 * keep serving `/api/v2` and are left untouched; this adapter exists only so
 * clients of the v1 server keep working against server-v2. Bound at App scope —
 * it is a stateless dispatcher that resolves the target session/agent per call.
 */

import type {
  GoalSnapshot,
  SessionStatusResponse,
  UpdateSessionProfileRequest,
} from '@moonshot-ai/protocol';

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
