// Kimi Code Canary auto-update via electron-updater's GitHub provider against
// the PRIVATE repo (MoonshotAI/kimi-code-app), replacing the retired
// gh-manual-dmg flow (canary.ts now only covers gh probing / trigger build).
//
// Auth: the token is resolved at runtime from the user's own `gh auth token`
// — nothing ships in the package, and a missing/unauthenticated gh simply
// leaves the canary without auto-update (the debug menu's gh hints explain).
//
// Two provider patches, validated by the 2026-08 differential-download spike:
//  1. PrivateGitHubProvider is channel-blind — it always looks for
//     latest-mac.yml. getDefaultChannelName is overridden to the build's own
//     channel (x.y.z-canary.n → 'canary', see updater.ts
//     updateChannelFromVersion), so it resolves canary-mac.yml (the
//     publish-canary CI job renames the arch-suffixed yml accordingly).
//  2. Its blockmap URL derivation (asset URL + '.blockmap') does not match
//     GitHub's asset model — blockmaps are separate assets with their own
//     ids. getBlockMapFiles is overridden to resolve both old and new
//     blockmaps from the releases' asset lists.
//
// With those in place the stock machinery takes over: blockmap diffing,
// range-request differential download (~10MB instead of ~135MB), sha512
// verification, and one-click quitAndInstall.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

import { log } from './log';
import { isCanaryVersion } from './release-channel';
import { isUpdateAutoDownloadEnabled } from './ui-state';
import { resolveGhBinary } from './canary';
import { sendToRenderer } from './window';
import { IPC } from './ipc-channels';
import {
  startAutoUpdater,
  updateChannelFromVersion,
  type ReleaseNotes,
  type UpdateController,
  type UpdaterLike,
} from './updater';

const CANARY_REPO_SLUG = 'MoonshotAI/kimi-code-app';

/** Structural subset of PrivateGitHubProvider this module patches. */
export interface GithubProviderLike {
  getDefaultChannelName: () => string;
  getCustomChannelName: (channel: string) => string;
  getBlockMapFiles: (zipFileUrl: URL, oldVersion: string, newVersion: string) => Promise<URL[]>;
  configureHeaders: (accept: string) => Record<string, string>;
  httpRequest: (url: URL, headers: Record<string, string>, cancellationToken?: unknown) => Promise<string | null>;
}

interface ReleaseAsset {
  name?: unknown;
  url?: unknown;
}

/** Apply the two spike-validated patches (see the header comment). Exported
    for tests. */
export function patchGithubProviderForChannel(provider: GithubProviderLike, channel: string): void {
  provider.getDefaultChannelName = () => provider.getCustomChannelName(channel);
  provider.getBlockMapFiles = async (_zipFileUrl, oldVersion, newVersion) => {
    const listAssets = async (version: string): Promise<Array<{ name: string; url: string }>> => {
      const body = await provider.httpRequest(
        new URL(`https://api.github.com/repos/${CANARY_REPO_SLUG}/releases/tags/v${version}`),
        provider.configureHeaders('application/vnd.github+json'),
      );
      let parsed: { assets?: ReleaseAsset[] };
      try {
        parsed = JSON.parse(body ?? '{}') as { assets?: ReleaseAsset[] };
      } catch {
        throw new Error(`cannot parse release assets for ${version}`);
      }
      if (!Array.isArray(parsed.assets)) {
        throw new Error(`no assets on release ${version}`);
      }
      return parsed.assets
        .filter((asset): asset is { name: string; url: string } => typeof asset.name === 'string' && typeof asset.url === 'string')
        .map((asset) => ({ name: asset.name, url: asset.url }));
    };
    const findBlockmap = (assets: Array<{ name: string; url: string }>, version: string): URL => {
      const zip = assets.find((asset) => asset.name.endsWith('.zip') && asset.name.includes(`-${version}-`));
      const blockmap = zip === undefined ? undefined : assets.find((asset) => asset.name === `${zip.name}.blockmap`);
      if (blockmap === undefined) {
        throw new Error(`blockmap asset for ${version} not found`);
      }
      return new URL(blockmap.url);
    };
    const [newAssets, oldAssets] = await Promise.all([listAssets(newVersion), listAssets(oldVersion)]);
    return [findBlockmap(oldAssets, oldVersion), findBlockmap(newAssets, newVersion)];
  };
}

const execFileAsync = promisify(execFile) as (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

/** Runtime gh token for the private repo. Null when gh is missing or the user
    is not logged in — auto-update then stays off for this canary instance. */
export async function resolveGhToken(
  deps: {
    exists: (path: string) => boolean;
    platform: NodeJS.Platform;
    exec?: (file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string; stderr: string }>;
  } = { exists: existsSync, platform: process.platform },
): Promise<string | null> {
  const exec = deps.exec ?? execFileAsync;
  try {
    const { stdout } = await exec(resolveGhBinary(deps), ['auth', 'token'], { timeout: 15_000 });
    const token = stdout.trim();
    return token === '' ? null : token;
  } catch {
    return null;
  }
}

/** Canary counterpart of the stable init: resolves the gh token, wires the
    GitHub provider, then starts the shared update state machine. The
    controller is handed back so updater.ts owns the single module-level
    instance. No-op on non-canary builds. */
export function initCanaryGithubUpdater(setController: (next: UpdateController | null) => void): void {
  if (!isCanaryVersion(app.getVersion())) {
    return;
  }
  const channel = updateChannelFromVersion(app.getVersion());
  void (async () => {
    const token = await resolveGhToken();
    if (token === null) {
      log.warn('[kimi-desktop] canary auto-update unavailable: gh auth token missing (run gh auth login)');
      return;
    }
    const updater: UpdaterLike = autoUpdater;
    updater.allowPrerelease = true;
    updater.setFeedURL?.({
      provider: 'github',
      owner: 'MoonshotAI',
      repo: 'kimi-code-app',
      private: true,
      token,
    });
    // Patch the channel-blind provider methods once the instance is created.
    const clientPromise = (updater as { clientPromise?: Promise<unknown> }).clientPromise;
    void clientPromise
      ?.then((provider) => patchGithubProviderForChannel(provider as GithubProviderLike, channel))
      .catch((error: unknown) => {
        log.error('[kimi-desktop] failed to patch canary update provider', error);
      });
    setController(
      startAutoUpdater({
        updater,
        send: (status) => sendToRenderer(IPC.updateStatus, status),
        isPackaged: app.isPackaged,
        autoDownload: isUpdateAutoDownloadEnabled(),
        // Canary prereleases carry no changelog files; notes stay empty.
        fetchNotes: (): Promise<ReleaseNotes> => Promise.resolve({}),
      }),
    );
    log.info(`[kimi-desktop] canary auto-update enabled (github provider, channel=${channel})`);
  })();
}
