/**
 * `sessionLegacy` domain (L7 edge adapter) — v1-compatible session actions.
 *
 * Implements `POST /sessions/{id}/profile` (`updateProfile` — title rename,
 * metadata merge, and the cross-domain `agent_config` patch) and
 * `GET /sessions/{id}/status` (`status`) on top of the native v2 services
 * (`ISessionLifecycleService`, `IAgentProfileService`, …).
 *
 * The thin pass-through actions (`fork` / `compact` / `abort` / `archive`), the
 * `:undo` action, and the `/sessions/{id}/children` endpoints are deliberately
 * NOT wrapped here: the edge route calls the native services directly —
 * `ISessionLifecycleService.fork` / `archive` / `createChild`,
 * `IAgentFullCompactionService.begin`, `IAgentRPCService.cancel`,
 * `IAgentPromptService.undo`, and `ISessionIndex.list({ childOf })` — because
 * none of them carries v1-only projection worth centralizing beyond what the
 * native services already provide. Only `updateProfile` and `status` hold real
 * cross-domain adaptation logic (the `agent_config` patch and the
 * best-effort status rollup), so they stay in this adapter. The native services
 * keep serving `/api/v2` and are left untouched; this adapter exists only so
 * clients of the v1 server keep working against server-v2. Bound at App scope —
 * it is a stateless dispatcher that resolves the target session/agent per call.
 */

import type { SessionStatusResponse, UpdateSessionProfileRequest } from '@moonshot-ai/protocol';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

/**
 * Raw fields the route projects into the wire `Session` (via `toWireSession`).
 * Kept protocol-free so the edge projection stays in the server layer.
 */
export interface SessionWireFields {
  readonly id: string;
  readonly workspaceId: string;
  /** Workspace root — used as `cwd` when projecting to the wire `Session`. */
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
}

export const ISessionLegacyService: ServiceIdentifier<ISessionLegacyService> =
  createDecorator<ISessionLegacyService>('sessionLegacyService');
