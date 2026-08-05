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
 * Installs are detect-first and idempotent: setup always refreshes the wiring
 * plugin, only unsatisfied runtime layers are redone, and setup re-enables a
 * previously disabled wiring plugin (and its
 * MCP servers), the app step requires an executable binary with bundle
 * metadata, the archive is staged and unpacked before the old service is
 * stopped, and cleanup of old processes is best-effort — a wedged old
 * binary turns CLI probes into failed steps or is skipped past, never
 * blocking the replacement.
 */

import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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
const DETECT_PROBE_TIMEOUT_MS = 3_000;

interface PermissionStatus {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
}

interface LegacyMcpFile {
  readonly raw: string;
  readonly value: Record<string, unknown>;
  readonly servers: Record<string, unknown>;
}

export function parsePermissionStatus(output: string): PermissionStatus | undefined {
  const match =
    /(?:permissions|permissionStatus):\s*accessibility=(true|false)\s+screenRecording=(true|false)/.exec(
      output,
    );
  if (match === null) return undefined;
  return { accessibility: match[1] === 'true', screenRecording: match[2] === 'true' };
}

export async function readAppBundleVersion(infoPlistPath: string): Promise<string | undefined> {
  try {
    const xml = await readFile(infoPlistPath, 'utf-8');
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function appleScriptQuote(script: string): string {
  return script.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseLegacyMcpFile(raw: string, appBin: string): LegacyMcpFile | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const root = objectRecord(value);
  const servers = objectRecord(root?.['mcpServers']);
  const legacy = objectRecord(servers?.['kimi-cu']);
  if (root === undefined || servers === undefined || legacy === undefined) return undefined;
  if (legacy['command'] !== appBin) return undefined;
  if (legacy['enabled'] === false) return undefined;
  const args = legacy['args'];
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return undefined;
  const isKnownArgs =
    (args.length === 1 && args[0] === 'mcp') ||
    (args.length === 3 && args[0] === 'mcp' && args[1] === '-s' && args[2] === 'user');
  if (!isKnownArgs) return undefined;
  const knownKeys = new Set(['args', 'command']);
  if (Object.keys(legacy).some((key) => !knownKeys.has(key))) return undefined;
  return { raw, value: root, servers };
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function elevatedDittoScript(from: string, to: string): string {
  return `/usr/bin/ditto ${shQuote(from)} ${shQuote(to)}`;
}

export function createKimiCuEntry(ctx: CapabilityEntryContext): CapabilityEntry {
  const applicationsDir = ctx.applicationsDir ?? '/Applications';
  const appPath = path.join(applicationsDir, APP_BUNDLE);
  const appBin = path.join(appPath, 'Contents', 'MacOS', 'kimi-cu');
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
  const probeTimeoutMs = ctx.detectProbeTimeoutMs ?? DETECT_PROBE_TIMEOUT_MS;
  const commandTimeoutMs = ctx.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  const supported = ctx.platform === 'darwin';
  const userMcpConfigPath = path.join(ctx.kimiHomeDir, 'mcp.json');

  async function exists(p: string): Promise<boolean> {
    return access(p).then(
      () => true,
      () => false,
    );
  }

  async function executable(p: string): Promise<boolean> {
    return access(p, constants.X_OK).then(
      () => true,
      () => false,
    );
  }

  async function serviceRunning(): Promise<boolean> {
    if (!(await exists(appBin))) return false;
    const result = await runCommand(ctx.hostProcess, appBin, ['service-status'], {
      timeout: probeTimeoutMs,
    });
    return /status=1\b/.test(result.stdout);
  }

  async function permissionStatus(): Promise<PermissionStatus | undefined> {
    if (!(await exists(appBin))) return undefined;
    const result = await runCommand(ctx.hostProcess, appBin, ['xpc-ping'], {
      timeout: probeTimeoutMs,
    });
    return parsePermissionStatus(result.stdout);
  }

  async function legacyMcpFile(): Promise<LegacyMcpFile | undefined> {
    try {
      return parseLegacyMcpFile(await readFile(userMcpConfigPath, 'utf8'), appBin);
    } catch {
      return undefined;
    }
  }

  async function removeLegacyMcpRegistration(
    legacy: LegacyMcpFile | undefined,
  ): Promise<boolean> {
    if (legacy === undefined) return false;

    const nextServers = { ...legacy.servers };
    delete nextServers['kimi-cu'];
    const next = { ...legacy.value, mcpServers: nextServers };
    const mode = (await stat(userMcpConfigPath)).mode & 0o777;
    const tempPath = `${userMcpConfigPath}.kimi-cu-migration-${process.pid}-${Date.now()}`;
    try {
      await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode,
      });
      if ((await readFile(userMcpConfigPath, 'utf8')) !== legacy.raw) return false;
      await rename(tempPath, userMcpConfigPath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
    return true;
  }

  async function detect(): Promise<CapabilityDetectResult> {
    const steps: CapabilityStep[] = [];

    const installed = await ctx.plugins.listPlugins();
    const plugin = installed.find((p) => p.id === PLUGIN_ID);
    const mcpGap =
      plugin !== undefined && plugin.enabledMcpServerCount < plugin.mcpServerCount
        ? `mcp ${plugin.enabledMcpServerCount}/${plugin.mcpServerCount} enabled`
        : undefined;
    const pluginOk =
      plugin !== undefined &&
      plugin.enabled &&
      plugin.state === 'ok' &&
      plugin.enabledMcpServerCount === plugin.mcpServerCount;
    steps.push({
      id: 'plugin',
      state: pluginOk ? 'ok' : 'missing',
      detail: mcpGap ?? plugin?.version,
    });

    if ((await legacyMcpFile()) !== undefined) {
      steps.push({
        id: 'legacy-mcp',
        state: 'missing',
        detail: 'duplicate standalone kimi-cu MCP registration',
        optional: true,
      });
    }

    const version = await readAppBundleVersion(infoPlist);
    const appExists = await exists(appBin);
    const appUsable = appExists && (await executable(appBin)) && (await exists(infoPlist));
    steps.push({
      id: 'app',
      state: appUsable ? 'ok' : 'missing',
      detail: appExists && !appUsable ? 'not executable' : version,
    });

    try {
      steps.push({ id: 'service', state: (await serviceRunning()) ? 'ok' : 'missing' });
    } catch (error) {
      steps.push({ id: 'service', state: 'failed', detail: errorMessage(error) });
    }

    let permissions: PermissionStatus | undefined;
    let permissionsProbeError: string | undefined;
    try {
      permissions = await permissionStatus();
    } catch (error) {
      permissionsProbeError = errorMessage(error);
    }
    if (permissionsProbeError !== undefined) {
      steps.push({ id: 'permissions', state: 'failed', detail: permissionsProbeError });
    } else {
      const granted =
        permissions !== undefined && permissions.accessibility && permissions.screenRecording;
      const missingPermissions = permissions === undefined
        ? undefined
        : [
            ...(permissions.accessibility ? [] : ['accessibility']),
            ...(permissions.screenRecording ? [] : ['screenRecording']),
          ].join(',');
      steps.push({
        id: 'permissions',
        state: granted ? 'ok' : 'missing',
        detail:
          granted || missingPermissions === undefined || missingPermissions.length === 0
            ? undefined
            : missingPermissions,
      });
    }

    return {
      steps,
      version: version ?? plugin?.version,
    };
  }

  async function bestEffort(command: string, args: readonly string[]): Promise<void> {
    await runCommand(ctx.hostProcess, command, args, { timeout: commandTimeoutMs }).catch(
      () => undefined,
    );
  }

  async function stopOldProcesses(): Promise<void> {
    const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '501';
    if (await exists(appBin)) {
      await bestEffort(appBin, ['uninstall']);
    }
    await bestEffort('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]);
    // Keep connected MCP frontends alive while the app bundle is replaced.
    // Their work is delegated to the service below; killing them makes the
    // client report an installation-driven restart as an unexpected failure.
    for (const mode of ['service', 'overlay']) {
      await bestEffort('pkill', ['-f', `${APP_BUNDLE}/Contents/MacOS/kimi-cu[[:space:]]+${mode}`]);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1_000);
    });
  }

  async function moveAppIntoPlace(unzippedApp: string): Promise<void> {
    await rm(appPath, { recursive: true, force: true }).catch(() => undefined);
    const direct = await runCommand(ctx.hostProcess, 'ditto', [unzippedApp, appPath], {
      timeout: commandTimeoutMs,
    });
    if (direct.code === 0) return;
    const script = appleScriptQuote(elevatedDittoScript(unzippedApp, appPath));
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
    const legacyMcpBefore = await legacyMcpFile();
    const stepStates = new Map(before.steps.map((step) => [step.id, step.state]));
    const readyBefore = before.steps
      .filter((step) => step.optional !== true)
      .every((step) => step.state === 'ok');

    report('plugin');
    const summary = await ctx.plugins.installPlugin({ source: PLUGIN_ZIP_URL });
    if (!summary.enabled) {
      await ctx.plugins.setPluginEnabled({ id: PLUGIN_ID, enabled: true });
    }
    if (summary.enabledMcpServerCount < summary.mcpServerCount) {
      const info = await ctx.plugins.getPluginInfo({ id: PLUGIN_ID });
      for (const server of info.mcpServers) {
        if (!server.enabled) {
          await ctx.plugins.setPluginMcpServerEnabled({
            id: PLUGIN_ID,
            server: server.name,
            enabled: true,
          });
        }
      }
    }

    // A read-only or concurrently edited user config must not block the app
    // installation. Detection keeps the duplicate as an optional warning so
    // clients can record it in logs and a later install can retry migration.
    if (await removeLegacyMcpRegistration(legacyMcpBefore).catch(() => false)) {
      report('mcp-config');
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
        const unzipDir = path.join(workDir, 'unzipped');
        const unzipped = await runCommand(ctx.hostProcess, 'ditto', ['-x', '-k', zipPath, unzipDir], {
          timeout: 120_000,
        });
        if (unzipped.code !== 0) {
          throw new Error(`Failed to unzip KimiCU.app: ${unzipped.stderr || unzipped.stdout}`);
        }
        await stopOldProcesses();
        await moveAppIntoPlace(path.join(unzipDir, APP_BUNDLE));
        await runCommand(ctx.hostProcess, 'xattr', ['-dr', 'com.apple.quarantine', appPath], {
          timeout: commandTimeoutMs,
        });
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    if (installApp || stepStates.get('service') !== 'ok') {
      report('service');
      const registered = await runCommand(ctx.hostProcess, appBin, ['install'], {
        timeout: commandTimeoutMs,
      });
      if (registered.code !== 0) {
        throw new Error(`kimi-cu install failed: ${registered.stderr || registered.stdout}`);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      });
      const running = await serviceRunning().catch(() => false);
      if (!running) {
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
