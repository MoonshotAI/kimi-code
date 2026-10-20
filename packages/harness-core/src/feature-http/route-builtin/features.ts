import { useApp, type Feature, type FeatureLevel } from '@moonshot-ai/agent-core/app/index';

import { useHttpRoute } from '../scope';
import { sendOk } from '../route/http';

export interface FeatureReflectView {
  readonly features: string[];
  readonly sessions: readonly SessionFeatureView[];
}

export interface SessionFeatureView {
  readonly id: string;
  readonly features: string[];
  readonly agents: readonly AgentFeatureView[];
}

export interface AgentFeatureView {
  readonly id: string;
  readonly features: string[];
}

export function useFeatureRoutes(prefix: string): void {
  const app = useApp();
  useHttpRoute({
    id: 'features.reflect',
    method: 'GET',
    path: `${prefix}/features`,
    handler: (request, response) => {
      sendOk(request, response, {
        features: featureNames(app.features.list(), 'app'),
        sessions: [...app.sessions.values()].map((session) => ({
          id: session.id,
          features: featureNames(app.features.list({ session: session.id }), 'session'),
          agents: [...session.agents.keys()].map((agentId) => ({
            id: agentId,
            features: featureNames(app.features.list({ session: session.id, agent: agentId }), 'agent'),
          })),
        })),
      } satisfies FeatureReflectView);
    },
  });
}

function featureNames(features: readonly Feature[], level: FeatureLevel): string[] {
  return features
    .filter((feature) => feature.units[level] !== undefined)
    .map((feature) => feature.name);
}
