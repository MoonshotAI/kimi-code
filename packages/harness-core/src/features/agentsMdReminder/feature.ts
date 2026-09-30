import {
  AgentPort,
  createFacadeToken,
  createFeature,
  useAgent,
  useAfterTool,
  useBeforeStep,
  useInject,
  type FeatureSpec,
} from '@moonshot-ai/agent-core';
import { useExpose } from '@moonshot-ai/agent-core/kernel/index';

import type { OsHost } from '#/features/os/host/index';

import { extractAgentsMdPathsFromSystemPrompt } from './agents-md-files';
import { openAgentsMdReminder } from './service';

export interface AgentsMdReminderFace {
  seed(paths: readonly string[]): void;
}

export const AgentsMdReminderRef = createFacadeToken<AgentsMdReminderFace>('agentsMdReminder');

export interface CreateAgentsMdReminderProps {
  readonly workDir: string;
  readonly host?: OsHost;
  readonly brandHome?: string;
}

export function createAgentsMdReminder(props: CreateAgentsMdReminderProps): FeatureSpec {
  return createFeature('agentsMdReminder', {
    agent() {
      if (props.host === undefined) return;
      const service = openAgentsMdReminder({
        agent: useAgent(),
        host: props.host,
        workDir: props.workDir,
        brandHome: props.brandHome,
      });
      const systemPrompt = useInject(AgentPort).getSystemPrompt();
      if (systemPrompt !== undefined) {
        const paths = extractAgentsMdPathsFromSystemPrompt(systemPrompt);
        if (paths.length > 0) service.seed(paths);
      }
      useAfterTool(service.afterTool);
      useBeforeStep(service.beforeStep);
      useExpose(AgentsMdReminderRef, { seed: service.seed });
    },
  });
}
