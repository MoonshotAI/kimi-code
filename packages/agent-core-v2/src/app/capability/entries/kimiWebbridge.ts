/**
 * `kimi-webbridge` capability entry (macOS / Linux / Windows).
 *
 * Layers: daemon binary (`~/.kimi-webbridge/bin/`, local HTTP daemon on
 * 127.0.0.1:10086) + agent wiring (the official `kimi-webbridge` plugin —
 * skills only, installed through `IPluginService`) + browser extension
 * (soft gate, user installs from the webstore or the manual zip).
 *
 * A running daemon is left untouched (start-if-down only, Kimi Work
 * coexistence). Reinstall replaces the on-disk binary from the latest
 * channel, which takes effect the next time the daemon starts. Installs
 * are detect-first and idempotent: only unsatisfied layers are redone,
 * setup re-enables a previously disabled wiring plugin, the binary step
 * requires the executable bit on POSIX (an interrupted install reads as
 * missing and re-downloads), and user-source skill shadows are reported
 * as an optional step for manual cleanup instead of being deleted.
 */

import { constants } from 'node:fs';
import { access, chmod, mkdir, rename, rm } from 'node:fs/promises';
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

const PLUGIN_ID = 'kimi-webbridge';
const PLUGIN_ZIP_URL =
  'https://code.kimi.com/kimi-code/plugins/official/kimi-webbridge.zip';
const BINARY_CDN_BASE = 'https://cdn.kimi.com/webbridge/latest/releases';
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
    path.join(ctx.kimiHomeDir, 'skills', 'kimi-webbridge'),
    path.join(ctx.userHomeDir, '.agents', 'skills', 'kimi-webbridge'),
  ];
  const supported = binaryAssetName(ctx.platform, ctx.arch) !== undefined;

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
      id: 'skill',
      state: pluginOk ? 'ok' : 'missing',
      detail: mcpGap ?? plugin?.version,
    });

    const skillShadows = (
      await Promise.all(
        userSourceSkillDirs.map(async (dir) => ({ dir, present: await exists(dir) })),
      )
    ).filter((item) => item.present);
    if (skillShadows.length > 0) {
      steps.push({
        id: 'skill-shadow',
        state: 'failed',
        detail: skillShadows.map((item) => item.dir).join(', '),
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

  async function install(report: CapabilityInstallReporter): Promise<void> {
    const asset = binaryAssetName(ctx.platform, ctx.arch);
    if (asset === undefined) {
      throw new Error(`kimi-webbridge is not supported on ${ctx.platform}/${ctx.arch}`);
    }

    const before = await detect();
    const stepStates = new Map(before.steps.map((step) => [step.id, step.state]));
    const readyBefore = before.steps
      .filter((step) => step.optional !== true)
      .every((step) => step.state === 'ok');
    if (stepStates.get('daemon-binary') !== 'ok' || readyBefore) {
      await installBinary(report, asset);
    }

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

    if (stepStates.get('skill') !== 'ok' || readyBefore) {
      report('skill');
      const summary = await ctx.plugins.installPlugin({ source: PLUGIN_ZIP_URL });
      if (!summary.enabled) {
        await ctx.plugins.setPluginEnabled({ id: PLUGIN_ID, enabled: true });
      }
    }
  }

  async function installBinary(
    report: CapabilityInstallReporter,
    asset: string,
  ): Promise<void> {
    report('download', 0);
    const url = `${BINARY_CDN_BASE}/${asset}`;
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
      await mkdir(binDir, { recursive: true });
      await rename(staging, binPath).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EXDEV') throw error;
        await renameAcrossDevicesFallback(staging, binPath);
      });
      if (ctx.platform !== 'win32') await chmod(binPath, 0o755);
    } finally {
      await rm(staging, { force: true }).catch(() => undefined);
    }
  }

  return {
    id: 'kimi-webbridge',
    displayName: 'Kimi WebBridge',
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
