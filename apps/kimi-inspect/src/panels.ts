/**
 * Service panel descriptors — the handwritten *override* layer of the right
 * sidebar. The sidebar's baseline is the dynamic channel list served by
 * `GET /api/v1/debug/channels` (every wire-exposed Service with its methods);
 * a descriptor here replaces the generic card for its Service with a curated
 * one: a `fetch` that reads its inspectable state and optional `actions`
 * that trigger its methods. The generic `ServiceCard` renders them; adding a
 * curated panel is one entry here, no component code.
 *
 * Panels refresh manually (Load / Refresh buttons): the live event streams
 * that used to drive `refreshOn` refetches went away with the v2 socket
 * (`/api/v2/ws`).
 *
 * The proxies are typed by the real `agent-core-v2` contracts at the call
 * site, but panels treat them as `AnyService` so one descriptor shape covers
 * every Service.
 */

import { IAuthSummaryService } from '@moonshot-ai/agent-core-v2/app/auth/auth';
import { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import { IFlagService } from '@moonshot-ai/agent-core-v2/app/flag/flag';
import { IProviderService } from '@moonshot-ai/agent-core-v2/kosong/provider/provider';

import { ISessionApprovalService } from '@moonshot-ai/agent-core-v2/session/approval/approval';
import { ISessionInitService } from '@moonshot-ai/agent-core-v2/session/sessionInit/sessionInit';
import { ISessionInteractionService } from '@moonshot-ai/agent-core-v2/session/interaction/interaction';
import { ISessionMetadata } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { ISessionQuestionService } from '@moonshot-ai/agent-core-v2/session/question/question';
import { ISessionWorkspaceContext } from '@moonshot-ai/agent-core-v2/session/workspaceContext/workspaceContext';
import { IAgentActivityView } from '@moonshot-ai/agent-core-v2/agent/activityView/activityView';
import { IAgentContextSizeService } from '@moonshot-ai/agent-core-v2/agent/contextSize/contextSize';
import { IAgentGoalService } from '@moonshot-ai/agent-core-v2/agent/goal/goal';
import { IAgentMcpService } from '@moonshot-ai/agent-core-v2/agent/mcp/mcp';
import { IAgentPermissionModeService } from '@moonshot-ai/agent-core-v2/agent/permissionMode/permissionMode';
import { IAgentPermissionRulesService } from '@moonshot-ai/agent-core-v2/agent/permissionRules/permissionRules';
import { IAgentPlanService } from '@moonshot-ai/agent-core-v2/agent/plan/plan';
import { IAgentProfileService } from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import { IAgentRPCService } from '@moonshot-ai/agent-core-v2/agent/rpc/rpc';
import { IAgentSwarmService } from '@moonshot-ai/agent-core-v2/agent/swarm/swarm';
import { IAgentTaskService } from '@moonshot-ai/agent-core-v2/agent/task/task';
import { IAgentToolRegistryService } from '@moonshot-ai/agent-core-v2/agent/toolRegistry/toolRegistry';
import { IAgentUsageService } from '@moonshot-ai/agent-core-v2/agent/usage/usage';

/** Loosely-typed view of a scoped service proxy (every member is a remote call). */
export type AnyService = Record<string, (arg?: unknown) => Promise<unknown>>;

/** Invoke a method on a loose proxy; the proxy materializes every member. */
export function call(svc: AnyService, method: string, arg?: unknown): Promise<unknown> {
  const fn = svc[method];
  if (fn === undefined) {
    return Promise.reject(new Error(`no such method on proxy: ${method}`));
  }
  return fn(arg);
}

export interface PanelAction {
  readonly label: string;
  /** Prompt for one string input before running (raw string passed to `run`). */
  readonly input?: string;
  readonly danger?: boolean;
  readonly run: (svc: AnyService, input?: string) => unknown;
}

export interface ServicePanelDef {
  /** Decorator id / wire channel name, e.g. `sessionMetadata`. */
  readonly id: string;
  readonly label: string;
  /** Wire scope the Service is called on (`app` maps to the `core` route). */
  readonly scope: 'app' | 'session' | 'agent';
  readonly fetch?: (svc: AnyService) => Promise<unknown>;
  readonly actions?: readonly PanelAction[];
}

const setModeModes = ['manual', 'auto', 'yolo'];

export const CORE_PANELS: readonly ServicePanelDef[] = [
  {
    id: String(IConfigService),
    label: 'ConfigService',
    scope: 'app',
    fetch: async (svc) => ({
      config: await call(svc, 'getAll'),
      diagnostics: await call(svc, 'diagnostics'),
    }),
    actions: [{ label: 'reload', run: (svc) => call(svc, 'reload') }],
  },
  {
    id: String(IProviderService),
    label: 'ProviderService',
    scope: 'app',
    fetch: (svc) => call(svc, 'list'),
  },
  {
    id: String(IAuthSummaryService),
    label: 'AuthSummaryService',
    scope: 'app',
    fetch: (svc) => call(svc, 'summarize'),
  },
  {
    id: String(IFlagService),
    label: 'FlagService',
    scope: 'app',
    fetch: (svc) => call(svc, 'explainAll'),
  },
];

export const SESSION_PANELS: readonly ServicePanelDef[] = [
  {
    id: String(ISessionMetadata),
    label: 'SessionMetadata',
    scope: 'session',
    fetch: (svc) => call(svc, 'read'),
    actions: [
      { label: 'Set title', input: 'New title', run: (svc, title) => call(svc, 'setTitle', title) },
      { label: 'Archive', danger: true, run: (svc) => call(svc, 'setArchived', true) },
      { label: 'Unarchive', run: (svc) => call(svc, 'setArchived', false) },
    ],
  },
  {
    id: String(ISessionApprovalService),
    label: 'SessionApprovalService',
    scope: 'session',
    fetch: (svc) => call(svc, 'listPending'),
  },
  {
    id: String(ISessionQuestionService),
    label: 'SessionQuestionService',
    scope: 'session',
    fetch: (svc) => call(svc, 'listPending'),
  },
  {
    id: String(ISessionInteractionService),
    label: 'SessionInteractionService',
    scope: 'session',
    fetch: (svc) => call(svc, 'listPending'),
  },
  {
    id: String(ISessionWorkspaceContext),
    label: 'SessionWorkspaceContext',
    scope: 'session',
    fetch: async (svc) => ({
      workDir: await call(svc, 'workDir'),
      additionalDirs: await call(svc, 'additionalDirs'),
    }),
  },
  {
    id: String(ISessionInitService),
    label: 'SessionInitService',
    scope: 'session',
    actions: [{ label: 'generateAgentsMd (/init)', run: (svc) => call(svc, 'generateAgentsMd') }],
  },
];

export const AGENT_PANELS: readonly ServicePanelDef[] = [
  {
    id: String(IAgentActivityView),
    label: 'AgentActivityView',
    scope: 'agent',
    fetch: (svc) => call(svc, 'state'),
  },
  {
    id: String(IAgentProfileService),
    label: 'AgentProfileService',
    scope: 'agent',
    fetch: async (svc) => ({
      model: await call(svc, 'getModel'),
      hasModel: await call(svc, 'hasModel'),
      isRunnable: await call(svc, 'isRunnable'),
      data: await call(svc, 'data'),
    }),
    actions: [
      { label: 'Set model', input: 'Model id', run: (svc, model) => call(svc, 'setModel', model) },
      { label: 'Refresh system prompt', run: (svc) => call(svc, 'refreshSystemPrompt') },
    ],
  },
  {
    id: String(IAgentUsageService),
    label: 'AgentUsageService',
    scope: 'agent',
    fetch: (svc) => call(svc, 'status'),
  },
  {
    id: String(IAgentContextSizeService),
    label: 'AgentContextSizeService',
    scope: 'agent',
    fetch: (svc) => call(svc, 'get'),
  },
  {
    id: String(IAgentPermissionModeService),
    label: 'AgentPermissionModeService',
    scope: 'agent',
    fetch: (svc) => call(svc, 'mode'),
    actions: setModeModes.map((mode) => ({
      label: `setMode('${mode}')`,
      run: (svc) => call(svc, 'setMode', mode),
    })),
  },
  {
    id: String(IAgentPermissionRulesService),
    label: 'AgentPermissionRulesService',
    scope: 'agent',
    fetch: (svc) => call(svc, 'rules'),
  },
  {
    id: String(IAgentPlanService),
    label: 'AgentPlanService',
    scope: 'agent',
    fetch: (svc) => call(svc, 'status'),
    actions: [
      { label: 'enter', run: (svc) => call(svc, 'enter') },
      { label: 'cancel', run: (svc) => call(svc, 'cancel') },
      { label: 'clear', run: (svc) => call(svc, 'clear') },
    ],
  },
  {
    id: String(IAgentGoalService),
    label: 'AgentGoalService',
    scope: 'agent',
    fetch: (svc) => call(svc, 'getGoal'),
    actions: [
      { label: 'pause', run: (svc) => call(svc, 'pauseGoal', {}) },
      { label: 'resume', run: (svc) => call(svc, 'resumeGoal', {}) },
      { label: 'cancel', danger: true, run: (svc) => call(svc, 'cancelGoal', {}) },
    ],
  },
  {
    id: String(IAgentTaskService),
    label: 'AgentTaskService',
    scope: 'agent',
    fetch: (svc) => call(svc, 'list'),
    actions: [
      { label: 'Stop task', input: 'Task id', danger: true, run: (svc, id) => call(svc, 'stop', id) },
      { label: 'stopAll', danger: true, run: (svc) => call(svc, 'stopAll') },
    ],
  },
  {
    id: String(IAgentToolRegistryService),
    label: 'AgentToolRegistryService',
    scope: 'agent',
    fetch: async (svc) => {
      const tools = (await call(svc, 'list')) as readonly { name?: string }[];
      return { count: tools.length, names: tools.map((t) => t.name) };
    },
  },
  {
    id: String(IAgentMcpService),
    label: 'AgentMcpService',
    scope: 'agent',
    fetch: (svc) => call(svc, 'list'),
    actions: [
      { label: 'Reconnect server', input: 'Server name', run: (svc, name) => call(svc, 'reconnect', name) },
    ],
  },
  {
    id: String(IAgentSwarmService),
    label: 'AgentSwarmService',
    scope: 'agent',
    fetch: (svc) => call(svc, 'isActive'),
    actions: [
      { label: 'enter (manual)', run: (svc) => call(svc, 'enter', 'manual') },
      { label: 'exit', run: (svc) => call(svc, 'exit') },
    ],
  },
  {
    id: String(IAgentRPCService),
    label: 'AgentRPCService',
    scope: 'agent',
    actions: [
      { label: 'cancel turn', run: (svc) => call(svc, 'cancel', {}) },
      {
        label: 'undoHistory',
        input: 'Steps',
        run: (svc, n) => call(svc, 'undoHistory', { count: Number(n) }),
      },
    ],
  },
];
