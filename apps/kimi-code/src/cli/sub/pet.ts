/**
 * `kimi pet` sub-command.
 *
 * Launches (or stops) the desktop-pet overlay: a small always-on-top Electron
 * window that mirrors the live status of running Kimi Code sessions. The
 * overlay process is detached (it outlives this command); running sessions
 * report their status through state files under `<dataDir>/pet/`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import type { Command } from 'commander';

import { getPetOverlayPidFile } from '#/pet/dirs';
import { ensureElectronBinary, resolvePetOverlayEntry } from '#/pet/electron';
import { getVersion } from '#/cli/version';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface PetDeps {
  readonly ensureElectron: () => Promise<string>;
  readonly resolveOverlayEntry: () => string;
  readonly spawnProcess: typeof spawn;
  readonly pidFile: string;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly killProcess: (pid: number) => void;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
}

export interface PetOptions {
  readonly stop: boolean;
  readonly skin?: string;
}

export async function handlePet(deps: PetDeps, opts: PetOptions): Promise<void> {
  if (opts.stop) {
    stopPet(deps);
    return;
  }
  await startPet(deps, opts);
}

function readLivePid(deps: PetDeps): number | undefined {
  try {
    const raw = readFileSync(deps.pidFile, 'utf-8').trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isNaN(pid)) return undefined;
    return deps.isProcessAlive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function startPet(deps: PetDeps, opts: PetOptions): Promise<void> {
  const running = readLivePid(deps);
  if (running !== undefined) {
    deps.stdout.write(`kimi pet is already running (pid ${running}).\n`);
    return;
  }

  const overlayEntry = deps.resolveOverlayEntry();
  if (!existsSync(overlayEntry)) {
    deps.stderr.write(
      `Pet overlay bundle not found at ${overlayEntry}. Run \`pnpm build\` first if you are in a source checkout.\n`,
    );
    return deps.exit(1);
  }

  let electronBin: string;
  try {
    electronBin = await deps.ensureElectron();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    deps.stderr.write(`Failed to set up the pet runtime (Electron): ${msg}\n`);
    return deps.exit(1);
  }

  const child = deps.spawnProcess(electronBin, [overlayEntry], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      // Shown in the overlay's settings window (bottom-left version label).
      KIMI_PET_CLI_VERSION: getVersion(),
      ...(opts.skin === undefined ? {} : { KIMI_PET_SKIN: opts.skin }),
    },
  });
  child.unref();
  if (child.pid === undefined) {
    deps.stderr.write('Failed to start the pet overlay process.\n');
    return deps.exit(1);
  }
  mkdirSync(dirname(deps.pidFile), { recursive: true });
  writeFileSync(deps.pidFile, String(child.pid), 'utf-8');
  deps.stdout.write('kimi pet is on your desktop now. It will mirror your session status.\n');
}

function stopPet(deps: PetDeps): void {
  const pid = readLivePid(deps);
  if (pid === undefined) {
    rmSync(deps.pidFile, { force: true });
    deps.stdout.write('kimi pet is not running.\n');
    return;
  }
  try {
    deps.killProcess(pid);
  } catch {
    // Already gone.
  }
  rmSync(deps.pidFile, { force: true });
  deps.stdout.write('kimi pet stopped.\n');
}

export function registerPetCommand(parent: Command, overrides?: Partial<PetDeps>): void {
  parent
    .command('pet')
    .description('Launch the desktop pet that mirrors your session status.')
    .option('--stop', 'Stop the desktop pet.')
    .option(
      '--skin <name>',
      'Use a custom skin from <dataDir>/pet/pets/<name>/ (codex pet atlas format).',
    )
    .action(async (options: { stop?: boolean; skin?: string }) => {
      await handlePet(createDefaultPetDeps(overrides), {
        stop: options.stop === true,
        ...(options.skin === undefined ? {} : { skin: options.skin }),
      });
    });
}

function createDefaultPetDeps(overrides: Partial<PetDeps> = {}): PetDeps {
  return {
    ensureElectron: overrides.ensureElectron ?? (() => ensureElectronBinary()),
    resolveOverlayEntry: overrides.resolveOverlayEntry ?? resolvePetOverlayEntry,
    spawnProcess: overrides.spawnProcess ?? spawn,
    pidFile: overrides.pidFile ?? getPetOverlayPidFile(),
    isProcessAlive:
      overrides.isProcessAlive ??
      ((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }),
    killProcess: overrides.killProcess ?? ((pid) => process.kill(pid)),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    exit: overrides.exit ?? ((code: number) => process.exit(code)),
  };
}
