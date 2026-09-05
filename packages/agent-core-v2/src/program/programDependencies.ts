import type { LiveRef } from '#/_base/di/instantiation';
import type { ILogService } from '#/_base/log/log';
import type { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import type { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import type { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IConfigService } from '#/app/config/config';
import type { IGitService } from '#/app/git/git';
import type { McpOAuthService } from '#/mcpCore/oauth/service';
import type { IMcpConfigStore } from '#/app/mcpConfig/configStore';
import type { IPluginService } from '#/app/plugin/plugin';
import type { ISessionManager } from '#/app/sessionManager/sessionManager';
import type { IBuiltinSkillSource } from '#/features/skill/catalog/builtinSkillSource';
import type { IAppStateService } from '#/app/state/appState';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import type { IExtraAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoader';
import type { IExplicitAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoader';
import type { IPluginAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/pluginAgentProfileLoader';
import type { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import type { IWorkspaceAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader';
import type { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import type { IWorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructions';
import type { IWorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcp';
import type { IWorkspaceSkillCatalog } from '#/features/skill/workspace/workspaceSkillCatalog';

export interface ProgramSessionControllerInput {
  readonly context: IWorkspaceContext;
  readonly fs: IHostFileSystem;
  readonly workspaceAgentProfiles: IWorkspaceAgentProfileLoader;
  readonly extraAgentProfiles: IExtraAgentProfileLoader;
  readonly explicitAgentProfiles: IExplicitAgentProfileLoader;
  readonly userAgentProfiles: IUserAgentProfileLoader;
  readonly pluginAgentProfiles: IPluginAgentProfileLoader;
  readonly dirs: IWorkspaceDirs;
  readonly skills: IWorkspaceSkillCatalog;
  readonly instructions: IWorkspaceInstructionsService;
  readonly mcp: IWorkspaceMcpService;
  readonly onDispose: () => void;
}

export interface ProgramDependencies {
  readonly appState: IAppStateService;
  readonly bootstrap: IBootstrapService;
  readonly config: IConfigService;
  readonly git: LiveRef<IGitService>;
  readonly identity: IAgentIdentity;
  readonly log: ILogService;
  readonly oauth: McpOAuthService;
  readonly configStore: IMcpConfigStore;
  readonly plugins: IPluginService;
  readonly sessionManager: LiveRef<ISessionManager>;
  readonly agentProfiles: IAgentProfileRegistry;
  readonly builtinAgentProfiles: IBuiltinAgentProfileLoader;
  readonly builtinSkills: IBuiltinSkillSource;
  readonly telemetry: ITelemetryService;
  readonly docs: IAtomicDocumentStore;
  createSessionController(input: ProgramSessionControllerInput): SessionLifecycleService;
}
