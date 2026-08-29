export interface CronTask {
  readonly id: string;
  readonly cron: string;
  readonly prompt: string;
  readonly createdAt: number;
  readonly recurring?: boolean;
  readonly lastFiredAt?: number;
  readonly tags?: Readonly<Record<string, string>>;
}

export type CronTaskInit = Omit<CronTask, 'id' | 'createdAt'>;
