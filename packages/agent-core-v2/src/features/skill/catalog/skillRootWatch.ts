import { parseBooleanEnv } from '#/_base/utils/env';

export const SKILL_ROOT_WATCH_ENV = 'KIMI_CODE_SKILL_ROOT_WATCH';

export function skillRootWatchEnabled(): boolean {
  return parseBooleanEnv(process.env[SKILL_ROOT_WATCH_ENV]) === true;
}
