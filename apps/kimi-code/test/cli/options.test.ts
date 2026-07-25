import { describe, expect, it } from 'vitest';

import { createProgram } from '#/cli/commands';
import type { CLIOptions } from '#/cli/options';
import { OptionConflictError, OUTPUT_FORMAT_ENV, resolveOutputFormat, validateOptions } from '#/cli/options';

function parse(argv: string[]): CLIOptions {
  let captured: CLIOptions | undefined;

  const program = createProgram(
    '0.1.0-test',
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

describe('CLI options parsing', () => {
  describe('defaults', () => {
    it('returns defaults when no arguments are given', () => {
      const opts = parse([]);
      expect(opts.yolo).toBe(false);
      expect(opts.plan).toBe(false);
      expect(opts.continue).toBe(false);
      expect(opts.session).toBeUndefined();
      expect(opts.model).toBeUndefined();
      expect(opts.outputFormat).toBeUndefined();
      expect(opts.prompt).toBeUndefined();
      expect(opts.skillsDirs).toEqual([]);
      expect(opts.agent).toBeUndefined();
      expect(opts.agentFiles).toEqual([]);
      expect(opts.addDirs).toEqual([]);
    });
  });

  describe('--version', () => {
    it('prints the version string and exits', () => {
      let output = '';
      const program = createProgram(
        '1.2.3',
        () => {},
        () => {},
      );
      program.exitOverride();
      program.configureOutput({
        writeOut: (s) => {
          output += s;
        },
      });

      expect(() => program.parse(['node', 'kimi', '--version'])).toThrow();
      expect(output).toContain('1.2.3');
    });

    it('supports -V as a short alias', () => {
      let output = '';
      const program = createProgram(
        '4.5.6',
        () => {},
        () => {},
      );
      program.exitOverride();
      program.configureOutput({
        writeOut: (s) => {
          output += s;
        },
      });

      expect(() => program.parse(['node', 'kimi', '-V'])).toThrow();
      expect(output).toContain('4.5.6');
    });
  });

  describe('hidden plugin node runner', () => {
    it('routes __plugin_run_node without calling the main action', () => {
      const pluginRunnerCalls: Array<{ entry: string; args: readonly string[] }> = [];
      const program = createProgram(
        '0.0.0',
        () => {
          throw new Error('main action should not run');
        },
        () => {},
        (entry, args) => {
          pluginRunnerCalls.push({ entry, args });
        },
      );
      program.exitOverride();
      program.configureOutput({
        writeOut: () => {},
        writeErr: () => {},
      });

      program.parse([
        'node',
        'kimi',
        '__plugin_run_node',
        '/plugin/tool.mjs',
        '--',
        'query',
        '--flag',
      ]);

      expect(pluginRunnerCalls).toEqual([{ entry: '/plugin/tool.mjs', args: ['query', '--flag'] }]);
    });
  });

  describe('--yolo family', () => {
    it('--yolo sets yolo to true', () => {
      expect(parse(['--yolo']).yolo).toBe(true);
    });

    it('-y sets yolo to true', () => {
      expect(parse(['-y']).yolo).toBe(true);
    });

    it('--yes sets yolo to true (hidden alias)', () => {
      expect(parse(['--yes']).yolo).toBe(true);
    });

    it('--auto-approve sets yolo to true (hidden alias)', () => {
      expect(parse(['--auto-approve']).yolo).toBe(true);
    });
  });

  describe('--session / --resume / --continue', () => {
    it('-S sets session', () => {
      expect(parse(['-S', 'sess-123']).session).toBe('sess-123');
    });

    it('-r is an alias for --session', () => {
      expect(parse(['-r', 'sess-456']).session).toBe('sess-456');
    });

    it('--resume is an alias for --session', () => {
      expect(parse(['--resume', 'sess-789']).session).toBe('sess-789');
    });

    it('bare -S (no id) yields empty string — triggers the picker', () => {
      expect(parse(['-S']).session).toBe('');
    });

    it('-C sets continue', () => {
      expect(parse(['-C']).continue).toBe(true);
    });

    it('-c is an alias for --continue', () => {
      expect(parse(['-c']).continue).toBe(true);
    });

    it('--continue and --session combined raises a conflict', () => {
      const opts = parse(['--continue', '--session', 'abc123']);
      expect(() => validateOptions(opts)).toThrow(OptionConflictError);
      expect(() => validateOptions(opts)).toThrow('Cannot combine --continue, --session.');
    });
  });

  describe('--plan', () => {
    it('sets plan mode flag', () => {
      expect(parse(['--plan']).plan).toBe(true);
    });
  });

  describe('--auto / --yolo / --plan with --session / --continue', () => {
    it('allows --auto with --continue', () => {
      const opts = parse(['--auto', '--continue']);
      expect(opts.auto).toBe(true);
      expect(opts.continue).toBe(true);
      expect(validateOptions(opts).uiMode).toBe('shell');
    });

    it('allows --auto with an explicit session id', () => {
      const opts = parse(['--auto', '--session', 'ses_123']);
      expect(opts.auto).toBe(true);
      expect(opts.session).toBe('ses_123');
      expect(validateOptions(opts).uiMode).toBe('shell');
    });

    it('allows --yolo with --continue', () => {
      const opts = parse(['--yolo', '--continue']);
      expect(opts.yolo).toBe(true);
      expect(opts.continue).toBe(true);
      expect(validateOptions(opts).uiMode).toBe('shell');
    });

    it('allows --yolo with an explicit session id', () => {
      const opts = parse(['--yolo', '--session', 'ses_123']);
      expect(opts.yolo).toBe(true);
      expect(opts.session).toBe('ses_123');
      expect(validateOptions(opts).uiMode).toBe('shell');
    });

    it('allows --plan with --continue', () => {
      const opts = parse(['--plan', '--continue']);
      expect(opts.plan).toBe(true);
      expect(opts.continue).toBe(true);
      expect(validateOptions(opts).uiMode).toBe('shell');
    });

    it('allows --plan with an explicit session id', () => {
      const opts = parse(['--plan', '--session', 'ses_123']);
      expect(opts.plan).toBe(true);
      expect(opts.session).toBe('ses_123');
      expect(validateOptions(opts).uiMode).toBe('shell');
    });
  });

  describe('--model / -m', () => {
    it('parses -m as a model override', () => {
      expect(parse(['-m', 'kimi-code/k2']).model).toBe('kimi-code/k2');
    });

    it('parses --model=value as a model override', () => {
      expect(parse(['--model=kimi-code/k2.5']).model).toBe('kimi-code/k2.5');
    });

    it('rejects empty model values', () => {
      const opts = parse(['--model', '   ']);
      expect(() => validateOptions(opts)).toThrow(OptionConflictError);
      expect(() => validateOptions(opts)).toThrow('Model cannot be empty.');
    });
  });

  describe('--prompt / -p', () => {
    it('parses -p as prompt mode', () => {
      const opts = parse(['-p', 'explain this repo']);
      expect(opts.prompt).toBe('explain this repo');
      expect(validateOptions(opts).uiMode).toBe('print');
    });

    it('parses --prompt=value as prompt mode', () => {
      const opts = parse(['--prompt=explain this repo']);
      expect(opts.prompt).toBe('explain this repo');
      expect(validateOptions(opts).uiMode).toBe('print');
    });

    it('rejects empty prompt values before reaching the SDK', () => {
      const opts = parse(['-p', '   ']);
      expect(() => validateOptions(opts)).toThrow(OptionConflictError);
      expect(() => validateOptions(opts)).toThrow('Prompt cannot be empty.');
    });

    it('allows prompt mode with --continue', () => {
      const opts = parse(['-p', 'continue here', '--continue']);
      expect(opts.continue).toBe(true);
      expect(validateOptions(opts).uiMode).toBe('print');
    });

    it('allows prompt mode with a concrete session id', () => {
      const opts = parse(['-p', 'resume here', '--session', 'ses_123']);
      expect(opts.session).toBe('ses_123');
      expect(validateOptions(opts).uiMode).toBe('print');
    });

    it('rejects prompt mode with bare --session picker', () => {
      const opts = parse(['-p', 'resume here', '--session']);
      expect(() => validateOptions(opts)).toThrow(OptionConflictError);
      expect(() => validateOptions(opts)).toThrow(
        'Cannot use --session without an id in prompt mode.',
      );
    });

    it('rejects prompt mode with --yolo because prompt mode always uses auto permission', () => {
      const opts = parse(['-p', 'run this', '--yolo']);
      expect(() => validateOptions(opts)).toThrow(OptionConflictError);
      expect(() => validateOptions(opts)).toThrow('Cannot combine --prompt with --yolo.');
    });

    it('rejects prompt mode with --plan', () => {
      const opts = parse(['-p', 'run this', '--plan']);
      expect(() => validateOptions(opts)).toThrow(OptionConflictError);
      expect(() => validateOptions(opts)).toThrow('Cannot combine --prompt with --plan.');
    });

    it('parses --output-format=stream-json in prompt mode', () => {
      const opts = parse(['-p', 'run this', '--output-format=stream-json']);
      expect(opts.outputFormat).toBe('stream-json');
      expect(validateOptions(opts).uiMode).toBe('print');
    });

    it('parses --output-format text in prompt mode', () => {
      const opts = parse(['-p', 'run this', '--output-format', 'text']);
      expect(opts.outputFormat).toBe('text');
    });

    it('rejects --output-format outside prompt mode', () => {
      const opts = parse(['--output-format=stream-json']);
      expect(() => validateOptions(opts)).toThrow(OptionConflictError);
      expect(() => validateOptions(opts)).toThrow(
        'Output format is only supported in prompt mode.',
      );
    });
  });

  describe('KIMI_MODEL_OUTPUT_FORMAT', () => {
    it('defaults to text when unset in prompt mode', () => {
      expect(resolveOutputFormat({ prompt: 'run this', outputFormat: undefined }, {})).toBe('text');
    });

    it('uses stream-json from the env in prompt mode', () => {
      expect(
        resolveOutputFormat(
          { prompt: 'run this', outputFormat: undefined },
          { [OUTPUT_FORMAT_ENV]: 'stream-json' },
        ),
      ).toBe('stream-json');
    });

    it('uses text from the env in prompt mode', () => {
      expect(
        resolveOutputFormat(
          { prompt: 'run this', outputFormat: undefined },
          { [OUTPUT_FORMAT_ENV]: 'text' },
        ),
      ).toBe('text');
    });

    it('trims surrounding whitespace from the env value', () => {
      expect(
        resolveOutputFormat(
          { prompt: 'run this', outputFormat: undefined },
          { [OUTPUT_FORMAT_ENV]: '  stream-json  ' },
        ),
      ).toBe('stream-json');
    });

    it('lets the --output-format flag override the env', () => {
      expect(
        resolveOutputFormat(
          { prompt: 'run this', outputFormat: 'text' },
          { [OUTPUT_FORMAT_ENV]: 'stream-json' },
        ),
      ).toBe('text');
    });

    it('ignores the env outside prompt mode', () => {
      expect(
        resolveOutputFormat(
          { prompt: undefined, outputFormat: undefined },
          { [OUTPUT_FORMAT_ENV]: 'stream-json' },
        ),
      ).toBe('text');
    });

    it('rejects an invalid env value', () => {
      expect(() =>
        resolveOutputFormat(
          { prompt: 'run this', outputFormat: undefined },
          { [OUTPUT_FORMAT_ENV]: 'json' },
        ),
      ).toThrow(OptionConflictError);
      expect(() =>
        resolveOutputFormat(
          { prompt: 'run this', outputFormat: undefined },
          { [OUTPUT_FORMAT_ENV]: 'json' },
        ),
      ).toThrow('Invalid KIMI_MODEL_OUTPUT_FORMAT value "json"');
    });

    it('fails validation fast for an invalid env value in prompt mode', () => {
      const opts = parse(['-p', 'run this']);
      expect(() => validateOptions(opts, { [OUTPUT_FORMAT_ENV]: 'json' })).toThrow(
        OptionConflictError,
      );
    });

    it('does not validate the env outside prompt mode', () => {
      const opts = parse([]);
      expect(() => validateOptions(opts, { [OUTPUT_FORMAT_ENV]: 'json' })).not.toThrow();
    });
  });

  describe('--skills-dir', () => {
    it('collects repeated skill directories', () => {
      expect(parse(['--skills-dir', '/one', '--skills-dir=/two']).skillsDirs).toEqual([
        '/one',
        '/two',
      ]);
    });
  });

  describe('--agent / --agent-file', () => {
    it('parses a single --agent', () => {
      const opts = parse(['-p', 'hi', '--agent', 'reviewer']);
      expect(opts.agent).toBe('reviewer');
      expect(opts.agentFiles).toEqual([]);
    });

    it('parses a single --agent-file', () => {
      const opts = parse(['-p', 'hi', '--agent-file', 'a.md']);
      expect(opts.agent).toBeUndefined();
      expect(opts.agentFiles).toEqual(['a.md']);
    });

    it('rejects repeated --agent', () => {
      expect(() => parse(['-p', 'hi', '--agent', 'reviewer', '--agent', 'writer'])).toThrow(
        '--agent may only be specified once.',
      );
    });

    it('rejects repeated --agent-file', () => {
      expect(() =>
        parse(['-p', 'hi', '--agent-file', 'a.md', '--agent-file', 'b.md']),
      ).toThrow('--agent-file may only be specified once.');
    });

    it('rejects combining --agent with --agent-file', () => {
      expect(() =>
        parse(['-p', 'hi', '--agent', 'reviewer', '--agent-file', 'reviewer.md']),
      ).toThrow("option '--agent <name>' cannot be used with option '--agent-file <path>'");
    });

    it('rejects multiple agent files passed directly to validation', () => {
      const opts = parse(['-p', 'hi', '--agent-file', 'a.md']);
      expect(() => validateOptions({ ...opts, agentFiles: ['a.md', 'b.md'] })).toThrow(
        '--agent-file may only be specified once.',
      );
    });

    it('rejects mixed agent selectors passed directly to validation', () => {
      const opts = parse(['-p', 'hi', '--agent', 'reviewer']);
      expect(() => validateOptions({ ...opts, agentFiles: ['reviewer.md'] })).toThrow(
        'Cannot combine --agent with --agent-file.',
      );
    });

    it('rejects empty agent values', () => {
      const opts = parse(['-p', 'hi', '--agent', '   ']);
      expect(() => validateOptions(opts)).toThrow(OptionConflictError);
      expect(() => validateOptions(opts)).toThrow('Agent cannot be empty.');
    });

    it('rejects empty agent file values', () => {
      const opts = parse(['-p', 'hi', '--agent-file', '   ']);
      expect(() => validateOptions(opts)).toThrow(OptionConflictError);
      expect(() => validateOptions(opts)).toThrow('Agent file path cannot be empty.');
    });

    it('rejects the flags in shell mode', () => {
      const opts = parse(['--agent', 'reviewer']);
      expect(() => validateOptions(opts)).toThrow(OptionConflictError);
      expect(() => validateOptions(opts)).toThrow(
        '--agent/--agent-file are only available with the v2 engine',
      );
    });

    it('rejects the flags in prompt mode without the v2 engine flag', () => {
      const opts = parse(['-p', 'hi', '--agent-file', 'a.md']);
      expect(() => validateOptions(opts, {})).toThrow(OptionConflictError);
      expect(() => validateOptions(opts, {})).toThrow(
        '--agent/--agent-file are only available with the v2 engine',
      );
    });

    it('accepts the flags in prompt mode with the v2 engine flag', () => {
      const opts = parse(['-p', 'hi', '--agent', 'reviewer']);
      expect(validateOptions(opts, { KIMI_CODE_EXPERIMENTAL_FLAG: '1' }).uiMode).toBe('print');
    });
  });

  describe('--add-dir', () => {
    it('parses one additional workspace directory', () => {
      expect(parse(['--add-dir', '/shared']).addDirs).toEqual(['/shared']);
    });

    it('parses repeated additional workspace directories', () => {
      expect(parse(['--add-dir', '/one', '--add-dir=/two']).addDirs).toEqual(['/one', '/two']);
    });
  });

  describe('sub-commands', () => {
    it('routes upgrade without calling the main action', () => {
      let upgradeCalls = 0;
      const program = createProgram(
        '0.0.0',
        () => {
          throw new Error('main action should not run');
        },
        () => {},
        () => {},
        () => {
          upgradeCalls += 1;
        },
      );
      program.exitOverride();
      program.configureOutput({
        writeOut: () => {},
        writeErr: () => {},
      });

      program.parse(['node', 'kimi', 'upgrade']);

      expect(upgradeCalls).toBe(1);
    });

    it('routes update alias to the upgrade handler', () => {
      let upgradeCalls = 0;
      const program = createProgram(
        '0.0.0',
        () => {
          throw new Error('main action should not run');
        },
        () => {},
        () => {},
        () => {
          upgradeCalls += 1;
        },
      );
      program.exitOverride();
      program.configureOutput({
        writeOut: () => {},
        writeErr: () => {},
      });

      program.parse(['node', 'kimi', 'update']);

      expect(upgradeCalls).toBe(1);
    });

    it('registers the visible sub-commands', () => {
      const program = createProgram(
        '0.0.0',
        () => {},
        () => {},
      );
      const commandNames: string[] = program.commands
        .filter((command) => !command.name().startsWith('__'))
        .map((command) => command.name());
      expect(commandNames).toEqual([
        'export',
        'provider',
        'acp',
        'web',
        'server',
        'login',
        'doctor',
        'vis',
        'migrate',
        'upgrade',
      ]);
    });
  });

  describe('rejected flags', () => {
    it('any removed flag is unknown to Commander', () => {
      for (const arg of [
        '--verbose',
        '--debug',
        '--work-dir=/',
        '--config=x',
        '--thinking',
        '--print',
        '--wire',
        '--raw-model',
        '--config-file=x',
        '--quiet',
        '--final-message-only',
        '--input-format=text',
        '--mcp-config={}',
        '--mcp-config-file=/',
      ]) {
        expect(() => parse([arg])).toThrow();
      }
    });
  });
});
