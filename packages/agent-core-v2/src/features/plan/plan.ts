import { createDecorator } from '#/_base/di/instantiation';

import type { EnvironmentPath } from '#/environment/environment';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { PathClass } from '#/os/interface/hostEnvironment';

export interface PlanFileTarget {
  readonly fs: IHostFileSystem;
  readonly path: string;
  readonly environmentPath: EnvironmentPath;
  readonly pathClass: PathClass;
}

export type PlanData = null | {
  readonly id: string;
  readonly content: string;
  readonly path: string | null;
};

export type PlanFilePath = string | null;

export interface IAgentPlanService {
  readonly _serviceBrand: undefined;

  enter(id?: string, createFile?: boolean): Promise<void>;
  cancel(id?: string): void;
  clear(): Promise<void>;
  exit(id?: string): void;
  recordRevision(): Promise<void>;
  resolveFile(path: string, operation?: 'read' | 'write'): Promise<PlanFileTarget | undefined>;
  status(): Promise<PlanData>;
}

export const IAgentPlanService =
  createDecorator<IAgentPlanService>('agentPlanService');
