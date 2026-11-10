import type { CLIOptions } from './options';

export async function raceWithTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = promise.catch((error: unknown) => {
    if (timedOut) return;
    throw error;
  });
  const timedOutSignal = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });
  try {
    await Promise.race([guarded, timedOutSignal]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface PromptOutput {
  readonly columns?: number | undefined;
  write(chunk: string): boolean;
}

export interface PromptRunIO {
  readonly stdout?: PromptOutput;
  readonly stderr?: PromptOutput;
  readonly process?: PromptProcess;
}

export interface PromptProcess {
  once(signal: NodeJS.Signals, listener: () => Promise<void>): unknown;
  off(signal: NodeJS.Signals, listener: () => Promise<void>): unknown;
  exit(code?: number): never | void;
}

export async function runPrompt(
  opts: CLIOptions,
  version: string,
  io: PromptRunIO = {},
): Promise<void> {
  const { runV2Print } = await import('./v2/run-v2-print');
  await runV2Print(opts, version, io);
}

export function requireConfiguredModel(...models: readonly (string | undefined)[]): string {
  const model = configuredModel(...models);
  if (model === undefined) {
    throw new Error(
      'No model configured. Run `kimi` and use /login to sign in, then retry; or set default_model in config.toml.',
    );
  }
  return model;
}

export function configuredModel(...models: readonly (string | undefined)[]): string | undefined {
  return models.find((model) => model !== undefined && model.trim().length > 0);
}

export function installPromptTerminationCleanup(
  promptProcess: PromptProcess,
  cleanup: () => Promise<void>,
): () => void {
  let terminating = false;
  const exitAfterCleanup = async (signal: NodeJS.Signals): Promise<void> => {
    if (terminating) return;
    terminating = true;
    try {
      await cleanup();
    } finally {
      promptProcess.exit(signalExitCode(signal));
    }
  };
  const onSigint = () => exitAfterCleanup('SIGINT');
  const onSigterm = () => exitAfterCleanup('SIGTERM');
  const onSighup = () => exitAfterCleanup('SIGHUP');
  promptProcess.once('SIGINT', onSigint);
  promptProcess.once('SIGTERM', onSigterm);
  promptProcess.once('SIGHUP', onSighup);
  return () => {
    promptProcess.off('SIGINT', onSigint);
    promptProcess.off('SIGTERM', onSigterm);
    promptProcess.off('SIGHUP', onSighup);
  };
}

export function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGHUP') return 129;
  return 143;
}
