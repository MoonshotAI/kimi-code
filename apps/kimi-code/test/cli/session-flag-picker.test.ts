import { describe, expect, it } from 'vitest';

import { createProgram } from '#/cli/commands';
import type { CLIOptions } from '#/cli/options';
import { OptionConflictError, validateOptions } from '#/cli/options';

function parse(argv: string[]): CLIOptions {
  let captured: CLIOptions | undefined;
  const program = createProgram(
    '0.0.0-test',
    (opts) => {
      captured = opts;
    },
    () => {},
  );
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  program.parse(['node', 'kimi', ...argv]);
  if (captured === undefined) {
    throw new Error('Main action handler was not called');
  }
  return captured;
}

describe('--session / --sessions / -r / -S picker routing', () => {
  describe('argParser: no-arg forms coerce to empty string', () => {
    it('--session with no id → session === ""', () => {
      const opts = parse(['--session']);
      expect(opts.session).toBe('');
    });

    it('--sessions with no id → session === ""', () => {
      const opts = parse(['--sessions']);
      expect(opts.session).toBe('');
    });

    it('-S with no id → session === ""', () => {
      const opts = parse(['-S']);
      expect(opts.session).toBe('');
    });

    it('-r with no id → session === ""', () => {
      const opts = parse(['-r']);
      expect(opts.session).toBe('');
    });
  });

  describe('argParser: id forms keep the id verbatim', () => {
    it('--session foo → session === "foo"', () => {
      const opts = parse(['--session', 'foo']);
      expect(opts.session).toBe('foo');
    });

    it('--sessions foo → session === "foo"', () => {
      const opts = parse(['--sessions', 'foo']);
      expect(opts.session).toBe('foo');
    });

    it('-S foo → session === "foo"', () => {
      const opts = parse(['-S', 'foo']);
      expect(opts.session).toBe('foo');
    });

    it('-r foo → session === "foo" (hidden alias)', () => {
      const opts = parse(['-r', 'foo']);
      expect(opts.session).toBe('foo');
    });
  });

  describe('validateOptions: empty session vs ui mode', () => {
    it('empty session + shell mode → OK, session stays ""', () => {
      const { options, uiMode } = validateOptions(parse(['--session']));
      expect(uiMode).toBe('shell');
      expect(options.session).toBe('');
    });

    // Note: --print / --wire are held back from the first release, so
    // the "picker + print/wire" combinations can't be constructed via
    // Commander anymore. The validateOptions guard still lives in
    // source for when those flags return.
  });

  // Silence unused-import warning kept for the preserved guard tests.
  void OptionConflictError;
});
