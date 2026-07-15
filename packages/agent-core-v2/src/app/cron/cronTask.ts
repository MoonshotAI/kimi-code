/**
 * `cron` domain (L5) — shared `CronTask` data record.
 *
 * The authoritative definition of a cron task's persistent shape. Used by
 * `ICronTaskPersistence` (App scope) for project-level persistence and by
 * `ISessionCronService` (Session scope) for the live scheduling engine.
 * The `tags` map carries arbitrary metadata (e.g. `sessionId`) that the
 * Session projection uses to filter tasks belonging to the current session.
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
