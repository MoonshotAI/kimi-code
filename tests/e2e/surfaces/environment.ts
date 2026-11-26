import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { kimiCliEnv, UNIT_TEST_SWITCHES, type TestHome } from '@moonshot-ai/testkit/fixtures';

const USER_DEFAULTS: Readonly<Record<string, undefined>> = Object.fromEntries(Object.keys(UNIT_TEST_SWITCHES).map((name) => [name, undefined]));

export function clockFileOf(home: TestHome): string {
  return join(home.root, 'clock.txt');
}

export function productEnv(home: TestHome, set: Readonly<Record<string, string | undefined>> = {}): Record<string, string> {
  const clock = clockFileOf(home);
  return kimiCliEnv(home, { ...USER_DEFAULTS, ...(existsSync(clock) ? { KIMI_CODE_CLOCK_FILE: clock } : {}), ...set });
}
