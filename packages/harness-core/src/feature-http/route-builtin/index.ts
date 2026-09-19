import { useAgentRoutes } from './agents';
import { useConfigRoutes } from './config';
import { useConnectionsRoutes } from './connections';
import { useFeatureRoutes } from './features';
import { useHealthRoutes } from './health';
import { useModelCatalogRoutes } from './model-catalog';
import { usePromptRoutes } from './prompts';
import { useSessionRoutes } from './sessions';
import { useShutdownRoutes } from './shutdown';
import { useToolsRoutes } from './tools';

export const DEFAULT_HTTP_PREFIX = '/api/v1';

export function useFacadeRoutes(prefix: string = DEFAULT_HTTP_PREFIX): void {
  const base = prefix.replace(/\/+$/, '');
  useHealthRoutes(base);
  useFeatureRoutes(base);
  useSessionRoutes(base);
  useAgentRoutes(base);
  usePromptRoutes(base);
  useModelCatalogRoutes(base);
  useConfigRoutes(base);
  useToolsRoutes(base);
  useShutdownRoutes(base);
  useConnectionsRoutes(base);
}

export * from './features';
export * from './sessions';
export * from './health';
export * from './agents';
export * from './prompts';
export * from './model-catalog';
export * from './config';
export * from './tools';
export * from './shutdown';
export * from './meta';
export * from './gui-store';
export * from './web-assets';
export * from './connections';
