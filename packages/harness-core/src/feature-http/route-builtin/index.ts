import { useAgentRoutes } from './agents';
import { useFeatureRoutes } from './features';
import { usePromptRoutes } from './prompts';
import { useSessionRoutes } from './sessions';

export const DEFAULT_HTTP_PREFIX = '/api/v1';

export function useFacadeRoutes(prefix: string = DEFAULT_HTTP_PREFIX): void {
  const base = prefix.replace(/\/+$/, '');
  useFeatureRoutes(base);
  useSessionRoutes(base);
  useAgentRoutes(base);
  usePromptRoutes(base);
}

export * from './features';
export * from './sessions';
export * from './agents';
export * from './prompts';
