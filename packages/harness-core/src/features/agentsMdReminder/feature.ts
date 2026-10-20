import {
  createFeature,
  useAgent,
  useStepStarting,
  useToolEnding,
  type Feature,
} from '@moonshot-ai/agent-core/app/index';
import { createFacadeToken, useExpose } from '@moonshot-ai/agent-core/kernel/index';
import type { Agent } from '@moonshot-ai/agent-core/session/index';

import type { OsHost } from '#/features/os/host/index';
import { useLoopEvent } from '#/runtime/index';

import { extractAgentsMdPathsFromSystemPrompt } from './agents-md-files';
import { openAgentsMdReminder, type AgentsMdReminderService } from './service';

export interface AgentsMdReminderFace {
  seed(paths: readonly string[]): void;
}

export const AgentsMdReminderRef = createFacadeToken<AgentsMdReminderFace>('agentsMdReminder');

export interface CreateAgentsMdReminderProps {
  readonly workDir: string;
  readonly host?: OsHost;
  readonly brandHome?: string;
}

export function createAgentsMdReminder(props: CreateAgentsMdReminderProps): Feature<void> {
  const services = new WeakMap<Agent, AgentsMdReminderService>();
  return createFeature('agentsMdReminder', {
    agent() {
      if (props.host === undefined) return;
      const host = props.host;
      const agent = useAgent();
      const memoized = services.get(agent);
      const service =
        memoized ??
        openAgentsMdReminder({
          agent,
          host,
          workDir: props.workDir,
          brandHome: props.brandHome,
        });
      if (memoized === undefined) services.set(agent, service);
      const seedFromSystemPrompt = (systemPrompt: string | undefined): void => {
        if (systemPrompt === undefined) return;
        const paths = extractAgentsMdPathsFromSystemPrompt(systemPrompt);
        if (paths.length > 0) service.seed(paths);
      };
      seedFromSystemPrompt(agent.loop.state.profile.systemPrompt);
      useLoopEvent('system_prompt.settled', ({ systemPrompt }) => {
        seedFromSystemPrompt(systemPrompt);
      });
      useToolEnding(service.toolEnding);
      useStepStarting(service.stepStarting);
      useExpose(AgentsMdReminderRef, { seed: (paths) => service.seed(paths) });
    },
  });
}
