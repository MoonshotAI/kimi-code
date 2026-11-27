import { readFileSync } from 'node:fs';

import { IHostClock } from '#/os/interface/hostClock';

export const CLOCK_FILE_ENV = 'KIMI_CODE_CLOCK_FILE';

export class HostClockService implements IHostClock {
  declare readonly _serviceBrand: undefined;

  now(): Date {
    const file = process.env[CLOCK_FILE_ENV];
    if (file === undefined || file === '') return new Date();
    const text = readFileSync(file, 'utf8').trim();
    const time = Date.parse(text);
    if (Number.isNaN(time)) throw new Error(`${CLOCK_FILE_ENV} points at ${file}, which does not hold an ISO-8601 time: ${JSON.stringify(text)}`);
    return new Date(time);
  }

  timeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }
}
