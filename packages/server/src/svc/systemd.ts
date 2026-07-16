

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { execFileUtf8, type ExecOptions, type ExecResult } from './exec';
import {
  buildInstallPlan,
  deleteInstallPlan,
  readInstallPlan,
  writeInstallPlan,
  type InstallPlan,
} from './install-plan';
import {
  KIMI_SERVER_SYSTEMD_UNIT,
  supervisorLogPath as defaultSupervisorLogPath,
  systemdUnitPath as defaultSystemdUnitPath,
} from './paths';
import { resolveSupervisorProgram } from './program';
import { buildSystemdUnit, parseSystemctlShow } from './systemd-unit';
import { ServiceUnavailableError } from './types';
import type {
  InstallArgs,
  InstallResult,
  LifecycleResult,
  ServiceManager,
  ServiceStatus,
} from './types';

const UNIT_MODE = 0o600;
const UNIT_DIR_MODE = 0o755;

export interface SystemdManagerDeps {

  execSystemctl(args: readonly string[], options?: ExecOptions): Promise<ExecResult>;

  resolveProgram(): string;

  unitPath(): string;

  logPath(): string;
}

const DEFAULT_DEPS: SystemdManagerDeps = {
  execSystemctl: (args, options) => execFileUtf8('systemctl', ['--user', ...args], options),
  resolveProgram: () => resolveSupervisorProgram(),
  unitPath: defaultSystemdUnitPath,
  logPath: defaultSupervisorLogPath,
};

export function createSystemdManager(
  overrides: Partial<SystemdManagerDeps> = {},
): ServiceManager {
  const deps: SystemdManagerDeps = { ...DEFAULT_DEPS, ...overrides };

  async function install(args: InstallArgs): Promise<InstallResult> {
    const unitPath = deps.unitPath();
    const logPath = deps.logPath();
    const program = deps.resolveProgram();
    const plan = buildInstallPlan({ ...args, program, logPath });

    const alreadyInstalled = existsSync(unitPath);
    if (alreadyInstalled && args.force !== true) {
      return {
        status: 'already-installed',
        message: `systemd unit already installed at ${unitPath}. Rerun with --force to replace it.`,
        unitPath,
      };
    }

    await assertUserSystemdAvailable(deps);

    writeUnit(unitPath, plan);
    writeInstallPlan(plan);

    const reload = await deps.execSystemctl(['daemon-reload']);
    if (reload.code !== 0) {
      throw new Error(
        `systemctl --user daemon-reload failed (code ${reload.code}): ${detail(reload) ?? 'unknown error'}`,
      );
    }

    const enable = await deps.execSystemctl(['enable', '--now', KIMI_SERVER_SYSTEMD_UNIT]);
    if (enable.code !== 0) {
      throw new Error(
        `systemctl --user enable --now failed (code ${enable.code}): ${detail(enable) ?? 'unknown error'}`,
      );
    }

    return {
      status: alreadyInstalled ? 'replaced' : 'installed',
      message: `Kimi server systemd unit ${alreadyInstalled ? 'replaced' : 'installed'} at ${unitPath} (port ${plan.port}).`,
      unitPath,
    };
  }

  async function uninstall(): Promise<LifecycleResult> {
    const unitPath = deps.unitPath();
    if (!existsSync(unitPath)) {
      deleteInstallPlan();
      return { ok: true, message: 'systemd unit was not installed; nothing to remove.' };
    }
    await deps.execSystemctl(['disable', '--now', KIMI_SERVER_SYSTEMD_UNIT]).catch(() => undefined);
    try {
      rmSync(unitPath, { force: true });
    } catch (error) {
      throw new Error(
        `failed to remove unit ${unitPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await deps.execSystemctl(['daemon-reload']).catch(() => undefined);
    deleteInstallPlan();
    return { ok: true, message: `systemd unit removed (${unitPath}).` };
  }

  async function start(): Promise<LifecycleResult> {
    if (!existsSync(deps.unitPath())) {
      return {
        ok: false,
        message: 'systemd unit is not installed. Run `kimi server install` first.',
      };
    }
    const result = await deps.execSystemctl(['start', KIMI_SERVER_SYSTEMD_UNIT]);
    if (result.code !== 0) {
      return {
        ok: false,
        message: `systemctl --user start failed: ${detail(result) ?? 'unknown error'}`,
      };
    }
    return { ok: true, message: `Kimi server started (${KIMI_SERVER_SYSTEMD_UNIT}).` };
  }

  async function stop(): Promise<LifecycleResult> {
    const result = await deps.execSystemctl(['stop', KIMI_SERVER_SYSTEMD_UNIT]);
    if (result.code !== 0) {
      return {
        ok: false,
        message: `systemctl --user stop failed: ${detail(result) ?? 'unknown error'}`,
      };
    }
    return { ok: true, message: `Kimi server stopped (${KIMI_SERVER_SYSTEMD_UNIT}).` };
  }

  async function restart(): Promise<LifecycleResult> {
    const result = await deps.execSystemctl(['restart', KIMI_SERVER_SYSTEMD_UNIT]);
    if (result.code !== 0) {
      return {
        ok: false,
        message: `systemctl --user restart failed: ${detail(result) ?? 'unknown error'}`,
      };
    }
    return { ok: true, message: `Kimi server restarted (${KIMI_SERVER_SYSTEMD_UNIT}).` };
  }

  async function status(): Promise<ServiceStatus> {
    const unitPath = deps.unitPath();
    const plan = readInstallPlan();
    const installed = existsSync(unitPath);

    const base: ServiceStatus = {
      platform: 'linux',
      installed,
      running: false,
      unitName: KIMI_SERVER_SYSTEMD_UNIT,
      ...(plan?.host !== undefined ? { host: plan.host } : {}),
      ...(plan?.port !== undefined ? { port: plan.port } : {}),
      logPath: deps.logPath(),
    };

    if (!installed) {
      return { ...base, notes: ['systemd unit is not installed.'] };
    }

    const show = await deps.execSystemctl([
      'show',
      KIMI_SERVER_SYSTEMD_UNIT,
      '--property=ActiveState,SubState,MainPID,ExecStart',
    ]);
    if (show.code !== 0) {
      return {
        ...base,
        notes: [
          `systemctl --user show failed (code ${show.code}): ${detail(show) ?? 'unknown'}.`,
          'The unit is on disk but systemd could not report its state.',
        ],
      };
    }
    const fields = parseSystemctlShow(show.stdout);
    const activeState = fields['ActiveState'];
    const subState = fields['SubState'];
    const mainPid = Number.parseInt(fields['MainPID'] ?? '', 10);
    const running = activeState === 'active' && subState !== 'failed';
    return {
      ...base,
      running,
      ...(Number.isFinite(mainPid) && mainPid > 0 ? { pid: mainPid } : {}),
      notes: [`systemd state: ${activeState ?? 'unknown'}/${subState ?? 'unknown'}`],
    };
  }

  return { install, uninstall, start, stop, restart, status };
}

async function assertUserSystemdAvailable(deps: SystemdManagerDeps): Promise<void> {
  const probe = await deps.execSystemctl(['show-environment']);
  if (probe.code === 0) return;

  throw new ServiceUnavailableError(
    'linux',
    `systemd --user is not available in this environment: ${detail(probe) ?? 'systemctl --user show-environment failed'}.`,
  );
}

function writeUnit(unitPath: string, plan: InstallPlan): void {
  const text = buildSystemdUnit({
    description: 'Kimi Code local server (managed by `kimi server install`)',
    programArguments: plan.programArguments,
  });
  mkdirSync(dirname(unitPath), { recursive: true, mode: UNIT_DIR_MODE });
  writeFileSync(unitPath, text, { mode: UNIT_MODE });
}

function detail(res: ExecResult): string | undefined {
  const text = (res.stderr || res.stdout).trim();
  return text.length > 0 ? text : undefined;
}
