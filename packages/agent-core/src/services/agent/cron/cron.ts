import type { ContentPart } from '@moonshot-ai/kosong';

import { createDecorator } from '../../../di';
import type { ClockSources } from '../../../tools/cron/clock';
import type { SessionCronTaskInit } from '../../../tools/cron/session-store';
import type { CronTask, CronToolManager } from '../../../tools/cron/types';
import type { Turn } from '../types';

export type CronTaskInit = SessionCronTaskInit;

export interface CronPersistence {
  list(): Promise<readonly CronTask[]>;
  write(id: string, task: CronTask): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface CronOptions {
  readonly persistence?: CronPersistence;
  readonly homedir?: string;
  readonly isSubagent?: boolean;
  readonly clocks?: ClockSources;
  readonly pollIntervalMs?: number | null;
  readonly autoStart?: boolean;
  readonly registerTools?: boolean;
  readonly onPersistenceError?: (error: unknown, taskId: string) => void;
}

export interface CronLoadOptions {
  readonly replace?: boolean;
}

export interface CronFireOptions {
  readonly coalescedCount?: number;
  readonly firedAt?: number;
}

export interface ICronService extends CronToolManager {
  readonly _serviceBrand: undefined;
  readonly isEnabled: boolean;
  getTask(id: string): CronTask | undefined;
  list(): readonly CronTask[];
  loadFromDisk(options?: CronLoadOptions): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  tick(): void;
  getNextFireTime(): number | null;
  fire(id: string, options?: CronFireOptions): Turn | undefined;
  handleMissed(
    tasks: readonly CronTask[],
    renderMissedNotification: (
      tasks: readonly CronTask[],
    ) => readonly ContentPart[],
  ): Turn | undefined;
  flushPersist(): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ICronService = createDecorator<ICronService>('agentCronService');
