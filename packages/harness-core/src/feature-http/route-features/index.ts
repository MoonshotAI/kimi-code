import { useBtwRoutes } from './btw';
import { useAuthRoutes } from './auth';
import { useCapabilitiesRoutes } from './capabilities';
import { useCompactionRoutes } from './compaction';
import { useFileHistoryRoutes } from './fileHistory';
import { useFsRoutes } from './fs';
import { useGoalRoutes } from './goal';
import { useInteractionRoutes } from './interaction';
import { useMcpRoutes } from './mcp';
import { useModelsDevRoutes } from './models-dev';
import { usePluginRoutes } from './plugin';
import { useRemoteControlRoutes } from './remote-control';
import { useSessionExportRoutes } from './sessionExport';
import { useSessionTitleRoutes } from './sessionTitle';
import { useSkillRoutes } from './skill';
import { useStatusRoutes } from './status';
import { useTaskRoutes } from './task';
import { useWorkspaceRoutes } from './workspaces';

export function useFeatureFacadeRoutes(prefix: string): void {
  const base = prefix.replace(/\/+$/, '');
  useSessionTitleRoutes(base);
  useSessionExportRoutes(base);
  useStatusRoutes(base);
  useGoalRoutes(base);
  useSkillRoutes(base);
  useTaskRoutes(base);
  useInteractionRoutes(base);
  useRemoteControlRoutes(base);
  useModelsDevRoutes(base);
  usePluginRoutes(base);
  useMcpRoutes(base);
  useCompactionRoutes(base);
  useBtwRoutes(base);
  useWorkspaceRoutes(base);
  useFsRoutes(base);
  useCapabilitiesRoutes(base);
  useAuthRoutes(base);
  useFileHistoryRoutes(base);
}

export * from './sessionTitle';
export * from './sessionExport';
export * from './status';
export * from './goal';
export * from './skill';
export * from './task';
export * from './interaction';
export * from './remote-control';
export * from './models-dev';
export * from './plugin';
export * from './mcp';
export * from './compaction';
export * from './btw';
export * from './workspaces';
export * from './fs';
export * from './capabilities';
export * from './fileHistory';

