/**
 * Service registration hub — imports every service-group module so its
 * `registerService` call runs at load time. Service groups create their
 * module files; this hub (owned by the main agent) imports them all.
 */

import './sessionIndex.js';
import './config.js'; // G1 — configService + bootstrapService
import './sessions.js'; // G2 — sessionLifecycleService + sessionMetadata
import './auth.js'; // G3 — oauthService + authSummaryService
import './flagsCatalog.js'; // G4 — flagService + modelService + modelResolver + providerService + providerDiscovery
import './pluginsWorkspaces.js'; // G5 — pluginService + workspaceService + hostFolderBrowser
import './interaction.js'; // S1+S2 — sessionInteractionService + sessionQuestionService + sessionApprovalService
import './agentServices.js'; // A1+A2 — agentPlanService + agentProfileService + agentShellCommandService + agentTaskService
import './usage.js'; // A3 — agentUsageService + agentRPCService
