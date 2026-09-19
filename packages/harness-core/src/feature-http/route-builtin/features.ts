import { Features, useApp, type FeatureSpec, type FeatureTier } from '@moonshot-ai/agent-core';
import { inject, toValue } from '@moonshot-ai/agent-core/kernel/index';

import { useHttpRoute } from '../feature';
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
  useHttpRoute({
    id: 'features.reflect',
    method: 'GET',
    path: `${prefix}/features`,
    handler: (request, response) => {
      const app = useApp();
      sendOk(request, response, {
        features: featureNames(toValue(inject(Features)), 'app'),
        sessions: app.list().flatMap((sessionId) => {
          const session = app.get(sessionId);
          if (session === undefined) {
            return [];
          }
          return [{
            id: sessionId,
            features: featureNames(toValue(session.resolve(Features)), 'session'),
            agents: session.list().flatMap((agentId) => {
              const agent = session.get(agentId);
              if (agent === undefined) {
                return [];
              }
              return [{
                id: agentId,
                features: featureNames(toValue(agent.resolve(Features)), 'agent'),
              }];
            }),
          }];
        }),
      } satisfies FeatureReflectView);
    },
  });
}

function featureNames(features: readonly FeatureSpec[], tier: FeatureTier): string[] {
  return features
    .filter((feature) => feature.slots[tier] !== undefined)
    .map((feature) => feature.featureName);
}
