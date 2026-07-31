/**
 * `workspaceAgentProfileLoader` domain — `IUserAgentProfileLoader` contract.
 *
 * The user loader of the agent-profile extension point: owns the `user`
 * contribution in the App-scope `IAgentProfileRegistry` — the agent files
 * discovered from the user agent roots under the os home, plus the
 * `<home>/SYSTEM.md` prompt-override profile appended after them — tagged
 * with this handler's `workspaceId`. Also exposes the effective default
 * profile (the `SYSTEM.md` override when present, else the builtin default,
 * refreshed on each load pass) for backing `${base_prompt}`. `ready` tracks
 * the most recent discovery pass; `reload()` re-discovers and re-registers.
 * Workspace-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';

export interface IUserAgentProfileLoader {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  getDefaultProfile(): AgentProfile;
  reload(): Promise<void>;
}

export const IUserAgentProfileLoader: ServiceIdentifier<IUserAgentProfileLoader> =
  createDecorator<IUserAgentProfileLoader>('userAgentProfileLoader');
