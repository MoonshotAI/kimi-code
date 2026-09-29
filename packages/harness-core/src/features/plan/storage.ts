export interface PlanStorage {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  pathFor(agentId: string, planId: string): string;
}

export interface PlanData {
  readonly id: string;
  readonly content: string;
  readonly path: string;
}

export interface MemoryPlanStorage extends PlanStorage {
  readonly files: Map<string, string>;
}

export function createMemoryPlanStorage(): MemoryPlanStorage {
  const files = new Map<string, string>();
  return {
    files,
    readText: async (path) => files.get(path) ?? '',
    writeText: async (path, content) => {
      files.set(path, content);
    },
    pathFor: (agentId, planId) => `agents/${agentId}/plans/${planId}.md`,
  };
}
