/**
 * `kimi-cu` capability entry (macOS and Windows).
 *
 * Both platforms share the same product capability and plugin wiring flow.
 * macOS adds KimiCU.app + launchd + TCC permissions; Windows uses the
 * official signed runtime installer and its built-in `doctor` command.
 *
 * The macOS path replicates the official `setup_macos.sh` step-for-step
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
 * The Windows path downloads and runs the official `setup_windows.ps1`, so
 * its signature verification, rollback, and agent autostart stay upstream.
 * It selects a trusted PowerShell installation that satisfies the script's
 * command requirements before changing plugin wiring.
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

const MAC_PLUGIN = {
  id: 'kimi-cu',
  zipUrl: 'https://cdn.kimi.com/kimi-computer-use/latest/kimi-cu-plugin.zip',
} as const;
const WINDOWS_PLUGIN = {
  id: 'kimi-cu-win',
  zipUrl:
    'https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-plugin.zip',
} as const;
const APP_ZIP_URL = 'https://cdn.kimi.com/kimi-computer-use/latest/KimiCU.app.zip';
const WINDOWS_SETUP_URL =
  'https://cdn.kimi.com/kimi-computer-use-windows/latest/setup_windows.ps1';
const APP_BUNDLE = 'KimiCU.app';
const LAUNCHD_LABEL = 'ai.kimi.cu.service';
const COMMAND_TIMEOUT_MS = 30_000;
const PERMISSIONS_TIMEOUT_MS = 15_000;
const DETECT_PROBE_TIMEOUT_MS = 3_000;
const WINDOWS_INSTALLER_PROBE_TIMEOUT_MS = 10_000;
const WINDOWS_INSTALL_TIMEOUT_MS = 180_000;
const DEFAULT_WINDOWS_SYSTEM_ROOT = 'C:\\Windows';
const DEFAULT_WINDOWS_PROGRAM_FILES = 'C:\\Program Files';
const WINDOWS_INSTALLER_PROBE_SCRIPT =
  "$required = @('Get-FileHash', 'Expand-Archive', 'Get-AuthenticodeSignature', 'Get-CimInstance', 'Invoke-WebRequest', 'Invoke-RestMethod', 'ConvertFrom-Json', 'ConvertTo-Json'); " +
  '$missing = @($required | Where-Object { -not (Get-Command $_ -CommandType Cmdlet,Function -ErrorAction SilentlyContinue) }); ' +
  '$issues = @(); ' +
  "if ($PSVersionTable.PSVersion -lt [Version]'5.1') { $issues += ('requires PowerShell 5.1 or newer; found ' + $PSVersionTable.PSVersion) }; " +
  "if ($missing.Count -gt 0) { $issues += ('missing commands: ' + ($missing -join ', ')) }; " +
  "if ($issues.Count -gt 0) { [Console]::Error.Write(($issues -join '; ')); exit 2 }; " +
  "[Console]::Out.Write(('PowerShell ' + $PSVersionTable.PSVersion));";
const WINDOWS_DOCTOR_SCRIPT =
  '$candidates = @($env:KIMI_CU_WINDOWS_EXE); ' +
  "if ($env:KIMI_CU_WINDOWS_HOME) { $candidates += (Join-Path $env:KIMI_CU_WINDOWS_HOME 'kimi-cu.exe') }; " +
  "if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'KimiCU\\kimi-cu.exe') }; " +
  "if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'KimiCU\\kimi-cu.exe') }; " +
  "$exe = $candidates | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1; " +
  'if (-not $exe) { exit 3 }; & $exe doctor; exit $LASTEXITCODE';

interface PluginLayerConfig {
  readonly id: string;
  readonly zipUrl: string;
}

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

export function parseWindowsDoctorOutput(
  output: string,
): { readonly version?: string } | undefined {
  const fields = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  if (fields.get('mcp') !== 'true' || fields.get('helper') !== 'embedded') return undefined;
  const version = fields.get('version');
  return version === undefined ? {} : { version };
}

export function windowsPowerShellPath(
  systemRoot = process.env['SystemRoot'] ?? DEFAULT_WINDOWS_SYSTEM_ROOT,
): string {
  const root = path.win32.isAbsolute(systemRoot) ? systemRoot : DEFAULT_WINDOWS_SYSTEM_ROOT;
  return path.win32.join(
    root,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

export function windowsPowerShell7Path(
  programFiles =
    process.env['ProgramW6432'] ??
    process.env['ProgramFiles'] ??
    DEFAULT_WINDOWS_PROGRAM_FILES,
): string {
  const root = path.win32.isAbsolute(programFiles)
    ? programFiles
    : DEFAULT_WINDOWS_PROGRAM_FILES;
  return path.win32.join(root, 'PowerShell', '7', 'pwsh.exe');
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

function powerShellStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function powerShellSetupCommand(setupPath: string): string {
  return (
    '$utf8 = New-Object System.Text.UTF8Encoding($false); ' +
    '[Console]::OutputEncoding = $utf8; $OutputEncoding = $utf8; ' +
    `& ${powerShellStringLiteral(setupPath)}`
  );
}

async function detectPluginLayer(
  ctx: CapabilityEntryContext,
  config: PluginLayerConfig,
): Promise<{ readonly step: CapabilityStep; readonly version?: string }> {
  const installed = await ctx.plugins.listPlugins();
  const plugin = installed.find((candidate) => candidate.id === config.id);
  const mcpGap =
    plugin !== undefined && plugin.enabledMcpServerCount < plugin.mcpServerCount
      ? `mcp ${plugin.enabledMcpServerCount}/${plugin.mcpServerCount} enabled`
      : undefined;
  const pluginOk =
    plugin !== undefined &&
    plugin.enabled &&
    plugin.state === 'ok' &&
    plugin.enabledMcpServerCount === plugin.mcpServerCount;
  return {
    step: {
      id: 'plugin',
      state: pluginOk ? 'ok' : 'missing',
      detail: mcpGap ?? plugin?.version,
    },
    version: plugin?.version,
  };
}

async function installPluginLayer(
  ctx: CapabilityEntryContext,
  config: PluginLayerConfig,
): Promise<void> {
  const summary = await ctx.plugins.installPlugin({ source: config.zipUrl });
  if (!summary.enabled) {
    await ctx.plugins.setPluginEnabled({ id: config.id, enabled: true });
  }
  if (summary.enabledMcpServerCount >= summary.mcpServerCount) return;
  const info = await ctx.plugins.getPluginInfo({ id: config.id });
  for (const server of info.mcpServers) {
    if (!server.enabled) {
      await ctx.plugins.setPluginMcpServerEnabled({
        id: config.id,
        server: server.name,
        enabled: true,
      });
    }
  }
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

function createMacKimiCuEntry(ctx: CapabilityEntryContext): CapabilityEntry {
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

    const plugin = await detectPluginLayer(ctx, MAC_PLUGIN);
    steps.push(plugin.step);

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
      version: version ?? plugin.version,
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

  async function install(report: CapabilityInstallReporter): Promise<string | undefined> {
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
    await installPluginLayer(ctx, MAC_PLUGIN);

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
    return undefined;
  }

  return {
    id: 'kimi-cu',
    pluginId: MAC_PLUGIN.id,
    displayName: 'Kimi Computer Use',
    description:
      'macOS GUI automation in the background — read app UIs and click, type, scroll, and drag without taking over your mouse or foregrounding apps.',
    supported,
    detect,
    install,
  };
}

function createWindowsKimiCuEntry(ctx: CapabilityEntryContext): CapabilityEntry {
  const supported = ctx.platform === 'win32' && ctx.arch === 'x64';
  const probeTimeoutMs = ctx.detectProbeTimeoutMs ?? DETECT_PROBE_TIMEOUT_MS;
  const installerProbeTimeoutMs =
    ctx.detectProbeTimeoutMs ?? WINDOWS_INSTALLER_PROBE_TIMEOUT_MS;
  const installTimeoutMs = ctx.commandTimeoutMs ?? WINDOWS_INSTALL_TIMEOUT_MS;
  const powershellPath = windowsPowerShellPath();
  const powershell7Path = windowsPowerShell7Path();

  async function installerPowerShell(): Promise<string> {
    const failures: string[] = [];
    for (const candidate of [
      { label: 'Windows PowerShell', command: powershellPath },
      { label: 'PowerShell 7', command: powershell7Path },
    ]) {
      try {
        const result = await runCommand(
          ctx.hostProcess,
          candidate.command,
          ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_INSTALLER_PROBE_SCRIPT],
          { timeout: installerProbeTimeoutMs },
        );
        if (result.code === 0) return candidate.command;
        failures.push(
          `${candidate.label} (${candidate.command}): ${
            result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`
          }`,
        );
      } catch (error) {
        failures.push(`${candidate.label} (${candidate.command}): ${errorMessage(error)}`);
      }
    }
    throw new Error(
      'Kimi Computer Use requires Windows PowerShell 5.1 or PowerShell 7 with the commands required by its official installer. ' +
        failures.join('; '),
    );
  }

  async function runtimeStep(command: string): Promise<{
    readonly step: CapabilityStep;
    readonly version?: string;
  }> {
    let result: Awaited<ReturnType<typeof runCommand>>;
    try {
      result = await runCommand(
        ctx.hostProcess,
        command,
        ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_DOCTOR_SCRIPT],
        { timeout: probeTimeoutMs },
      );
    } catch (error) {
      return { step: { id: 'runtime', state: 'failed', detail: errorMessage(error) } };
    }
    if (result.code === 3) {
      return { step: { id: 'runtime', state: 'missing' } };
    }
    if (result.code !== 0) {
      return {
        step: {
          id: 'runtime',
          state: 'failed',
          detail: result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`,
        },
      };
    }
    const doctor = parseWindowsDoctorOutput(result.stdout);
    if (doctor === undefined) {
      return {
        step: {
          id: 'runtime',
          state: 'failed',
          detail: 'doctor returned unexpected output',
        },
      };
    }
    return doctor.version === undefined
      ? { step: { id: 'runtime', state: 'ok' } }
      : { step: { id: 'runtime', state: 'ok', detail: doctor.version }, version: doctor.version };
  }

  async function detectRuntimeStep(): Promise<{
    readonly step: CapabilityStep;
    readonly version?: string;
  }> {
    const systemRuntime = await runtimeStep(powershellPath);
    if (systemRuntime.step.state !== 'failed') return systemRuntime;

    const fallbackRuntime = await runtimeStep(powershell7Path);
    return fallbackRuntime.step.state === 'ok' ? fallbackRuntime : systemRuntime;
  }

  async function detect(): Promise<CapabilityDetectResult> {
    const [plugin, runtime] = await Promise.all([
      detectPluginLayer(ctx, WINDOWS_PLUGIN),
      detectRuntimeStep(),
    ]);
    return {
      steps: [plugin.step, runtime.step],
      version: runtime.version ?? plugin.version,
    };
  }

  async function install(report: CapabilityInstallReporter): Promise<string | undefined> {
    if (!supported) {
      throw new Error(
        `kimi-cu is only supported on macOS or Windows x64 (current: ${ctx.platform}/${ctx.arch})`,
      );
    }

    const before = await detect();
    const stepStates = new Map(before.steps.map((step) => [step.id, step.state]));
    const readyBefore = before.steps.every((step) => step.state === 'ok');
    const installPlugin = stepStates.get('plugin') !== 'ok' || readyBefore;
    const installRuntime = stepStates.get('runtime') !== 'ok' || readyBefore;
    const installPowerShell = installRuntime ? await installerPowerShell() : undefined;

    if (installPlugin) {
      report('plugin');
      try {
        await installPluginLayer(ctx, WINDOWS_PLUGIN);
      } catch (error) {
        if (
          typeof error !== 'object' ||
          error === null ||
          !('code' in error) ||
          error.code !== 'EBUSY'
        ) {
          throw error;
        }
        throw new Error(
          'Kimi Computer Use plugin files are still in use by the current Kimi Code process. Restart Kimi Code, then install again.',
          { cause: error },
        );
      }
    }

    if (installPowerShell !== undefined) {
      const workDir = await mkdtemp(path.join(tmpdir(), 'kimi-cu-windows-install-'));
      try {
        const setupPath = path.join(workDir, 'setup_windows.ps1');
        report('download', 0);
        await downloadToFile(
          WINDOWS_SETUP_URL,
          setupPath,
          (percent) => {
            report('download', percent);
          },
          ctx.fetchImpl,
        );

        report('runtime');
        const installed = await runCommand(
          ctx.hostProcess,
          installPowerShell,
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            powerShellSetupCommand(setupPath),
          ],
          { timeout: installTimeoutMs },
        );
        if (installed.code !== 0) {
          throw new Error(
            `kimi-cu Windows runtime install failed: ${
              installed.stderr.trim() || installed.stdout.trim() || `exit code ${installed.code}`
            }`,
          );
        }
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }

      const runtime = await runtimeStep(installPowerShell);
      if (runtime.step.state !== 'ok') {
        throw new Error(
          `kimi-cu Windows runtime is not ready after install: ${runtime.step.detail ?? runtime.step.state}`,
        );
      }
    }
    return undefined;
  }

  return {
    id: 'kimi-cu',
    pluginId: WINDOWS_PLUGIN.id,
    displayName: 'Kimi Computer Use for Windows',
    description:
      'Windows GUI automation — read app UIs and click, type, scroll, and drag in desktop apps.',
    supported,
    detect,
    install,
  };
}

export function createKimiCuEntry(ctx: CapabilityEntryContext): CapabilityEntry {
  return ctx.platform === 'win32' ? createWindowsKimiCuEntry(ctx) : createMacKimiCuEntry(ctx);
}
