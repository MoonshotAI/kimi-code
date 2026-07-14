/**
 * `agentLifecycle` domain (L6) — main-agent bootstrap helper.
 *
 * The main agent is an ordinary agent whose only distinction is
 * `agentId === 'main'`; `IAgentLifecycleService` itself knows nothing about
 * it. What *is* main-specific is session bootstrap business: the plugin
 * session-start service registers main-agent-only plugin guidance (matching
 * v1's `pluginSessionStarts: type === 'main' ? … : undefined`) and the
 * session cron service registers main-agent-only cron tools before the
 * main-created notification fires. `ensureMainAgent` concentrates that
 * business in one place so every bootstrapper (session resume, legacy
 * session/message services, the server edge) creates the main agent the same
 * way.
 *
 * Not a Service: a pure composition helper over the session handle.
 */

import type { ISessionScopeHandle, IAgentScopeHandle } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { DEFAULT_PERMISSION_MODE_SECTION } from '#/agent/permissionMode/configSection';
import { IAgentPluginService } from '#/agent/plugin/agentPlugin';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import type { BindAgentInput } from '#/agent/profile/profile';
import { ISessionCronService } from '#/session/cron/sessionCronService';

import { IAgentLifecycleService } from './agentLifecycle';

export const MAIN_AGENT_ID = 'main';

export interface EnsureMainAgentOptions {
  readonly binding?: BindAgentInput;
  readonly permissionMode?: PermissionMode;
}

export async function ensureMainAgent(
  session: ISessionScopeHandle,
  opts?: EnsureMainAgentOptions,
): Promise<IAgentScopeHandle> {
  const agents = session.accessor.get(IAgentLifecycleService);
  session.accessor.get(ISessionCronService);
  const existing = await agents.whenReady(MAIN_AGENT_ID);
  if (existing !== undefined) return existing;
  const permissionMode =
    opts?.permissionMode ??
    session.accessor.get(IConfigService).get<PermissionMode>(DEFAULT_PERMISSION_MODE_SECTION);
  const main = await agents.create({
    agentId: MAIN_AGENT_ID,
    binding: opts?.binding,
    permissionMode,
  });
  main.accessor.get(IAgentPluginService);
  agents.notifyMainCreated(main);
  return main;
}
