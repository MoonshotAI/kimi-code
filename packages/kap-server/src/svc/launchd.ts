

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
import { buildLaunchAgentPlist } from './launchd-plist';
import {
  guiDomain as defaultGuiDomain,
  KIMI_SERVER_LABEL,
  launchAgentPlistPath as defaultLaunchAgentPlistPath,
  supervisorLogPath as defaultSupervisorLogPath,
} from './paths';
import { resolveSupervisorProgram } from './program';
import type {
  InstallArgs,
  InstallResult,
  LifecycleResult,
  ServiceManager,
  ServiceStatus,
} from './types';

const PLIST_MODE = 0o600;
const LAUNCH_AGENT_DIR_MODE = 0o755;

export interface LaunchdManagerDeps {

  execLaunchctl(args: readonly string[], options?: ExecOptions): Promise<ExecResult>;

  resolveProgram(): string;

  plistPath(): string;

  logPath(): string;

  guiDomain(): string;
}

const DEFAULT_DEPS: LaunchdManagerDeps = {
  execLaunchctl: (args, options) => execFileUtf8('launchctl', args, options),
  resolveProgram: () => resolveSupervisorProgram(),
  plistPath: defaultLaunchAgentPlistPath,
  logPath: defaultSupervisorLogPath,
  guiDomain: () => defaultGuiDomain(),
};

export { resolveSupervisorProgram };


export function createLaunchdManager(
  overrides: Partial<LaunchdManagerDeps> = {},
): ServiceManager {
  const deps: LaunchdManagerDeps = { ...DEFAULT_DEPS, ...overrides };

  async function install(args: InstallArgs): Promise<InstallResult> {
    const plistPath = deps.plistPath();
    const logPath = deps.logPath();
    const program = deps.resolveProgram();
    const plan = buildInstallPlan({ ...args, program, logPath });

    const alreadyInstalled = existsSync(plistPath);
    if (alreadyInstalled && args.force !== true) {
      return {
        status: 'already-installed',
        message: `LaunchAgent already installed at ${plistPath}. Rerun with --force to replace it.`,
        plistPath,
      };
    }

    if (alreadyInstalled) {

      await bestEffortBootout(deps);
    }

    writePlist(plistPath, plan, logPath);
    writeInstallPlan(plan);

    const bootstrap = await deps.execLaunchctl(['bootstrap', deps.guiDomain(), plistPath]);
    if (bootstrap.code !== 0 && !isAlreadyLoaded(bootstrap)) {
      throw new Error(
        `launchctl bootstrap failed (code ${bootstrap.code}): ${detail(bootstrap) ?? 'unknown error'}`,
      );
    }

    return {
      status: alreadyInstalled ? 'replaced' : 'installed',
      message: `Kimi server LaunchAgent ${alreadyInstalled ? 'replaced' : 'installed'} at ${plistPath} (port ${plan.port}).`,
      plistPath,
    };
  }

  async function uninstall(): Promise<LifecycleResult> {
    const plistPath = deps.plistPath();
    const installed = existsSync(plistPath);
    if (!installed) {
      deleteInstallPlan();
      return { ok: true, message: 'LaunchAgent was not installed; nothing to remove.' };
    }
    const bootout = await deps.execLaunchctl([
      'bootout',
      `${deps.guiDomain()}/${KIMI_SERVER_LABEL}`,
    ]);

    void bootout;
    try {
      rmSync(plistPath, { force: true });
    } catch (error) {
      throw new Error(
        `failed to remove plist ${plistPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    deleteInstallPlan();
    return { ok: true, message: `LaunchAgent removed (${plistPath}).` };
  }

  async function start(): Promise<LifecycleResult> {
    const plistPath = deps.plistPath();
    if (!existsSync(plistPath)) {
      return {
        ok: false,
        message: 'LaunchAgent is not installed. Run `kimi server install` first.',
      };
    }
    const target = `${deps.guiDomain()}/${KIMI_SERVER_LABEL}`;

    const result = await deps.execLaunchctl(['kickstart', '-k', target]);
    if (result.code !== 0) {

      const bootstrap = await deps.execLaunchctl(['bootstrap', deps.guiDomain(), plistPath]);
      if (bootstrap.code !== 0 && !isAlreadyLoaded(bootstrap)) {
        return {
          ok: false,
          message: `launchctl kickstart + bootstrap both failed: ${detail(result) ?? 'unknown'} / ${detail(bootstrap) ?? 'unknown'}`,
        };
      }
      const retry = await deps.execLaunchctl(['kickstart', target]);
      if (retry.code !== 0) {
        return {
          ok: false,
          message: `launchctl kickstart failed after bootstrap: ${detail(retry) ?? 'unknown error'}`,
        };
      }
    }
    return { ok: true, message: `Kimi server started (${KIMI_SERVER_LABEL}).` };
  }

  async function stop(): Promise<LifecycleResult> {
    const target = `${deps.guiDomain()}/${KIMI_SERVER_LABEL}`;
    const result = await deps.execLaunchctl(['kill', 'SIGTERM', target]);
    if (result.code !== 0) {

      const bootout = await deps.execLaunchctl(['bootout', target]);
      if (bootout.code !== 0) {
        return {
          ok: false,
          message: `launchctl kill + bootout both failed: ${detail(result) ?? 'unknown'} / ${detail(bootout) ?? 'unknown'}`,
        };
      }
    }
    return { ok: true, message: `Kimi server stopped (${KIMI_SERVER_LABEL}).` };
  }

  async function restart(): Promise<LifecycleResult> {
    const target = `${deps.guiDomain()}/${KIMI_SERVER_LABEL}`;
    const result = await deps.execLaunchctl(['kickstart', '-k', target]);
    if (result.code !== 0) {
      return {
        ok: false,
        message: `launchctl kickstart -k failed: ${detail(result) ?? 'unknown error'}`,
      };
    }
    return { ok: true, message: `Kimi server restarted (${KIMI_SERVER_LABEL}).` };
  }

  async function status(): Promise<ServiceStatus> {
    const plistPath = deps.plistPath();
    const plan = readInstallPlan();
    const installed = existsSync(plistPath);

    const base: ServiceStatus = {
      platform: 'darwin',
      installed,
      running: false,
      label: KIMI_SERVER_LABEL,
      ...(plan?.host !== undefined ? { host: plan.host } : {}),
      ...(plan?.port !== undefined ? { port: plan.port } : {}),
      logPath: deps.logPath(),
    };

    if (!installed) {
      return { ...base, notes: ['LaunchAgent is not installed.'] };
    }

    const print = await deps.execLaunchctl(['print', `${deps.guiDomain()}/${KIMI_SERVER_LABEL}`]);
    if (print.code !== 0) {
      return {
        ...base,
        notes: [
          `launchctl print failed (code ${print.code}): ${detail(print) ?? 'unknown'}.`,
          'The plist is on disk but the service is not loaded.',
        ],
      };
    }
    const info = parseLaunchctlPrint(print.stdout);
    const notes =
      info.state !== undefined
        ? [`launchd state: ${info.state}`]
        : ['launchd state: unknown'];
    if (info.lastExitCode !== undefined) {
      notes.push(`last exit code: ${info.lastExitCode}`);
    }
    return {
      ...base,
      running: info.state === 'running' || info.pid !== undefined,
      ...(info.pid !== undefined ? { pid: info.pid } : {}),
      notes,
    };
  }

  return { install, uninstall, start, stop, restart, status };
}


export function parseLaunchctlPrint(output: string): {
  state?: string;
  pid?: number;
  lastExitCode?: string;
} {
  const result: { state?: string; pid?: number; lastExitCode?: string } = {};
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const equalsIdx = line.indexOf('=');
    if (equalsIdx === -1) continue;
    const key = line.slice(0, equalsIdx).trim().toLowerCase();
    const value = line.slice(equalsIdx + 1).trim();
    if (key === 'state' && result.state === undefined) {
      result.state = value;
    } else if (key === 'pid' && result.pid === undefined) {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n > 0) {
        result.pid = n;
      }
    } else if ((key === 'last exit code' || key === 'last exit status') && result.lastExitCode === undefined) {
      result.lastExitCode = value;
    }
  }
  return result;
}

function writePlist(plistPath: string, plan: InstallPlan, logPath: string): void {
  const xml = buildLaunchAgentPlist({
    label: KIMI_SERVER_LABEL,
    comment: 'Kimi Code local server (managed by `kimi server install`).',
    programArguments: plan.programArguments,
    stdoutPath: logPath,
    stderrPath: logPath,
  });
  mkdirSync(dirname(plistPath), { recursive: true, mode: LAUNCH_AGENT_DIR_MODE });
  writeFileSync(plistPath, xml, { mode: PLIST_MODE });
}

async function bestEffortBootout(deps: LaunchdManagerDeps): Promise<void> {
  await deps.execLaunchctl(['bootout', `${deps.guiDomain()}/${KIMI_SERVER_LABEL}`]).catch(() => {

  });
}

function isAlreadyLoaded(res: ExecResult): boolean {
  const message = (res.stderr || res.stdout).toLowerCase();
  return res.code === 130 || message.includes('already loaded') || message.includes('service already loaded');
}

function detail(res: ExecResult): string | undefined {
  const text = (res.stderr || res.stdout).trim();
  return text.length > 0 ? text : undefined;
}
