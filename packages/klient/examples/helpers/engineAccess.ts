/**
 * Host-side engine access for the klient examples (memory transport).
 *
 * klient never imports the retired `@moonshot-ai/agent-core-v2` package —
 * the transports take the DI token map and the `main`-agent materializer via
 * `MemoryEngineAccess`. This module builds that glue from the engine package,
 * exactly like `test/helpers/engine.ts` does for the test suites.
 */

import { IAgentLifecycleService } from '@moonshot-ai/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { ensureMainAgent } from '@moonshot-ai/agent-core-v2/session/agentLifecycle/mainAgent';
import { ISessionIndex } from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import { IWorkspaceService } from '@moonshot-ai/agent-core-v2/app/workspace/workspace';
import { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import { IModelService } from '@moonshot-ai/agent-core-v2/kosong/model/model';
import { IModelCatalog } from '@moonshot-ai/agent-core-v2/kosong/model/catalog';
import { IProviderDiscoveryService } from '@moonshot-ai/agent-core-v2/app/kosongConfig/discovery';
import { IProviderService } from '@moonshot-ai/agent-core-v2/kosong/provider/provider';
import {
  IAuthSummaryService,
  IOAuthService,
} from '@moonshot-ai/agent-core-v2/app/auth/auth';
import { IFlagService } from '@moonshot-ai/agent-core-v2/app/flag/flag';
import { IPluginService } from '@moonshot-ai/agent-core-v2/app/plugin/plugin';
import { IBootstrapService } from '@moonshot-ai/agent-core-v2/app/bootstrap/bootstrap';
import { IEventService } from '@moonshot-ai/agent-core-v2/app/event/event';
import { IEventBus } from '@moonshot-ai/agent-core-v2/app/event/eventBus';
import { IHostFolderBrowser } from '@moonshot-ai/agent-core-v2/app/hostFolderBrowser/hostFolderBrowser';
import { ISessionLifecycleService } from '@moonshot-ai/agent-core-v2/app/sessionLifecycle/sessionLifecycle';
import { ISessionMetadata } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { ISessionInteractionService } from '@moonshot-ai/agent-core-v2/session/interaction/interaction';
import { ISessionApprovalService } from '@moonshot-ai/agent-core-v2/session/approval/approval';
import { ISessionQuestionService } from '@moonshot-ai/agent-core-v2/session/question/question';
import { IAgentRPCService } from '@moonshot-ai/agent-core-v2/agent/rpc/rpc';
import { IAgentActivityView } from '@moonshot-ai/agent-core-v2/agent/activityView/activityView';
import { IAgentPlanService } from '@moonshot-ai/agent-core-v2/agent/plan/plan';
import { IAgentProfileService } from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import { IAgentShellCommandService } from '@moonshot-ai/agent-core-v2/agent/shellCommand/shellCommand';
import { IAgentTaskService } from '@moonshot-ai/agent-core-v2/agent/task/task';
import { IAgentUsageService } from '@moonshot-ai/agent-core-v2/agent/usage/usage';

import type { MemoryEngineAccess, ScopeLike } from '../../src/transports/memory/engine.js';

/** Build the wire service-name → engine DI token map for the in-process transports. */
export function buildEngineAccess(): MemoryEngineAccess {
  return {
    serviceTokens: {
      sessionIndex: ISessionIndex,
      workspaceService: IWorkspaceService,
      configService: IConfigService,
      modelService: IModelService,
      modelResolver: IModelCatalog,
      providerDiscovery: IProviderDiscoveryService,
      providerService: IProviderService,
      oauthService: IOAuthService,
      authSummaryService: IAuthSummaryService,
      flagService: IFlagService,
      pluginService: IPluginService,
      hostFolderBrowser: IHostFolderBrowser,
      bootstrapService: IBootstrapService,
      sessionLifecycleService: ISessionLifecycleService,
      sessionMetadata: ISessionMetadata,
      sessionInteractionService: ISessionInteractionService,
      sessionApprovalService: ISessionApprovalService,
      sessionQuestionService: ISessionQuestionService,
      agentRPCService: IAgentRPCService,
      agentActivityView: IAgentActivityView,
      agentShellCommandService: IAgentShellCommandService,
      agentProfileService: IAgentProfileService,
      agentUsageService: IAgentUsageService,
      agentPlanService: IAgentPlanService,
      agentTaskService: IAgentTaskService,
    },
    eventServiceToken: IEventService,
    eventBusToken: IEventBus,
    sessionInteractionServiceToken: ISessionInteractionService,
    sessionLifecycleServiceToken: ISessionLifecycleService,
    agentLifecycleServiceToken: IAgentLifecycleService,
    ensureMainAgent: (session: ScopeLike) =>
      ensureMainAgent(session as Parameters<typeof ensureMainAgent>[0]),
  };
}
