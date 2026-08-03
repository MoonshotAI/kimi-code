/**
 * `kimi-cu` capability entry (macOS only).
 *
 * Layers: the official `kimi-cu` plugin (stdio MCP wrapper + skill) +
 * KimiCU.app (`/Applications`, launchd background service) + TCC
 * permissions (accessibility + screen recording — the user must grant
 * these; they can never be set programmatically).
 *
 * The install replicates the official `setup_macos.sh` step-for-step
 * (stop old processes → ditto into /Applications → register service →
 * request permissions) with structured progress and errors instead of a
 * shell pipe. Elevation when /Applications is not writable goes through
 * `osascript ... with administrator privileges` (native auth dialog).
 */

import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { downloadToFile, runCommand } from '../host';
import type {
  CapabilityDetectResult,
  CapabilityEntry,
  CapabilityInstallReporter,
  CapabilityStep,
} from '../types';
import type { CapabilityEntryContext } from './context';

const PLUGIN_ID = 'kimi-cu';
const PLUGIN_ZIP_URL = 'https://cdn.kimi.com/kimi-computer-use/latest/kimi-cu-plugin.zip';
const APP_ZIP_URL = 'https://cdn.kimi.com/kimi-computer-use/latest/KimiCU.app.zip';
const APP_BUNDLE = 'KimiCU.app';
const LAUNCHD_LABEL = 'ai.kimi.cu.service';
const COMMAND_TIMEOUT_MS = 30_000;
const PERMISSIONS_TIMEOUT_MS = 15_000;

interface PermissionStatus {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
}

export function parsePermissionStatus(output: string): PermissionStatus | undefined {
  const match =
    /(?:permissions|permissionStatus):\s*accessibility=(true|false)\s+screenRecording=(true|false)/.exec(
      output,
    );
  if (match === null) return undefined;
  return { accessibility: match[1] === 'true', screenRecording: match[2] === 'true' };
}

/** Read CFBundleShortVersionString from an .app bundle's Info.plist (XML). */
export async function readAppBundleVersion(infoPlistPath: string): Promise<string | undefined> {
  try {
    const xml = await readFile(infoPlistPath, 'utf-8');
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/** Escape a shell snippet for embedding in an AppleScript double-quoted string. */
function appleScriptQuote(script: string): string {
  return script.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export function createKimiCuEntry(ctx: CapabilityEntryContext): CapabilityEntry {
  const applicationsDir = ctx.applicationsDir ?? '/Applications';
  const appPath = path.join(applicationsDir, APP_BUNDLE);
  const appBin = path.join(appPath, 'Contents', 'MacOS', 'kimi-cu');
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
  const supported = ctx.platform === 'darwin';

  async function exists(p: string): Promise<boolean> {
    return access(p).then(
      () => true,
      () => false,
    );
  }

  async function serviceRunning(): Promise<boolean> {
    if (!(await exists(appBin))) return false;
    const result = await runCommand(ctx.hostProcess, appBin, ['service-status'], {
      timeout: COMMAND_TIMEOUT_MS,
    });
    // `SMAppService status=1` means enabled (1=enabled, 2=requiresApproval, 3=notFound).
    return /status=1\b/.test(result.stdout);
  }

  async function permissionStatus(): Promise<PermissionStatus | undefined> {
    if (!(await exists(appBin))) return undefined;
    const result = await runCommand(ctx.hostProcess, appBin, ['xpc-ping'], {
      timeout: PERMISSIONS_TIMEOUT_MS,
    });
    return parsePermissionStatus(result.stdout);
  }

  async function detect(): Promise<CapabilityDetectResult> {
    const steps: CapabilityStep[] = [];

    const installed = await ctx.plugins.listPlugins();
    const plugin = installed.find((p) => p.id === PLUGIN_ID);
    const pluginOk = plugin !== undefined && plugin.enabled && plugin.state === 'ok';
    steps.push({
      id: 'plugin',
      state: pluginOk ? 'ok' : 'missing',
      ...(plugin?.version !== undefined ? { detail: plugin.version } : {}),
    });

    const version = await readAppBundleVersion(infoPlist);
    const appPresent = await exists(appBin);
    steps.push({
      id: 'app',
      state: appPresent ? 'ok' : 'missing',
      ...(version !== undefined ? { detail: version } : {}),
    });

    steps.push({ id: 'service', state: (await serviceRunning()) ? 'ok' : 'missing' });

    const permissions = await permissionStatus();
    const granted = permissions !== undefined && permissions.accessibility && permissions.screenRecording;
    const missingPermissions = permissions === undefined
      ? undefined
      : [
          ...(permissions.accessibility ? [] : ['accessibility']),
          ...(permissions.screenRecording ? [] : ['screenRecording']),
        ].join(',');
    steps.push({
      id: 'permissions',
      state: granted ? 'ok' : 'missing',
      ...(granted || missingPermissions === undefined || missingPermissions.length === 0
        ? {}
        : { detail: missingPermissions }),
    });

    return {
      steps,
      ...(version !== undefined ? { version } : plugin?.version !== undefined ? { version: plugin.version } : {}),
    };
  }

  async function stopOldProcesses(): Promise<void> {
    const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '501';
    // All best-effort: mirrors the official script's `|| true` guards.
    if (await exists(appBin)) {
      await runCommand(ctx.hostProcess, appBin, ['uninstall'], { timeout: COMMAND_TIMEOUT_MS });
    }
    await runCommand(ctx.hostProcess, 'launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`], {
      timeout: COMMAND_TIMEOUT_MS,
    });
    for (const mode of ['mcp', 'service', 'overlay']) {
      await runCommand(
        ctx.hostProcess,
        'pkill',
        ['-f', `${APP_BUNDLE}/Contents/MacOS/kimi-cu[[:space:]]+${mode}`],
        { timeout: COMMAND_TIMEOUT_MS },
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
  }

  async function moveAppIntoPlace(unzippedApp: string): Promise<void> {
    await rm(appPath, { recursive: true, force: true }).catch(() => undefined);
    const direct = await runCommand(ctx.hostProcess, 'ditto', [unzippedApp, appPath], {
      timeout: COMMAND_TIMEOUT_MS,
    });
    if (direct.code === 0) return;
    // /Applications not writable → elevate via the native auth dialog.
    const script = `/usr/bin/ditto ${appleScriptQuote(unzippedApp)} ${appleScriptQuote(appPath)}`;
    const elevated = await runCommand(
      ctx.hostProcess,
      'osascript',
      ['-e', `do shell script "${script}" with administrator privileges`],
      { timeout: 120_000 },
    );
    if (elevated.code !== 0) {
      throw new Error(
        `Failed to install ${APP_BUNDLE} into ${applicationsDir} ` +
          `(direct: ${direct.stderr.trim() || direct.code}; elevated: ${elevated.stderr.trim() || elevated.code})`,
      );
    }
  }

  async function install(report: CapabilityInstallReporter): Promise<void> {
    if (!supported) {
      throw new Error(`kimi-cu is only supported on macOS (current: ${ctx.platform})`);
    }

    const before = await detect();
    const stepStates = new Map(before.steps.map((step) => [step.id, step.state]));
    const readyBefore = before.steps
      .filter((step) => step.optional !== true)
      .every((step) => step.state === 'ok');

    if (stepStates.get('plugin') !== 'ok' || readyBefore) {
      report('plugin');
      await ctx.plugins.installPlugin({ source: PLUGIN_ZIP_URL });
    }

    const installApp = stepStates.get('app') !== 'ok' || readyBefore;
    if (installApp) {
      const workDir = await mkdtemp(path.join(tmpdir(), 'kimi-cu-install-'));
      try {
        report('download', 0);
        const zipPath = path.join(workDir, 'KimiCU.app.zip');
        await downloadToFile(
          APP_ZIP_URL,
          zipPath,
          (percent) => {
            report('download', percent);
          },
          ctx.fetchImpl,
        );

        report('app');
        await stopOldProcesses();
        const unzipDir = path.join(workDir, 'unzipped');
        const unzipped = await runCommand(ctx.hostProcess, 'ditto', ['-x', '-k', zipPath, unzipDir], {
          timeout: 120_000,
        });
        if (unzipped.code !== 0) {
          throw new Error(`Failed to unzip KimiCU.app: ${unzipped.stderr || unzipped.stdout}`);
        }
        await moveAppIntoPlace(path.join(unzipDir, APP_BUNDLE));
        await runCommand(ctx.hostProcess, 'xattr', ['-dr', 'com.apple.quarantine', appPath], {
          timeout: COMMAND_TIMEOUT_MS,
        });
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    if (installApp || stepStates.get('service') !== 'ok') {
      report('service');
      const registered = await runCommand(ctx.hostProcess, appBin, ['install'], {
        timeout: COMMAND_TIMEOUT_MS,
      });
      if (registered.code !== 0) {
        throw new Error(`kimi-cu install failed: ${registered.stderr || registered.stdout}`);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      });
      if (!(await serviceRunning())) {
        throw new Error('kimi-cu background service is not running after install');
      }
    }

    if (stepStates.get('permissions') !== 'ok') {
      report('permissions');
      await runCommand(
        ctx.hostProcess,
        appBin,
        ['request-permissions', '--ax', '--screen'],
        { timeout: PERMISSIONS_TIMEOUT_MS },
      ).catch(() => undefined);
    }
  }

  return {
    id: 'kimi-cu',
    displayName: 'Kimi Computer Use',
    description:
      'macOS GUI automation in the background — read app UIs and click, type, scroll, and drag without taking over your mouse or foregrounding apps.',
    supported,
    detect,
    install,
  };
}
