import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCodes, KimiError } from '@moonshot-ai/kimi-code-sdk';

import { validateOptions } from '#/cli/options';
import type { CLIOptions } from '#/cli/options';
import type * as OptionsModule from '#/cli/options';
import { runPrompt } from '#/cli/run-prompt';
import { runShell } from '#/cli/run-shell';
import { formatStartupError } from '#/cli/startup-error';
import { runUpdatePreflight } from '#/cli/update/preflight';
import { handleMainCommand, handleUpgradeCommand, main } from '#/main';

const mocks = vi.hoisted(() => {
  const parse = vi.fn();
  return {
    parse,
    createProgram: vi.fn(() => ({ parse })),
    getVersion: vi.fn(() => '0.0.1-alpha.2'),
    validateOptions: vi.fn(),
    runUpdatePreflight: vi.fn(),
    runShell: vi.fn(),
    runPrompt: vi.fn(),
    installCrashHandlers: vi.fn(),
    track: vi.fn(),
    setTelemetryContext: vi.fn(),
    withTelemetryContext: vi.fn(),
    shutdownTelemetry: vi.fn(),
    createCliTelemetryBootstrap: vi.fn(() => ({
      homeDir: '/tmp/kimi-home',
      deviceId: 'device-id',
      firstLaunch: false,
    })),
    initializeCliTelemetry: vi.fn(),
    handleUpgrade: vi.fn(),
    flushDiagnosticLogs: vi.fn(),
    finalizeHeadlessRun: vi.fn(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    harness: {
      homeDir: '/tmp/kimi-home',
      ensureConfigFile: vi.fn(),
      getConfig: vi.fn(),
      close: vi.fn(),
      track: vi.fn(),
    },
    KimiHarness: vi.fn(),
    createKimiHarness: vi.fn(),
  };
});

vi.mock('@moonshot-ai/kimi-telemetry', () => ({
  installCrashHandlers: mocks.installCrashHandlers,
  track: mocks.track,
  setTelemetryContext: mocks.setTelemetryContext,
  withTelemetryContext: mocks.withTelemetryContext,
  shutdownTelemetry: mocks.shutdownTelemetry,
}));

vi.mock('@moonshot-ai/kimi-code-sdk', async () => {
  const actual = await vi.importActual<typeof import('@moonshot-ai/kimi-code-sdk')>(
    '@moonshot-ai/kimi-code-sdk',
  );
  class MockKimiHarness {
    readonly homeDir = mocks.harness.homeDir;
    readonly ensureConfigFile = mocks.harness.ensureConfigFile;
    readonly getConfig = mocks.harness.getConfig;
    readonly close = mocks.harness.close;
    readonly track = mocks.harness.track;

    constructor(...args: unknown[]) {
      mocks.KimiHarness(...args);
    }
  }
  return {
    ...actual,
    createKimiHarness: (...args: unknown[]) => {
      mocks.createKimiHarness(...args);
      return mocks.harness;
    },
    flushDiagnosticLogs: mocks.flushDiagnosticLogs,
    KimiHarness: MockKimiHarness,
    log: mocks.log,
  };
});

vi.mock('../../src/cli/telemetry', () => ({
  createCliTelemetryBootstrap: mocks.createCliTelemetryBootstrap,
  initializeCliTelemetry: mocks.initializeCliTelemetry,
}));

vi.mock('../../src/cli/sub/upgrade', () => ({
  handleUpgrade: mocks.handleUpgrade,
}));

vi.mock('../../src/cli/commands', () => ({
  createProgram: mocks.createProgram,
}));

vi.mock('../../src/cli/version', async () => {
  const actual = await vi.importActual<typeof import('../../src/cli/version.js')>(
    '../../src/cli/version.js',
  );
  return {
    ...actual,
    getVersion: mocks.getVersion,
  };
});

vi.mock('../../src/cli/options', async () => {
  const actual = await vi.importActual<typeof OptionsModule>('../../src/cli/options.js');
  return {
    ...actual,
    validateOptions: mocks.validateOptions,
  };
});

vi.mock('../../src/cli/update/preflight', () => ({
  runUpdatePreflight: mocks.runUpdatePreflight,
}));

vi.mock('../../src/cli/run-shell', () => ({
  runShell: mocks.runShell,
}));

vi.mock('../../src/cli/run-prompt', () => ({
  runPrompt: mocks.runPrompt,
}));

vi.mock('../../src/cli/headless-exit', () => ({
  finalizeHeadlessRun: mocks.finalizeHeadlessRun,
}));

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

function defaultOpts(): CLIOptions {
  return {
    session: undefined,
    continue: false,
    yolo: false,
    auto: false,
    plan: false,
    model: undefined,
    outputFormat: undefined,
    prompt: undefined,
    skillsDirs: [],
    agent: undefined,
    agentFiles: [],
  };
}

async function waitForAssertion(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

async function runHandleMainCommand(opts: CLIOptions): Promise<number | null> {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new ExitCalled(Number(code ?? 0));
  });
  try {
    await handleMainCommand(opts, '0.0.1-alpha.2');
    return null;
  } catch (error) {
    if (error instanceof ExitCalled) {
      return error.code;
    }
    throw error;
  } finally {
    exitSpy.mockRestore();
  }
}

async function runHandleUpgradeCommand(): Promise<number> {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new ExitCalled(Number(code ?? 0));
  });
  try {
    await handleUpgradeCommand('0.0.1-alpha.2');
    throw new Error('expected process.exit');
  } catch (error) {
    if (error instanceof ExitCalled) {
      return error.code;
    }
    throw error;
  } finally {
    exitSpy.mockRestore();
  }
}

describe('main entry command handling', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.harness.ensureConfigFile.mockResolvedValue(undefined);
    mocks.harness.getConfig.mockResolvedValue({
      defaultModel: 'kimi-k2',
      telemetry: true,
    });
    mocks.harness.close.mockResolvedValue(undefined);
    mocks.shutdownTelemetry.mockResolvedValue(undefined);
    mocks.handleUpgrade.mockResolvedValue(0);
    mocks.flushDiagnosticLogs.mockResolvedValue(undefined);
  });

  it('runs update preflight before starting the shell', async () => {
    const opts = defaultOpts();
    mocks.validateOptions.mockReturnValue({ options: opts, uiMode: 'shell' });
    mocks.runUpdatePreflight.mockResolvedValue('continue');
    mocks.runShell.mockResolvedValue(void 0);

    const exitCode = await runHandleMainCommand(opts);

    expect(exitCode).toBeNull();
    expect(validateOptions).toHaveBeenCalledWith(opts);
    expect(runUpdatePreflight).toHaveBeenCalledWith('0.0.1-alpha.2', { track: expect.any(Function) });
    expect(mocks.runUpdatePreflight.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runShell.mock.invocationCallOrder[0]!,
    );
    expect(runShell).toHaveBeenCalledWith(opts, '0.0.1-alpha.2');
  });

  it('runs prompt mode without interactive update preflight', async () => {
    const opts: CLIOptions = {
      ...defaultOpts(),
      prompt: 'explain the repo',
    };
    mocks.validateOptions.mockReturnValue({ options: opts, uiMode: 'print' });
    mocks.runUpdatePreflight.mockResolvedValue('continue');
    mocks.runPrompt.mockResolvedValue(void 0);

    const exitCode = await runHandleMainCommand(opts);

    expect(exitCode).toBeNull();
    expect(runUpdatePreflight).toHaveBeenCalledWith('0.0.1-alpha.2', {
      track: expect.any(Function),
      isTTY: false,
    });
    expect(runPrompt).toHaveBeenCalledWith(opts, '0.0.1-alpha.2');
    expect(runShell).not.toHaveBeenCalled();
  });

  it('does not force-exit from the reusable handler in print mode', async () => {
    const opts: CLIOptions = { ...defaultOpts(), prompt: 'explain the repo' };
    mocks.validateOptions.mockReturnValue({ options: opts, uiMode: 'print' });
    mocks.runUpdatePreflight.mockResolvedValue('continue');
    mocks.runPrompt.mockResolvedValue(void 0);

    const outcome = await handleMainCommand(opts, '0.0.1-alpha.2');

    // Process disposition belongs to the entrypoint, never to this reusable,
    // unit-tested handler: arming a process.exit here would kill the test runner
    // or any embedding host. The handler only reports what ran.
    expect(mocks.finalizeHeadlessRun).not.toHaveBeenCalled();
    expect(outcome).toEqual({ headlessCompleted: true });
  });

  it('reports no headless completion for interactive (shell) mode', async () => {
    const opts = defaultOpts();
    mocks.validateOptions.mockReturnValue({ options: opts, uiMode: 'shell' });
    mocks.runUpdatePreflight.mockResolvedValue('continue');
    mocks.runShell.mockResolvedValue(void 0);

    const outcome = await handleMainCommand(opts, '0.0.1-alpha.2');

    expect(outcome).toEqual({ headlessCompleted: false });
    expect(mocks.finalizeHeadlessRun).not.toHaveBeenCalled();
  });

  it('arms the force-exit fallback at the entrypoint after a completed headless run', async () => {
    const opts: CLIOptions = { ...defaultOpts(), prompt: 'explain the repo' };
    mocks.validateOptions.mockReturnValue({ options: opts, uiMode: 'print' });
    mocks.runUpdatePreflight.mockResolvedValue('continue');
    mocks.runPrompt.mockResolvedValue(void 0);
    mocks.finalizeHeadlessRun.mockResolvedValue(void 0);

    main();
    const programArgs = mocks.createProgram.mock.calls[0] as unknown as unknown[];
    const mainAction = programArgs[1] as (opts: CLIOptions) => void;
    mainAction(opts);

    await waitForAssertion(() => {
      expect(mocks.finalizeHeadlessRun).toHaveBeenCalledTimes(1);
    });
    // The exit code is resolved lazily so a goal turn that sets process.exitCode wins.
    const forceExitArgs = mocks.finalizeHeadlessRun.mock.calls[0] as unknown as unknown[];
    expect(typeof forceExitArgs[2]).toBe('function');
  });

  it('sets the failure exit code before awaiting startup failure logging', async () => {
    const originalExitCode = process.exitCode;
    const opts: CLIOptions = { ...defaultOpts(), prompt: 'explain the repo' };
    mocks.validateOptions.mockReturnValue({ options: opts, uiMode: 'print' });
    mocks.runUpdatePreflight.mockResolvedValue('continue');
    mocks.runPrompt.mockRejectedValue(new Error('provider failed'));
    mocks.flushDiagnosticLogs.mockImplementation(() => new Promise(() => {}));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new ExitCalled(Number(code ?? 0));
    });

    try {
      main();
      const programArgs = mocks.createProgram.mock.calls[0] as unknown as unknown[];
      const mainAction = programArgs[1] as (opts: CLIOptions) => void;
      mainAction(opts);

      await waitForAssertion(() => {
        expect(mocks.flushDiagnosticLogs).toHaveBeenCalledTimes(1);
      });
      expect(process.exitCode).toBe(1);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      process.exitCode = originalExitCode;
    }
  });

  it('keeps shell mode update preflight interactive by default', async () => {
    const opts = defaultOpts();
    mocks.validateOptions.mockReturnValue({ options: opts, uiMode: 'shell' });
    mocks.runUpdatePreflight.mockResolvedValue('continue');
    mocks.runShell.mockResolvedValue(void 0);

    const exitCode = await runHandleMainCommand(opts);

    expect(exitCode).toBeNull();
    expect(runUpdatePreflight).toHaveBeenCalledWith('0.0.1-alpha.2', {
      track: expect.any(Function),
    });
    expect(runShell).toHaveBeenCalledWith(opts, '0.0.1-alpha.2');
  });

  it('installs crash handlers before parsing CLI arguments', () => {
    main();

    expect(mocks.installCrashHandlers).toHaveBeenCalledTimes(1);
    expect(mocks.installCrashHandlers.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createProgram.mock.invocationCallOrder[0]!,
    );
    expect(mocks.parse).toHaveBeenCalledWith(process.argv);
  });

  it('sets the process title during startup', () => {
    const originalTitle = process.title;
    try {
      process.title = 'kimi-test-runner';
      main();

      expect(process.title).toBe('kimi-code');
    } finally {
      process.title = originalTitle;
    }
  });

  it('exits early when update preflight requests process exit', async () => {
    const opts = defaultOpts();
    mocks.validateOptions.mockReturnValue({ options: opts, uiMode: 'shell' });
    mocks.runUpdatePreflight.mockResolvedValue('exit');
    mocks.runShell.mockResolvedValue(void 0);

    const exitCode = await runHandleMainCommand(opts);

    expect(exitCode).toBe(0);
    expect(runShell).not.toHaveBeenCalled();
  });

  it('initializes and flushes telemetry around the upgrade command', async () => {
    const exitCode = await runHandleUpgradeCommand();

    expect(exitCode).toBe(0);
    expect(mocks.createCliTelemetryBootstrap).toHaveBeenCalledTimes(1);
    expect(mocks.createKimiHarness).toHaveBeenCalledWith(expect.objectContaining({
      homeDir: '/tmp/kimi-home',
      telemetry: {
        track: mocks.track,
        withContext: mocks.withTelemetryContext,
        setContext: mocks.setTelemetryContext,
      },
    }));
    expect(mocks.harness.ensureConfigFile).toHaveBeenCalledTimes(1);
    expect(mocks.initializeCliTelemetry).toHaveBeenCalledWith(expect.objectContaining({
      harness: expect.objectContaining({
        homeDir: '/tmp/kimi-home',
      }),
      bootstrap: {
        homeDir: '/tmp/kimi-home',
        deviceId: 'device-id',
        firstLaunch: false,
      },
      config: {
        defaultModel: 'kimi-k2',
        telemetry: true,
      },
      version: '0.0.1-alpha.2',
      uiMode: 'shell',
    }));
    expect(mocks.handleUpgrade).toHaveBeenCalledWith('0.0.1-alpha.2', {
      track: mocks.track,
      logger: mocks.log,
    });
    expect(mocks.shutdownTelemetry).toHaveBeenCalledWith({ timeoutMs: 3000 });
    expect(mocks.harness.close).toHaveBeenCalledTimes(1);
  });

  it('formats Kimi startup errors with structured fields', () => {
    const error = new KimiError(
      ErrorCodes.SHELL_GIT_BASH_NOT_FOUND,
      'Git Bash was not found on this Windows host. Checked: C:\\Program Files\\Git\\bin\\bash.exe.',
    );
    const red = (text: string): string => `\u001B[31m${text}\u001B[39m`;

    expect(formatStartupError(error, { errorStyle: red })).toBe(
      [
        '\u001B[31merror: Git Bash not found\u001B[39m',
        '',
        '\u001B[31mmessage:\u001B[39m',
        '\u001B[31mGit Bash was not found on this Windows host. Checked: C:\\Program Files\\Git\\bin\\bash.exe.\u001B[39m',
        '',
      ].join('\n'),
    );
  });

  it('keeps generic startup errors on the legacy fallback path', () => {
    expect(formatStartupError(new Error('Provider not set'), { errorStyle: (text) => text })).toBe(
      'error: failed to start shell: Provider not set\n',
    );
  });

  it('formats generic prompt mode errors without saying shell', () => {
    expect(
      formatStartupError(new Error('Provider not set'), {
        errorStyle: (text) => text,
        operation: 'run prompt',
      }),
    ).toBe('error: failed to run prompt: Provider not set\n');
  });
});
