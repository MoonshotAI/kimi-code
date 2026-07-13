

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileUtf8, type ExecOptions, type ExecResult } from './exec';
import {
  buildInstallPlan,
  deleteInstallPlan,
  readInstallPlan,
  writeInstallPlan,
  type InstallPlan,
} from './install-plan';
import { KIMI_SERVER_TASK_NAME, supervisorLogPath as defaultSupervisorLogPath } from './paths';
import { resolveSupervisorProgram } from './program';
import { buildScheduledTaskXml, parseSchtasksQuery } from './schtasks-xml';
import type {
  InstallArgs,
  InstallResult,
  LifecycleResult,
  ServiceManager,
  ServiceStatus,
} from './types';

export interface SchtasksManagerDeps {

  execSchtasks(args: readonly string[], options?: ExecOptions): Promise<ExecResult>;

  resolveProgram(): string;

  logPath(): string;

  writeTaskXml(xml: string): string;

  taskExists(): Promise<boolean>;
}

const DEFAULT_DEPS: SchtasksManagerDeps = {
  execSchtasks: (args, options) =>
    execFileUtf8('schtasks', args, { windowsHide: true, ...options }),
  resolveProgram: () => resolveSupervisorProgram(process.argv, process.cwd(), 'kimi.exe'),
  logPath: defaultSupervisorLogPath,
  writeTaskXml: defaultWriteTaskXml,
  taskExists: defaultTaskExists,
};

export function createSchtasksManager(
  overrides: Partial<SchtasksManagerDeps> = {},
): ServiceManager {
  const deps: SchtasksManagerDeps = { ...DEFAULT_DEPS, ...overrides };

  async function install(args: InstallArgs): Promise<InstallResult> {
    const program = deps.resolveProgram();
    const logPath = deps.logPath();
    const plan = buildInstallPlan({ ...args, program, logPath });

    const alreadyInstalled = await deps.taskExists();
    if (alreadyInstalled && args.force !== true) {
      return {
        status: 'already-installed',
        message: `Scheduled task "${KIMI_SERVER_TASK_NAME}" already exists. Rerun with --force to replace it.`,
        taskName: KIMI_SERVER_TASK_NAME,
      };
    }

    const argString = serializeArguments(plan);
    const xml = buildScheduledTaskXml({
      description: 'Kimi Code local server (managed by `kimi server install`)',
      command: plan.program,
      ...(argString.length > 0 ? { arguments: argString } : {}),
    });
    const xmlPath = deps.writeTaskXml(xml);

    try {
      const createArgs = ['/Create', '/TN', KIMI_SERVER_TASK_NAME, '/XML', xmlPath];
      if (alreadyInstalled) {
        createArgs.push('/F');
      }
      const create = await deps.execSchtasks(createArgs);
      if (create.code !== 0) {
        throw new Error(
          `schtasks /Create failed (code ${create.code}): ${detail(create) ?? 'unknown error'}`,
        );
      }
    } finally {

      try {
        rmSync(xmlPath, { force: true });
      } catch {

      }
    }

    writeInstallPlan(plan);


    const run = await deps.execSchtasks(['/Run', '/TN', KIMI_SERVER_TASK_NAME]);
    if (run.code !== 0) {

      return {
        status: alreadyInstalled ? 'replaced' : 'installed',
        message: `Task ${alreadyInstalled ? 'replaced' : 'installed'} but /Run failed: ${detail(run) ?? 'unknown error'}.`,
        taskName: KIMI_SERVER_TASK_NAME,
      };
    }

    return {
      status: alreadyInstalled ? 'replaced' : 'installed',
      message: `Kimi server scheduled task ${alreadyInstalled ? 'replaced' : 'installed'} (${KIMI_SERVER_TASK_NAME}, port ${plan.port}).`,
      taskName: KIMI_SERVER_TASK_NAME,
    };
  }

  async function uninstall(): Promise<LifecycleResult> {
    if (!(await deps.taskExists())) {
      deleteInstallPlan();
      return { ok: true, message: 'Scheduled task was not installed; nothing to remove.' };
    }

    await deps.execSchtasks(['/End', '/TN', KIMI_SERVER_TASK_NAME]).catch(() => undefined);
    const del = await deps.execSchtasks(['/Delete', '/TN', KIMI_SERVER_TASK_NAME, '/F']);
    if (del.code !== 0) {
      return {
        ok: false,
        message: `schtasks /Delete failed: ${detail(del) ?? 'unknown error'}`,
      };
    }
    deleteInstallPlan();
    return { ok: true, message: `Scheduled task removed (${KIMI_SERVER_TASK_NAME}).` };
  }

  async function start(): Promise<LifecycleResult> {
    if (!(await deps.taskExists())) {
      return {
        ok: false,
        message: 'Scheduled task is not installed. Run `kimi server install` first.',
      };
    }
    const result = await deps.execSchtasks(['/Run', '/TN', KIMI_SERVER_TASK_NAME]);
    if (result.code !== 0) {
      return {
        ok: false,
        message: `schtasks /Run failed: ${detail(result) ?? 'unknown error'}`,
      };
    }
    return { ok: true, message: `Kimi server started (${KIMI_SERVER_TASK_NAME}).` };
  }

  async function stop(): Promise<LifecycleResult> {
    const result = await deps.execSchtasks(['/End', '/TN', KIMI_SERVER_TASK_NAME]);
    if (result.code !== 0) {
      return {
        ok: false,
        message: `schtasks /End failed: ${detail(result) ?? 'unknown error'}`,
      };
    }
    return { ok: true, message: `Kimi server stopped (${KIMI_SERVER_TASK_NAME}).` };
  }

  async function restart(): Promise<LifecycleResult> {
    const end = await deps.execSchtasks(['/End', '/TN', KIMI_SERVER_TASK_NAME]);
    if (end.code !== 0) {
      return {
        ok: false,
        message: `schtasks /End failed during restart: ${detail(end) ?? 'unknown error'}`,
      };
    }
    const run = await deps.execSchtasks(['/Run', '/TN', KIMI_SERVER_TASK_NAME]);
    if (run.code !== 0) {
      return {
        ok: false,
        message: `schtasks /Run failed during restart: ${detail(run) ?? 'unknown error'}`,
      };
    }
    return { ok: true, message: `Kimi server restarted (${KIMI_SERVER_TASK_NAME}).` };
  }

  async function status(): Promise<ServiceStatus> {
    const plan = readInstallPlan();
    const installed = await deps.taskExists();

    const base: ServiceStatus = {
      platform: 'win32',
      installed,
      running: false,
      taskName: KIMI_SERVER_TASK_NAME,
      ...(plan?.host !== undefined ? { host: plan.host } : {}),
      ...(plan?.port !== undefined ? { port: plan.port } : {}),
      logPath: deps.logPath(),
    };

    if (!installed) {
      return { ...base, notes: ['Scheduled task is not installed.'] };
    }

    const query = await deps.execSchtasks([
      '/Query',
      '/TN',
      KIMI_SERVER_TASK_NAME,
      '/FO',
      'CSV',
      '/V',
    ]);
    if (query.code !== 0) {
      return {
        ...base,
        notes: [
          `schtasks /Query failed (code ${query.code}): ${detail(query) ?? 'unknown'}.`,
          'The task is registered but its state could not be read.',
        ],
      };
    }
    const row = parseSchtasksQuery(query.stdout);
    const taskStatus = row?.['Status'];
    const running = taskStatus === 'Running';
    return {
      ...base,
      running,
      notes: [`schtasks status: ${taskStatus ?? 'unknown'}`],
    };
  }

  return { install, uninstall, start, stop, restart, status };
}


function defaultWriteTaskXml(xml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-server-task-'));
  const xmlPath = join(dir, 'task.xml');
  const bom = Buffer.from([0xff, 0xfe]);
  const body = Buffer.from(xml, 'utf16le');
  writeFileSync(xmlPath, Buffer.concat([bom, body]));
  return xmlPath;
}


async function defaultTaskExists(): Promise<boolean> {
  const res = await execFileUtf8('schtasks', ['/Query', '/TN', KIMI_SERVER_TASK_NAME], {
    windowsHide: true,
  });
  return res.code === 0;
}


function serializeArguments(plan: InstallPlan): string {

  return plan.programArguments
    .slice(1)
    .map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg))
    .join(' ');
}

function detail(res: ExecResult): string | undefined {
  const text = (res.stderr || res.stdout).trim();
  return text.length > 0 ? text : undefined;
}


export function taskXmlExists(path: string): boolean {
  return existsSync(path);
}
