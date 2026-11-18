import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  kimiCdnContentUrl,
  kimiRegionProfile,
  resolveKimiRegion,
} from '@moonshot-ai/kimi-code-oauth';

import { Error2 } from '#/errors';

import { installResolvedMarketplacePlugin } from '../../plugin/pluginService';
import { CapabilityErrors } from '../errors';
import { downloadToFile, runCommand } from '../host';
import type {
  CapabilityDetectResult,
  CapabilityEntry,
  CapabilityInstallOptions,
  CapabilityInstallReporter,
  CapabilityStep,
} from '../types';
import type { CapabilityEntryContext } from './context';

const PLUGIN_ID = 'kimi-browser-extension';
const LEGACY_PLUGIN_ID = 'kimi-webbridge';
const PLUGIN_ZIP_PATH = 'plugins/official/kimi-webbridge.zip';
const BINARY_CDN_PATH = 'webbridge/latest/releases';
const DEFAULT_DAEMON_BASE_URL = 'http://127.0.0.1:10086';
const STATUS_TIMEOUT_MS = 1_500;
const START_TIMEOUT_MS = 30_000;
const START_POLL_INTERVAL_MS = 500;
const START_POLL_ATTEMPTS = 20;

interface DaemonStatus {
  readonly running?: boolean;
  readonly version?: string;
  readonly extension_connected?: boolean;
}

function binaryAssetName(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'kimi-webbridge-darwin-arm64';
    if (arch === 'x64') return 'kimi-webbridge-darwin-amd64';
    return undefined;
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return 'kimi-webbridge-linux-arm64';
    if (arch === 'x64') return 'kimi-webbridge-linux-amd64';
    return undefined;
  }
  if (platform === 'win32' && arch === 'x64') return 'kimi-webbridge-windows-amd64.exe';
  return undefined;
}

export function createKimiWebbridgeEntry(ctx: CapabilityEntryContext): CapabilityEntry {
  const baseUrl = ctx.webbridgeBaseUrl ?? DEFAULT_DAEMON_BASE_URL;
  const binDir = path.join(ctx.userHomeDir, '.kimi-webbridge', 'bin');
  const binName = ctx.platform === 'win32' ? 'kimi-webbridge.exe' : 'kimi-webbridge';
  const binPath = path.join(binDir, binName);
  const userSourceSkillDirs = [
    {
      label: 'kimi-code',
      path: path.join(ctx.kimiHomeDir, 'skills', 'kimi-webbridge'),
    },
    {
      label: 'agents',
      path: path.join(ctx.userHomeDir, '.agents', 'skills', 'kimi-webbridge'),
    },
  ];
  const standaloneSkillBackupDir = path.join(
    ctx.kimiHomeDir,
    'backups',
    'kimi-webbridge-skills',
  );
  const supported = binaryAssetName(ctx.platform, ctx.arch) !== undefined;
  let standaloneSkillBackupPath: string | undefined;
  let standaloneSkillMigrationError: string | undefined;

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

  async function fetchDaemonStatus(): Promise<DaemonStatus | undefined> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    try {
      const resp = await fetchImpl(`${baseUrl}/status`, {
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });
      if (!resp.ok) return undefined;
      return (await resp.json()) as DaemonStatus;
    } catch {
      return undefined;
    }
  }

  async function standaloneSkillDirs(): Promise<readonly (typeof userSourceSkillDirs)[number][]> {
    const checked = await Promise.all(
      userSourceSkillDirs.map(async (entry) => ({ ...entry, present: await exists(entry.path) })),
    );
    return checked.filter((entry) => entry.present);
  }

  async function migrateStandaloneSkills(): Promise<string | undefined> {
    const skills = await standaloneSkillDirs();
    if (skills.length === 0) return undefined;
    await mkdir(standaloneSkillBackupDir, { recursive: true });
    const backupRoot = await mkdtemp(path.join(standaloneSkillBackupDir, 'migration-'));
    for (const skill of skills) {
      await rename(skill.path, path.join(backupRoot, skill.label));
    }
    return backupRoot;
  }

  async function detect(): Promise<CapabilityDetectResult> {
    const steps: CapabilityStep[] = [];

    const binaryPresent = await exists(binPath);
    const binaryUsable =
      binaryPresent && (ctx.platform === 'win32' || (await executable(binPath)));
    steps.push({
      id: 'daemon-binary',
      state: binaryUsable ? 'ok' : 'missing',
      detail: binaryPresent && !binaryUsable ? 'not executable' : undefined,
    });

    const daemon = await fetchDaemonStatus();
    const daemonRunning = daemon?.running === true;
    steps.push({
      id: 'daemon',
      state: daemonRunning ? 'ok' : 'missing',
      detail: daemonRunning ? daemon?.version : undefined,
    });

    const installed = await ctx.plugins.listPlugins();
    const plugin =
      installed.find((p) => p.id === PLUGIN_ID) ??
      installed.find((p) => p.id === LEGACY_PLUGIN_ID);
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
      id: 'skill',
      state: pluginOk ? 'ok' : 'missing',
      detail: mcpGap ?? plugin?.version,
    });

    const standaloneSkills = await standaloneSkillDirs();
    if (standaloneSkills.length > 0) {
      steps.push({
        id: 'standalone-skill-migration',
        state: 'missing',
        detail:
          standaloneSkillMigrationError ?? standaloneSkills.map((item) => item.path).join(', '),
        optional: true,
      });
    } else if (await exists(standaloneSkillBackupDir)) {
      steps.push({
        id: 'standalone-skill-migration',
        state: 'ok',
        detail: standaloneSkillBackupPath ?? standaloneSkillBackupDir,
        optional: true,
      });
    }

    steps.push({
      id: 'extension',
      state: daemon?.extension_connected === true ? 'ok' : 'missing',
      optional: true,
    });

    return { steps, version: daemon?.version };
  }

  async function waitForDaemon(): Promise<void> {
    for (let attempt = 0; attempt < START_POLL_ATTEMPTS; attempt += 1) {
      const status = await fetchDaemonStatus();
      if (status?.running === true) return;
      await new Promise((resolve) => {
        setTimeout(resolve, START_POLL_INTERVAL_MS);
      });
    }
    throw new Error(`WebBridge daemon did not come up on ${baseUrl} — check ~/.kimi-webbridge/logs`);
  }

  async function waitForDaemonStopped(): Promise<void> {
    let unavailableResponses = 0;
    for (let attempt = 0; attempt < START_POLL_ATTEMPTS; attempt += 1) {
      const status = await fetchDaemonStatus();
      if (status === undefined) {
        unavailableResponses += 1;
        if (unavailableResponses >= 2) return;
      } else {
        unavailableResponses = 0;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, START_POLL_INTERVAL_MS);
      });
    }
    throw new Error2(
      CapabilityErrors.codes.CAPABILITY_PROCESS_CONTROL_FAILED,
      'WebBridge daemon did not stop; retry the update',
    );
  }

  async function install(
    report: CapabilityInstallReporter,
    options: CapabilityInstallOptions = {},
  ): Promise<string | undefined> {
    const asset = binaryAssetName(ctx.platform, ctx.arch);
    if (asset === undefined) {
      throw new Error(`kimi-webbridge is not supported on ${ctx.platform}/${ctx.arch}`);
    }

    const defaultCatalog = await ctx.marketplace.isDefaultMarketplace().catch(() => false);
    const marketplace = defaultCatalog
      ? await ctx.marketplace.listMarketplace().catch(() => undefined)
      : undefined;
    const entry = marketplace?.plugins.find((candidate) => candidate.id === PLUGIN_ID);
    if (marketplace !== undefined && entry === undefined) {
      throw new Error(`Marketplace plugin "${PLUGIN_ID}" was not found in the current catalog`);
    }
    const resolved = marketplace === undefined
      ? {
          source: `${kimiRegionProfile((await ctx.resolveRegion?.()) ?? resolveKimiRegion()).cdnBase}/${PLUGIN_ZIP_PATH}`,
          version: undefined,
          sha256sum: undefined,
          catalogId: PLUGIN_ID,
          marketplaceSource: undefined,
          origin: 'marketplace' as const,
          expectedPluginId: PLUGIN_ID,
          fetchImpl: fetch,
        }
      : await ctx.marketplace.resolveInstall(PLUGIN_ID, entry!.version, entry!.sha256sum);
    const installed = await ctx.plugins.listPlugins();
    const migrateFrom = installed.some((plugin) => plugin.id === LEGACY_PLUGIN_ID)
      ? LEGACY_PLUGIN_ID
      : undefined;

    const before = await detect();
    const stepStates = new Map(before.steps.map((step) => [step.id, step.state]));
    const readyBefore = before.steps
      .filter((step) => step.optional !== true)
      .every((step) => step.state === 'ok');
    const standaloneSkillMigrationPending =
      stepStates.get('standalone-skill-migration') === 'missing';
    const installNewBinary =
      stepStates.get('daemon-binary') !== 'ok' ||
      readyBefore ||
      (ctx.platform === 'win32' && options.stopRunningProcesses === true);
    const stopRunningDaemon =
      ctx.platform === 'win32' &&
      installNewBinary &&
      stepStates.get('daemon') === 'ok' &&
      (await exists(binPath));
    if (stopRunningDaemon && options.stopRunningProcesses !== true) {
      throw new Error2(
        CapabilityErrors.codes.CAPABILITY_PROCESSES_RUNNING,
        'WebBridge daemon must be stopped before updating its binary',
      );
    }
    const staging = installNewBinary ? await downloadBinary(report, asset) : undefined;
    const backup = stopRunningDaemon
      ? `${binPath}.${process.pid}.${Date.now()}.backup`
      : undefined;
    let recoveryAttempted = false;
    try {
      if (backup !== undefined) await copyFile(binPath, backup, constants.COPYFILE_EXCL);
      if (stopRunningDaemon) {
        report('stop-processes');
        const stopped = await runCommand(ctx.hostProcess, binPath, ['stop'], {
          timeout: START_TIMEOUT_MS,
        });
        if (stopped.code !== 0) {
          throw new Error2(
            CapabilityErrors.codes.CAPABILITY_PROCESS_CONTROL_FAILED,
            `kimi-webbridge stop failed: ${stopped.stderr || stopped.stdout}`,
          );
        }
        await waitForDaemonStopped();
      }
      try {
        if (staging !== undefined) await installBinary(staging);
        const status = await fetchDaemonStatus();
        if (status?.running !== true) {
          report('daemon');
          const started = await runCommand(ctx.hostProcess, binPath, ['start'], {
            timeout: START_TIMEOUT_MS,
          });
          if (started.code !== 0) {
            throw new Error(`kimi-webbridge start failed: ${started.stderr || started.stdout}`);
          }
          await waitForDaemon();
        }
      } catch (error) {
        if (backup !== undefined) {
          recoveryAttempted = true;
          const restored = await rename(backup, binPath).then(
            () => true,
            () => false,
          );
          if (restored) {
            await runCommand(ctx.hostProcess, binPath, ['start'], {
              timeout: START_TIMEOUT_MS,
            }).catch(() => undefined);
          }
        }
        throw error;
      }
    } finally {
      if (staging !== undefined) await rm(staging, { force: true }).catch(() => undefined);
      if (backup !== undefined && !recoveryAttempted) {
        await rm(backup, { force: true }).catch(() => undefined);
      }
    }

    report('skill');
    const summary = await installResolvedMarketplacePlugin(
      ctx.plugins,
      {
        marketplaceId: PLUGIN_ID,
        expectedVersion: resolved.version,
        migrateFrom,
      },
      resolved,
      LEGACY_PLUGIN_ID,
    );
    if (!summary.enabled) {
      await ctx.plugins.setPluginEnabled({ id: PLUGIN_ID, enabled: true });
    }

    if (standaloneSkillMigrationPending) {
      report('standalone-skill-migration');
      try {
        standaloneSkillBackupPath = await migrateStandaloneSkills();
        standaloneSkillMigrationError = undefined;
      } catch (error) {
        standaloneSkillMigrationError =
          `Could not back up the standalone kimi-webbridge skill: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return standaloneSkillMigrationPending && standaloneSkillMigrationError === undefined
      ? 'user-skill-migrated'
      : undefined;
  }

  async function downloadBinary(
    report: CapabilityInstallReporter,
    asset: string,
  ): Promise<string> {
    report('download', 0);
    const url = kimiCdnContentUrl(`${BINARY_CDN_PATH}/${asset}`);
    const staging = path.join(
      tmpdir(),
      `kimi-webbridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ctx.platform === 'win32' ? '.exe' : ''}`,
    );
    try {
      await downloadToFile(
        url,
        staging,
        (percent) => {
          report('download', percent);
        },
        ctx.fetchImpl,
      );
      return staging;
    } catch (error) {
      await rm(staging, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function installBinary(staging: string): Promise<void> {
    await mkdir(binDir, { recursive: true });
    await rename(staging, binPath).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EXDEV') throw error;
      await renameAcrossDevicesFallback(staging, binPath);
    });
    if (ctx.platform !== 'win32') await chmod(binPath, 0o755);
  }

  return {
    id: 'kimi-webbridge',
    pluginId: PLUGIN_ID,
    displayName: 'Kimi Browser Extension',
    description:
      'Control your real browser (with your login sessions) — navigate, click, type, read pages, and screenshot any website.',
    supported,
    detect,
    install,
  };
}

async function renameAcrossDevicesFallback(from: string, to: string): Promise<void> {
  const { copyFile } = await import('node:fs/promises');
  const sibling = `${to}.${process.pid}.${Date.now()}.tmp`;
  try {
    await copyFile(from, sibling);
    await rename(sibling, to);
  } finally {
    await rm(sibling, { force: true }).catch(() => undefined);
  }
  await rm(from, { force: true });
}

export const __kimiWebbridgeInternals = { binaryAssetName, renameAcrossDevicesFallback };
