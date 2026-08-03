/**
 * `kimi-webbridge` capability entry (macOS / Linux / Windows).
 *
 * Layers: daemon binary (`~/.kimi-webbridge/bin/`, local HTTP daemon on
 * 127.0.0.1:10086) + agent wiring (the official `kimi-webbridge` plugin —
 * skills only, bundled inside the client release and installed through
 * `IPluginService` from the bundled copy — see `../bundledPlugins.ts`) +
 * browser extension (soft gate, user installs from the webstore or the
 * manual zip).
 *
 * Lifecycle rules honored here (official operations contract): the daemon
 * is only ever STARTED — never stopped / restarted / uninstalled — because
 * the Kimi Work desktop app manages its own daemon on the same port and an
 * external stop would fight it. `start` is idempotent and converges to a
 * single daemon.
 *
 * Skill-source shadowing: a user who previously ran the official install
 * script (or copied the skill around) has it in user-scope dirs —
 * `~/.kimi-code/skills/kimi-webbridge/` and/or `~/.agents/skills/kimi-webbridge/`
 * — both at priority 20, SHADOWING the plugin copy (priority 5). Install
 * therefore removes those stale user copies — they are artifacts of the
 * official installer (or of the same content), and the plugin copy carries
 * the same skill. Other runtimes' dirs (~/.claude, ~/.codex) are out of
 * scope and untouched.
 */

import { access, chmod, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { requireBundledPluginDir } from '../bundledPlugins';
import { downloadToFile, runCommand } from '../host';
import type {
  CapabilityDetectResult,
  CapabilityEntry,
  CapabilityInstallReporter,
  CapabilityStep,
} from '../types';

import type { CapabilityEntryContext } from './context';

const PLUGIN_ID = 'kimi-webbridge';
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
    steps.push({ id: 'daemon-binary', state: binaryPresent ? 'ok' : 'missing' });

    const daemon = await fetchDaemonStatus();
    const daemonRunning = daemon?.running === true;
    steps.push({
      id: 'daemon',
      state: daemonRunning ? 'ok' : 'missing',
      ...(daemonRunning && daemon?.version !== undefined ? { detail: daemon.version } : {}),
    });

    const installed = await ctx.plugins.listPlugins();
    const plugin = installed.find((p) => p.id === PLUGIN_ID);
    const pluginOk = plugin !== undefined && plugin.enabled && plugin.state === 'ok';
    steps.push({
      id: 'skill',
      state: pluginOk ? 'ok' : 'missing',
      ...(plugin?.version !== undefined ? { detail: plugin.version } : {}),
    });

    // Soft gate: extension presence never blocks readiness — use-time
    // failures carry official guidance.
    steps.push({
      id: 'extension',
      state: daemon?.extension_connected === true ? 'ok' : 'missing',
      optional: true,
    });

    // Version only from the live daemon: the on-disk `.version` file tracks
    // the installer script's lineage (e.g. 3.1.x), not the product version
    // (e.g. v1.11.3) — reporting it would be misleading.
    return { steps, ...(daemon?.version !== undefined ? { version: daemon.version } : {}) };
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

  async function install(report: CapabilityInstallReporter): Promise<string | undefined> {
    const asset = binaryAssetName(ctx.platform, ctx.arch);
    if (asset === undefined) {
      throw new Error(`kimi-webbridge is not supported on ${ctx.platform}/${ctx.arch}`);
    }

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

    report('daemon');
    const status = await fetchDaemonStatus();
    if (status?.running !== true) {
      // start-if-down only — never stop/restart (Kimi Work coexistence).
      const started = await runCommand(ctx.hostProcess, binPath, ['start'], {
        timeout: START_TIMEOUT_MS,
      });
      if (started.code !== 0) {
        throw new Error(`kimi-webbridge start failed: ${started.stderr || started.stdout}`);
      }
      await waitForDaemon();
    }

    report('skill');
    await ctx.plugins.installPlugin({
      source: requireBundledPluginDir(PLUGIN_ID, ctx.bundledPluginsRoot),
    });
    // Un-shadow the plugin copy: user-source skills (priority 20, in either
    // user dir) win over the plugin source (priority 5) on name collisions.
    // Surface the migration so clients can tell the user their
    // manually-installed skill is now managed as a plugin.
    let migrated = false;
    for (const dir of userSourceSkillDirs) {
      if (await exists(dir)) {
        migrated = true;
        await rm(dir, { recursive: true, force: true });
      }
    }
    return migrated ? 'user-skill-migrated' : undefined;
  }

  return {
    id: 'kimi-webbridge',
    displayName: 'Kimi WebBridge',
    description:
      'Control your real browser (with your login sessions) — navigate, click, type, read pages, and screenshot any website.',
    supported,
    wiringStepId: 'skill',
    detect,
    install,
  };
}

/** rename(2) cannot cross filesystems; fall back to copy+remove. */
async function renameAcrossDevicesFallback(from: string, to: string): Promise<void> {
  const { copyFile } = await import('node:fs/promises');
  await copyFile(from, to);
  await rm(from, { force: true });
}

export const __kimiWebbridgeInternals = { binaryAssetName };
