import type { ContextMessage } from '#/agent/contextMemory/types';
import type { Message } from '#human/llm/message';
import {
  project,
  projectStrict,
  type OnAnomaly,
  type ProjectionAnomaly,
} from './projection';

export class AgentLoopProjector {
  constructor(private readonly onRepair: (anomalies: readonly ProjectionAnomaly[]) => void) {}

  project(messages: readonly ContextMessage[], strict = false): readonly Message[] {
    return this.projectWithTrace(messages, strict ? projectStrict : project);
  }

  private projectWithTrace(
    messages: readonly ContextMessage[],
    fn: (history: readonly ContextMessage[], onAnomaly?: OnAnomaly) => Message[],
  ): readonly Message[] {
    const anomalies: ProjectionAnomaly[] = [];
    const result = fn(messages, (anomaly) => anomalies.push(anomaly));
    this.onRepair(anomalies);
    return result;
  }
}
