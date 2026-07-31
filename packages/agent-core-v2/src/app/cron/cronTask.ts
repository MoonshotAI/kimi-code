/**
 * `cron` domain — shared `CronTask` data record.
 *
 * The authoritative definition of a cron task's persistent shape. The `tags`
 * map carries arbitrary metadata (e.g. `sessionId`) so tasks can be filtered
 * to the session they belong to.
 */

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

export const CRON_SESSION_TAG = 'sessionId';
