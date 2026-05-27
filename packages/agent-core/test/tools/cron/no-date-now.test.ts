/**
 * Guard: forbid `Date.now()` in cron scheduler-adjacent files.
 *
 * The natural home for this rule is ESLint `no-restricted-syntax`, but
 * oxlint 1.59 does not implement it — so we scan source files here
 * instead. `clock.ts` is excluded because it is where the wall-clock
 * abstraction is *defined*. Non-existent files (P2 additions) are
 * skipped so the guard activates automatically when they land.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'pathe';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// `test/tools/cron/` → package root → `src/tools/cron/`.
const cronSrcDir = join(here, '..', '..', '..', 'src', 'tools', 'cron');

const GUARDED_FILES = [
  'scheduler.ts',
  'persist.ts',
  'lock.ts',
  'jitter.ts',
] as const;

// Matches a `Date.now(` call. Word boundary on the `D` side so it
// won't trip on `myDate.now(` or `notDate.now(`; arbitrary whitespace
// between `now` and `(` so `Date.now ()` and `Date . now (` both
// catch.  The intent is "the CallExpression `Date.now(...)`" — this
// regex is the cheap proxy for the AST selector we'd use in ESLint.
const DATE_NOW_REGEX = /\bDate\s*\.\s*now\s*\(/;

describe('cron scheduler files do not call Date.now()', () => {
  for (const file of GUARDED_FILES) {
    it(`${file} contains no Date.now() call`, () => {
      const path = join(cronSrcDir, file);
      if (!existsSync(path)) {
        // File hasn't been added yet (P1/P2 commits introduce
        // scheduler.ts, persist.ts, lock.ts). The guard activates
        // automatically once they exist.
        return;
      }
      const source = readFileSync(path, 'utf8');
      const match = DATE_NOW_REGEX.exec(source);
      expect(
        match,
        `Found \`Date.now()\` in ${file} at offset ${match?.index ?? -1}. ` +
          `Use ClockSources.wallNow() instead — direct Date.now() bypasses ` +
          `test/bench clock injection. clock.ts is the single legal exception.`,
      ).toBeNull();
    });
  }
});
