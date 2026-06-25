import { createDecorator } from '../../../di';

export type PlanData = null | {
  readonly id: string;
  readonly content: string;
  readonly path: string;
};

export type PlanFilePath = string | null;

export interface IPlanModeService {
  readonly _serviceBrand: undefined;
  readonly isActive: boolean;
  readonly planFilePath: PlanFilePath;
  enter(id?: string, createFile?: boolean): Promise<void>;
  cancel(id?: string): void;
  clear(): Promise<void>;
  exit(id?: string): void;
  data(): Promise<PlanData>;
}

declare module '../types' {
  interface WireRecordMap {
    'plan_mode.enter': {
      id: string;
    };
    'plan_mode.cancel': {
      id?: string;
    };
    'plan_mode.exit': {
      id?: string;
    };
  }

}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IPlanModeService =
  createDecorator<IPlanModeService>('agentPlanModeService');
