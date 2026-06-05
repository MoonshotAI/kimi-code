import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProgram } from '#/cli/commands';
import { getUnusedPlanFlagWarning } from '#/cli/headless/approval';
import type { HeadlessCommand } from '#/cli/headless/commands';
import {
  readHeadlessControlRequest,
  writeHeadlessControlRequest,
} from '#/cli/headless/control';
import { formatHeadlessMetadataHeader } from '#/cli/headless/output';
import {
  preflightHeadlessOutputDir,
  resolveHeadlessOutputDir,
  writeHeadlessGoalStatusFile,
  writeHeadlessResponseFile,
} from '#/cli/headless/output-files';
import {
  preflightHeadlessStatusFile,
  readHeadlessRunStatus,
  type HeadlessRunStatus,
  writeHeadlessRunStatus,
} from '#/cli/headless/status-file';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kimi-headless-test-'));
  tempDirs.push(dir);
  return dir;
}

function createStatus(overrides: Partial<HeadlessRunStatus> = {}): HeadlessRunStatus {
  return {
    schemaVersion: 1,
    runId: 'run_test',
    pid: 123,
    sessionId: 'ses_test',
    turnId: 1,
    state: 'running',
    workDir: '/repo',
    model: 'kimi-code/k2.5',
    startedAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:01.000Z',
    elapsedMs: 1000,
    lastEvent: 'turn.started',
    activeTool: null,
    summary: {
      turnStepCount: 1,
      toolCallCount: 0,
      completedToolCallCount: 0,
      failedToolCallCount: 0,
      assistantCharCount: 0,
      thinkingCharCount: 0,
    },
    approval: null,
    goal: null,
    warnings: [],
    files: {
      outputDir: null,
      responses: [],
      finalResponse: null,
      goalStatus: null,
    },
    control: null,
    error: null,
    resumeCommand: 'kimi -r ses_test',
    ...overrides,
  };
}

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

function helpFor(argv: string[]): string {
  let stdout = '';
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
    writeOut: (value) => {
      stdout += value;
    },
    writeErr: () => {},
  });

  try {
    program.parse(['node', 'kimi', ...argv, '--help']);
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : '';
    if (code !== 'commander.helpDisplayed' && !message.includes('process.exit unexpectedly called')) {
      throw error;
    }
  }

  return stdout;
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

  it('explains graceful goal pause and immediate interrupt in help', () => {
    expect(helpFor(['headless', 'goal', 'pause'])).toContain(
      'Let the current turn finish, then pause the goal.',
    );
    expect(helpFor(['headless', 'goal', 'cancel'])).toContain(
      'Let the current turn finish, then cancel the goal.',
    );
    expect(helpFor(['headless', 'goal', 'interrupt'])).toContain(
      'Stop the active turn now and leave the goal paused when possible.',
    );
  });
});

describe('headless status files', () => {
  it('writes and reads status files atomically', async () => {
    const dir = await createTempDir();
    const file = path.join(dir, 'status.json');
    const status = createStatus({
      goal: {
        goalId: 'goal_123',
        status: 'active',
        reason: null,
        turnsUsed: 1,
        tokensUsed: 100,
        wallClockMs: 5000,
      },
      warnings: [{ code: 'PLAN_FLAG_UNUSED', message: '--approve-plan was unused.' }],
    });

    await writeHeadlessRunStatus(file, status);

    await expect(readHeadlessRunStatus(file)).resolves.toEqual(status);
    await expect(stat(`${file}.tmp`)).rejects.toThrow();
  });

  it('preflights status files before a run starts', async () => {
    const dir = await createTempDir();
    await expect(preflightHeadlessStatusFile(path.join(dir, 'status.json'))).resolves.toBeUndefined();
    await expect(
      preflightHeadlessStatusFile(path.join(dir, 'missing', 'status.json')),
    ).rejects.toThrow('Status file parent directory does not exist.');
  });
});

describe('headless output formatting', () => {
  it('formats metadata headers without embedding Markdown', () => {
    const formatted = formatHeadlessMetadataHeader({
      type: 'headless.result',
      schemaVersion: 1,
      runId: 'run_test',
      sessionId: 'ses_test',
      turnId: 1,
      state: 'completed',
      responseFormat: 'markdown',
      responseOmitted: false,
      resumeCommand: 'kimi -r ses_test',
      summary: createStatus().summary,
      approval: null,
      goal: null,
      warnings: [],
      files: createStatus().files,
    });

    expect(formatted).toBe(`${formatted.trim()}\n\n`);
    const parsed = JSON.parse(formatted.split('\n')[0]!);
    expect(parsed).toMatchObject({
      type: 'headless.result',
      responseFormat: 'markdown',
      responseOmitted: false,
    });
    expect(formatted).not.toContain('assistant Markdown');
  });

  it('formats metadata-only headers as a single line', () => {
    const formatted = formatHeadlessMetadataHeader({
      type: 'headless.result',
      schemaVersion: 1,
      runId: 'run_test',
      sessionId: null,
      turnId: null,
      state: 'completed',
      responseFormat: 'files',
      responseOmitted: true,
      resumeCommand: null,
      summary: createStatus().summary,
      approval: null,
      goal: null,
      warnings: [],
      files: {
        outputDir: '/tmp/kimi-run',
        responses: [],
        finalResponse: null,
        goalStatus: null,
      },
    });

    expect(formatted).toBe(`${formatted.trim()}\n`);
    expect(JSON.parse(formatted)).toMatchObject({
      responseFormat: 'files',
      responseOmitted: true,
    });
  });
});

describe('headless output files', () => {
  it('resolves output directories from explicit, status, and temp inputs', () => {
    expect(
      resolveHeadlessOutputDir({ explicitOutputDir: '/tmp/kimi-run', runId: 'run_test' }),
    ).toBe('/tmp/kimi-run');
    expect(
      resolveHeadlessOutputDir({
        statusFile: '/tmp/kimi-run/status.json',
        runId: 'run_test',
      }),
    ).toBe('/tmp/kimi-run/status.json.d');
    expect(resolveHeadlessOutputDir({ runId: 'run_test' })).toContain('run_test');
  });

  it('writes response and goal status files atomically', async () => {
    const outputDir = await createTempDir();

    await preflightHeadlessOutputDir(outputDir);
    const responseFile = await writeHeadlessResponseFile({
      outputDir,
      turnIndex: 1,
      turnId: 7,
      markdown: 'model markdown\n',
      updatedAt: '2026-06-05T00:00:01.000Z',
    });
    const goalFile = await writeHeadlessGoalStatusFile({
      outputDir,
      goal: {
        goalId: 'goal_123',
        status: 'complete',
        reason: 'done',
        turnsUsed: 1,
        tokensUsed: 100,
        wallClockMs: 5000,
      },
      updatedAt: '2026-06-05T00:00:02.000Z',
    });

    expect(responseFile).toMatchObject({
      turnIndex: 1,
      turnId: 7,
      path: path.join(outputDir, 'turns', 'turn-0001.md'),
      state: 'completed',
      bytes: 15,
    });
    await expect(readFile(responseFile.path, 'utf8')).resolves.toBe('model markdown\n');
    await expect(stat(`${responseFile.path}.tmp`)).rejects.toThrow();
    expect(goalFile).toMatchObject({
      path: path.join(outputDir, 'goal-status.json'),
      state: 'completed',
    });
    await expect(readFile(goalFile.path, 'utf8')).resolves.toContain('"goalId": "goal_123"');
  });

  it('rejects output paths that are not directories', async () => {
    const dir = await createTempDir();
    const file = path.join(dir, 'not-a-directory');
    await writeFile(file, 'x');

    await expect(preflightHeadlessOutputDir(file)).rejects.toThrow(
      'Output path exists and is not a directory.',
    );
  });
});

describe('headless control files', () => {
  it('writes and reads control requests atomically', async () => {
    const dir = await createTempDir();
    const file = path.join(dir, 'control.json');
    const request = {
      schemaVersion: 1 as const,
      runId: 'run_test',
      commandId: 'cmd_001',
      action: 'pause_goal' as const,
      requestedAt: '2026-06-05T00:00:01.000Z',
    };

    await writeHeadlessControlRequest(file, request);

    await expect(readHeadlessControlRequest(file)).resolves.toEqual(request);
    await expect(stat(`${file}.tmp`)).rejects.toThrow();
  });

  it('returns null for a missing control file', async () => {
    const dir = await createTempDir();

    await expect(readHeadlessControlRequest(path.join(dir, 'control.json'))).resolves.toBeNull();
  });
});

describe('headless approval warnings', () => {
  it('records unused plan flags as non-fatal warnings', () => {
    expect(
      getUnusedPlanFlagWarning({
        approvePlan: true,
        rejectPlan: false,
        planApprovalSeen: false,
      }),
    ).toEqual({
      code: 'PLAN_FLAG_UNUSED',
      message: '--approve-plan was set, but no plan approval was requested.',
    });
    expect(
      getUnusedPlanFlagWarning({
        approvePlan: false,
        rejectPlan: true,
        planApprovalSeen: false,
      }),
    ).toEqual({
      code: 'PLAN_FLAG_UNUSED',
      message: '--reject-plan was set, but no plan approval was requested.',
    });
    expect(
      getUnusedPlanFlagWarning({
        approvePlan: true,
        rejectPlan: false,
        planApprovalSeen: true,
      }),
    ).toBeNull();
  });
});
