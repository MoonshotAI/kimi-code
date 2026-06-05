import { describe, expect, it } from 'vitest';

import { createProgram } from '#/cli/commands';
import type { HeadlessCommand } from '#/cli/headless/commands';

function parseHeadless(argv: string[]): HeadlessCommand {
  let captured: HeadlessCommand | undefined;

  const program = createProgram(
    '0.1.0-test',
    () => {
      throw new Error('main action should not run');
    },
    () => {},
    () => {},
    () => {},
    (command) => {
      captured = command;
    },
  );

  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });

  program.parse(['node', 'kimi', ...argv]);

  if (captured === undefined) {
    throw new Error('Headless action handler was not called');
  }
  return captured;
}

function expectParseError(argv: string[], message: string): void {
  const program = createProgram(
    '0.1.0-test',
    () => {
      throw new Error('main action should not run');
    },
    () => {},
    () => {},
    () => {},
    () => {
      throw new Error('headless action should not run');
    },
  );

  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });

  expect(() => program.parse(['node', 'kimi', ...argv])).toThrow(message);
}

function expectCommanderError(argv: string[], message: string): void {
  let stderr = '';
  const program = createProgram(
    '0.1.0-test',
    () => {
      throw new Error('main action should not run');
    },
    () => {},
    () => {},
    () => {},
    () => {
      throw new Error('headless action should not run');
    },
  );

  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: (value) => {
      stderr += value;
    },
  });

  expect(() => program.parse(['node', 'kimi', ...argv])).toThrow();
  expect(stderr).toContain(message);
}

describe('headless command parsing', () => {
  it('parses headless run with a prompt', () => {
    expect(parseHeadless(['headless', 'run', '--prompt', 'inspect'])).toEqual({
      kind: 'run',
      options: {
        prompt: 'inspect',
        continue: false,
        metadataOnly: false,
        approvePlan: false,
        rejectPlan: false,
        skillsDirs: [],
      },
    });
  });

  it('parses headless run options', () => {
    expect(
      parseHeadless([
        'headless',
        'run',
        '--cwd',
        '/repo',
        '--session',
        'ses_123',
        '--prompt',
        'inspect',
        '--model',
        'kimi-code/k2.5',
        '--status-file',
        '/tmp/kimi-run/status.json',
        '--output-dir',
        '/tmp/kimi-run',
        '--metadata-only',
        '--approve-plan',
        '--skills-dir',
        '/skills/one',
        '--skills-dir',
        '/skills/two',
      ]),
    ).toEqual({
      kind: 'run',
      options: {
        prompt: 'inspect',
        cwd: '/repo',
        session: 'ses_123',
        continue: false,
        model: 'kimi-code/k2.5',
        statusFile: '/tmp/kimi-run/status.json',
        outputDir: '/tmp/kimi-run',
        metadataOnly: true,
        approvePlan: true,
        rejectPlan: false,
        skillsDirs: ['/skills/one', '/skills/two'],
      },
    });
  });

  it('parses the top-level goal shortcut', () => {
    expect(parseHeadless(['headless', '--goal', 'raise coverage to 99.5%'])).toEqual({
      kind: 'run',
      options: {
        goal: 'raise coverage to 99.5%',
        continue: false,
        metadataOnly: false,
        approvePlan: false,
        rejectPlan: false,
        skillsDirs: [],
      },
    });
  });

  it('parses goal and replace-goal run inputs', () => {
    expect(parseHeadless(['headless', 'run', '--goal', 'raise coverage'])).toMatchObject({
      kind: 'run',
      options: { goal: 'raise coverage' },
    });
    expect(parseHeadless(['headless', 'run', '--replace-goal', 'raise coverage'])).toMatchObject({
      kind: 'run',
      options: { replaceGoal: 'raise coverage' },
    });
  });

  it('rejects run without exactly one input source', () => {
    expectParseError(['headless', 'run'], 'Specify exactly one of --prompt, --goal, or --replace-goal.');
    expectParseError(
      ['headless', 'run', '--prompt', 'inspect', '--goal', 'raise coverage'],
      'Specify exactly one of --prompt, --goal, or --replace-goal.',
    );
    expectParseError(
      ['headless', 'run', '--goal', 'raise coverage', '--replace-goal', 'raise coverage'],
      'Specify exactly one of --prompt, --goal, or --replace-goal.',
    );
  });

  it('rejects conflicting plan flags', () => {
    expectParseError(
      ['headless', 'run', '--prompt', 'inspect', '--approve-plan', '--reject-plan'],
      'Cannot combine --approve-plan with --reject-plan.',
    );
  });

  it('keeps prompt-mode output format unavailable in headless run', () => {
    expectCommanderError(
      ['headless', 'run', '--prompt', 'inspect', '--output-format=stream-json'],
      "unknown option '--output-format=stream-json'",
    );
  });

  it('parses headless status', () => {
    expect(parseHeadless(['headless', 'status', '--file', '/tmp/kimi-run/status.json'])).toEqual({
      kind: 'status',
      options: {
        file: '/tmp/kimi-run/status.json',
        json: false,
      },
    });

    expect(
      parseHeadless(['headless', 'status', '--file', '/tmp/kimi-run/status.json', '--json']),
    ).toEqual({
      kind: 'status',
      options: {
        file: '/tmp/kimi-run/status.json',
        json: true,
      },
    });
  });

  it('parses goal control commands', () => {
    expect(parseHeadless(['headless', 'goal', 'pause', '--file', '/tmp/kimi-run/status.json'])).toEqual({
      kind: 'goal-control',
      options: {
        action: 'pause_goal',
        file: '/tmp/kimi-run/status.json',
        wait: false,
      },
    });

    expect(
      parseHeadless([
        'headless',
        'goal',
        'cancel',
        '--file',
        '/tmp/kimi-run/status.json',
        '--wait',
      ]),
    ).toEqual({
      kind: 'goal-control',
      options: {
        action: 'cancel_goal',
        file: '/tmp/kimi-run/status.json',
        wait: true,
      },
    });

    expect(
      parseHeadless(['headless', 'goal', 'interrupt', '--file', '/tmp/kimi-run/status.json']),
    ).toEqual({
      kind: 'goal-control',
      options: {
        action: 'interrupt',
        file: '/tmp/kimi-run/status.json',
        wait: false,
      },
    });
  });
});
