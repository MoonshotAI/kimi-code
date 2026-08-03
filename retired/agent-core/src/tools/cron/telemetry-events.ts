/** Telemetry event names emitted by the cron subsystem. Centralised so a typo can't drift a metric. */
export const CRON_SCHEDULED = 'cron_scheduled' as const;
export const CRON_FIRED = 'cron_fired' as const;
export const CRON_MISSED = 'cron_missed' as const;
export const CRON_DELETED = 'cron_deleted' as const;

export type CronTelemetryEvent =
  | typeof CRON_SCHEDULED
  | typeof CRON_FIRED
  | typeof CRON_MISSED
  | typeof CRON_DELETED;
