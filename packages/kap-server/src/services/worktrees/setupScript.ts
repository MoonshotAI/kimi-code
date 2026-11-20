import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { runCommand } from './command';
import {
  abbreviateHome,
  displayCommand,
  runStepCommand,
  setStep,
  type SetupProgress,
  type StepOutcome,
} from './worktreeSetup';

export const SETUP_SCRIPT_RELATIVE_PATH = join('.kimi', 'setup.sh');
export const SETUP_SCRIPT_PROJECT_DIR_ENV = 'KIMI_PROJECT_DIR';
export const SETUP_SCRIPT_TIMEOUT_MS = 180_000;

export function setupScriptPath(repoRoot: string): string {
  return join(repoRoot, SETUP_SCRIPT_RELATIVE_PATH);
}

export async function readSetupScript(repoRoot: string): Promise<string | undefined> {
  const content = await readFile(setupScriptPath(repoRoot), 'utf-8').catch(() => undefined);
  return content === undefined || content.trim().length === 0 ? undefined : content;
}

export function setupScriptHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function interpreterOf(content: string): string[] {
  if (process.platform === 'win32') return ['bash'];
  const firstLine = content.split('\n', 1)[0] ?? '';
  if (!firstLine.startsWith('#!')) return ['sh'];
  const words = firstLine.slice(2).trim().split(/\s+/).filter((word) => word.length > 0);
  return words.length === 0 ? ['sh'] : words;
}

export function setupScriptCommand(repoRoot: string, content: string, osHomeDir: string): string {
  const [program, ...args] = interpreterOf(content);
  return displayCommand(program!, [...args, abbreviateHome(setupScriptPath(repoRoot), osHomeDir)]);
}

export interface SetupScriptRun {
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly content: string;
  readonly osHomeDir: string;
  readonly timeoutMs?: number;
}

export async function runSetupScript(
  run: SetupScriptRun,
  progress: SetupProgress,
  signal: AbortSignal,
): Promise<StepOutcome<void>> {
  const [program, ...args] = interpreterOf(run.content);
  const timeoutMs = run.timeoutMs ?? SETUP_SCRIPT_TIMEOUT_MS;
  setStep(progress, 'script', {
    command: setupScriptCommand(run.repoRoot, run.content, run.osHomeDir),
  });
  const result = await runStepCommand(progress, 'script', (onOutput) =>
    runCommand(program!, [...args, setupScriptPath(run.repoRoot)], {
      cwd: run.worktreePath,
      env: { [SETUP_SCRIPT_PROJECT_DIR_ENV]: run.repoRoot },
      timeoutMs,
      signal,
      onOutput,
    }),
  );
  if (result.exitCode === 0) {
    setStep(progress, 'script', { state: 'done', output: undefined });
    return { kind: 'done', value: undefined };
  }
  if (result.aborted) {
    setStep(progress, 'script', { state: 'stopped' });
    return { kind: 'stopped', step: 'script' };
  }
  if (result.timedOut) {
    setStep(progress, 'script', { state: 'failed', timed_out: true, output: result.output });
    return {
      kind: 'failed',
      step: 'script',
      failure: { kind: 'script_timeout', timeout_seconds: Math.max(1, Math.round(timeoutMs / 1000)) },
    };
  }
  setStep(progress, 'script', { state: 'failed', output: result.output });
  return {
    kind: 'failed',
    step: 'script',
    failure: { kind: 'script_failed', exit_code: result.exitCode ?? undefined },
  };
}

const approvalsFileSchema = z.object({
  version: z.literal(1),
  repositories: z.record(
    z.string(),
    z.object({
      saved: z.string().optional(),
      confirmed: z.array(z.string()),
    }),
  ),
});
type ApprovalsFile = z.infer<typeof approvalsFileSchema>;

export class SetupScriptStore {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly worktreesHome: string) {}

  private get file(): string {
    return join(this.worktreesHome, 'setup-scripts.json');
  }

  private async load(): Promise<ApprovalsFile> {
    const raw = await readFile(this.file, 'utf-8').catch(() => undefined);
    if (raw !== undefined) {
      try {
        const parsed = approvalsFileSchema.safeParse(JSON.parse(raw));
        if (parsed.success) return parsed.data;
      } catch {
      }
    }
    return { version: 1, repositories: {} };
  }

  private mutate(repoRoot: string, change: (entry: ApprovalsFile['repositories'][string]) => void): Promise<void> {
    const run = this.writes.then(async () => {
      const data = await this.load();
      const entry = data.repositories[repoRoot] ?? { confirmed: [] };
      change(entry);
      data.repositories[repoRoot] = entry;
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
      await rename(temp, this.file);
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  async needsConfirmation(repoRoot: string, content: string): Promise<boolean> {
    const entry = (await this.load()).repositories[repoRoot];
    const hash = setupScriptHash(content);
    return entry?.saved !== hash && entry?.confirmed.includes(hash) !== true;
  }

  confirm(repoRoot: string, content: string): Promise<void> {
    const hash = setupScriptHash(content);
    return this.mutate(repoRoot, (entry) => {
      if (!entry.confirmed.includes(hash)) entry.confirmed.push(hash);
    });
  }

  async save(repoRoot: string, content: string): Promise<void> {
    const path = setupScriptPath(repoRoot);
    if (content.trim().length === 0) {
      await rm(path, { force: true });
      await this.mutate(repoRoot, (entry) => {
        entry.saved = undefined;
      });
      return;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf-8');
    await chmod(path, 0o755).catch(() => undefined);
    await this.mutate(repoRoot, (entry) => {
      entry.saved = setupScriptHash(content);
    });
  }
}
