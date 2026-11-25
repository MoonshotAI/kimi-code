import { kimiCliEnv, UNIT_TEST_SWITCHES, type TestHome } from '@moonshot-ai/testkit/fixtures';

const USER_DEFAULTS: Readonly<Record<string, undefined>> = Object.fromEntries(Object.keys(UNIT_TEST_SWITCHES).map((name) => [name, undefined]));

export function productEnv(home: TestHome, set: Readonly<Record<string, string | undefined>> = {}): Record<string, string> {
  return kimiCliEnv(home, { ...USER_DEFAULTS, ...set });
}
