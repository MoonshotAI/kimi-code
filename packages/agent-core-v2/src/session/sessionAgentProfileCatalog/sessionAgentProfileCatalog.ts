/**
 * `sessionAgentProfileCatalog` domain (L3) — Session-scoped merged agent-profile
 * catalog contract.
 *
 * Defines the merged read view over the builtin (code-contribution) profiles
 * and the file-backed sources (user / extra / project / explicit), merged by
 * priority — higher-priority file sources win name collisions, while builtin
 * names require an explicit override opt-in. Consumers
 * (`IAgentProfileService.bind`, the `Agent` tool, the swarm scheduler) resolve
 * profiles through this view instead of the App-scope catalog so file-defined
 * agents are spawnable and bindable. Bound at Session scope.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';

export interface ISessionAgentProfileCatalog {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly onDidChange: Event<string>;
  get(name: string): AgentProfile | undefined;
  getDefault(): AgentProfile;
  list(): readonly AgentProfile[];
  load(): Promise<void>;
  reload(): Promise<void>;
}

export const ISessionAgentProfileCatalog =
  createDecorator<ISessionAgentProfileCatalog>('sessionAgentProfileCatalog');
