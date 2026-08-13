/**
 * The aggregated klient contract — service wire name → method → zod
 * input/output schemas, across the core/session/agent scopes. The klient
 * factory validates every call against this table; transports never see it.
 * Event registrations live in the per-scope `events.ts` files alongside
 * their payload schemas.
 */

import type { KlientContract } from './types.js';
import { agentActivityViewContract } from './agent/activity.js';
import {
  agentCommandContract,
  agentContextMemoryContract,
  agentFullCompactionContract,
  agentLoopContract,
  agentMcpContract,
  agentPermissionModeContract,
  agentPlanContract,
  agentProfileContract,
  agentPromptContract,
  agentShellCommandContract,
  agentSkillContract,
  agentTaskContract,
  agentTokenCountingContract,
  agentUsageContract,
} from './agent/services.js';
import { authContract, authSummaryContract } from './global/auth.js';
import { capabilitiesContract } from './global/capabilities.js';
import { catalogContract } from './global/catalog.js';
import { providerDiscoveryContract } from './global/providerDiscovery.js';
import { configContract } from './global/config.js';
import { envContract } from './global/env.js';
import { flagsContract } from './global/flags.js';
import { hostFsContract } from './global/hostFs.js';
import { modelsContract } from './global/models.js';
import { pluginsContract } from './global/plugins.js';
import { providersContract } from './global/providers.js';
import { sessionsContract } from './global/sessions.js';
import { workspacesContract } from './global/workspaces.js';
import { sessionApprovalContract } from './session/approval.js';
import { sessionInteractionContract } from './session/interaction.js';
import {
  sessionLifecycleContract,
  workspaceLifecycleContract,
} from './session/lifecycle.js';
import { sessionMetadataContract } from './session/metadata.js';
import { sessionQuestionContract } from './session/question.js';
import { sessionSkillCatalogContract } from './session/skills.js';

export const globalContract: KlientContract = {
  // core (app scope)
  sessionIndex: sessionsContract,
  workspaceService: workspacesContract,
  configService: configContract,
  providerService: providersContract,
  modelService: modelsContract,
  modelResolver: catalogContract,
  providerDiscovery: providerDiscoveryContract,
  oauthService: authContract,
  authSummaryService: authSummaryContract,
  flagService: flagsContract,
  pluginService: pluginsContract,
  capabilityService: capabilitiesContract,
  hostFolderBrowser: hostFsContract,
  bootstrapService: envContract,
  // workspace scope (+ the app-registered handler registry)
  workspaceLifecycleService: workspaceLifecycleContract,
  sessionLifecycleService: sessionLifecycleContract,
  // session scope
  sessionMetadata: sessionMetadataContract,
  sessionInteractionService: sessionInteractionContract,
  sessionApprovalService: sessionApprovalContract,
  sessionQuestionService: sessionQuestionContract,
  sessionSkillCatalog: sessionSkillCatalogContract,
  // agent scope
  agentPromptService: agentPromptContract,
  agentSkillService: agentSkillContract,
  agentLoopService: agentLoopContract,
  agentPermissionModeService: agentPermissionModeContract,
  agentCommandService: agentCommandContract,
  agentContextMemoryService: agentContextMemoryContract,
  agentTokenCountingService: agentTokenCountingContract,
  agentActivityView: agentActivityViewContract,
  agentShellCommandService: agentShellCommandContract,
  agentProfileService: agentProfileContract,
  agentUsageService: agentUsageContract,
  agentPlanService: agentPlanContract,
  agentTaskService: agentTaskContract,
  agentMcpService: agentMcpContract,
  agentFullCompactionService: agentFullCompactionContract,
};

export type { KlientContract, ProcedureContract, ServiceContract, StreamingProcedureContract } from './types.js';
export { isStreamingContract } from './types.js';
