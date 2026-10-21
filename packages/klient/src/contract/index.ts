import type { KlientContract } from './types.js';
import {
  agentCommandContract,
  agentContextMemoryContract,
  agentFullCompactionContract,
  agentLoopContract,
  agentMcpContract,
  agentPermissionModeContract,
  agentPlanContract,
  agentRuntimeBindingContract,
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
import { registryImportContract } from './global/registryImport.js';
import { configContract } from './global/config.js';
import { envContract } from './global/env.js';
import { filesContract } from './global/files.js';
import { flagsContract } from './global/flags.js';
import { hostFsContract } from './global/hostFs.js';
import { modelsContract } from './global/models.js';
import { mcpManagementContract } from './global/mcpManagement.js';
import { pluginsContract } from './global/plugins.js';
import { providersContract } from './global/providers.js';
import { sessionsContract } from './global/sessions.js';
import { workspacesContract } from './global/workspaces.js';
import { sessionApprovalContract } from './session/approval.js';
import { sessionActivityViewContract } from './session/activity.js';
import { sessionInteractionContract } from './session/interaction.js';
import { sessionManagerContract } from './session/lifecycle.js';
import { sessionMetadataContract } from './session/metadata.js';
import { sessionQuestionContract } from './session/question.js';
import { sessionSkillCatalogContract } from './session/skills.js';
import { sessionTitleContract } from './session/title.js';

export const globalContract: KlientContract = {
  sessionIndex: sessionsContract,
  workspaceService: workspacesContract,
  configService: configContract,
  providerService: providersContract,
  modelService: modelsContract,
  modelResolver: catalogContract,
  providerDiscovery: providerDiscoveryContract,
  modelsDevImport: registryImportContract,
  oauthService: authContract,
  authSummaryService: authSummaryContract,
  flagService: flagsContract,
  pluginService: pluginsContract,
  capabilityService: capabilitiesContract,
  hostFolderBrowser: hostFsContract,
  bootstrapService: envContract,
  fileService: filesContract,
  mcpManagementService: mcpManagementContract,
  sessionManager: sessionManagerContract,
  sessionMetadata: sessionMetadataContract,
  sessionInteractionService: sessionInteractionContract,
  sessionApprovalService: sessionApprovalContract,
  sessionQuestionService: sessionQuestionContract,
  sessionSkillCatalog: sessionSkillCatalogContract,
  sessionTitleService: sessionTitleContract,
  sessionActivityView: sessionActivityViewContract,
  agentPromptService: agentPromptContract,
  agentSkillService: agentSkillContract,
  agentLoopService: agentLoopContract,
  agentPermissionModeService: agentPermissionModeContract,
  agentCommandService: agentCommandContract,
  agentRuntimeBindingService: agentRuntimeBindingContract,
  agentContextMemoryService: agentContextMemoryContract,
  agentTokenCountingService: agentTokenCountingContract,
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
