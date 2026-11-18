import { log } from '@moonshot-ai/kimi-code-sdk';

import {
  readUpdateInstallLockVersion,
  tryAcquireUpdateInstallLock,
  type UpdateInstallLockHandle,
} from '#/cli/update/install-lock';
import {
  hashFileSha256,
  matchesStagedUpdateRequest,
  promoteStagedUpdateToManual,
  readStagedNativeUpdate,
  stagedExePath,
  stageNativeUpdate,
} from '#/cli/update/native-stage';
import { detectNativeInstall } from '#/cli/update/source';
import { UPDATE_CHANNELS, type InstallIntent, type UpdateChannel } from '#/cli/update/types';

const LOCK_HELD_POLL_INTERVAL_MS = 2_000;

type StagedUpdateWait =
  | { readonly status: 'staged' }
  | { readonly status: 'takeover'; readonly lock: UpdateInstallLockHandle | null };

async function waitForStagedUpdate(
  version: string,
  exePath: string,
  manual: boolean,
  intent: InstallIntent,
  channel: UpdateChannel,
): Promise<StagedUpdateWait> {
  for (;;) {
    const staged = await readStagedNativeUpdate(exePath);
    const requestMatches = staged !== null && matchesStagedUpdateRequest(staged, {
      version,
      channel,
      manual,
      intent,
    });
    const digest = staged !== null && requestMatches
      ? await hashFileSha256(stagedExePath(exePath, staged))
      : null;
    if (staged !== null && requestMatches && digest === staged.sha256) {
      if (!manual || (await promoteStagedUpdateToManual(exePath, staged))) {
        return { status: 'staged' };
      }
    } else {
      const lock = await tryAcquireUpdateInstallLock({ version });
      if (lock !== null) return { status: 'takeover', lock };
    }
    await new Promise((resolve) => {
      setTimeout(resolve, LOCK_HELD_POLL_INTERVAL_MS);
    });
  }
}

export async function runUpdateDownloadCommand(
  version: string,
  manual: boolean = false,
  intent: InstallIntent = 'upgrade',
  channel: UpdateChannel = 'stable',
): Promise<number> {
  if (!detectNativeInstall()) {
    process.stderr.write('error: update download is only available in the native build\n');
    return 1;
  }
  if (!UPDATE_CHANNELS.includes(channel)) {
    process.stderr.write(`error: invalid update channel ${JSON.stringify(channel)}\n`);
    return 1;
  }
  const out = process.stdout;
  let lock = await tryAcquireUpdateInstallLock({ version });
  if (lock === null) {
    const holderVersion = await readUpdateInstallLockVersion();
    if (holderVersion === version) {
      out.write(
        `A download of Kimi Code ${version} is already in progress; waiting for it to finish…\n`,
      );
      const wait = await waitForStagedUpdate(version, process.execPath, manual, intent, channel);
      if (wait.status === 'staged') {
        out.write(`Kimi Code ${version} is downloaded; it applies on the next start.\n`);
        return 0;
      }
      lock = wait.lock;
    } else if (holderVersion === undefined) {
      lock = await tryAcquireUpdateInstallLock({ version });
    }
    if (lock === null) {
      process.stderr.write(
        `error: another update (${holderVersion ?? 'unknown version'}) is already downloading\n`,
      );
      return 1;
    }
  }
  const label = `Downloading Kimi Code ${version} (${process.platform}-${process.arch})…`;
  const onProgress = createDownloadProgress(out, label);
  try {
    const result = await stageNativeUpdate({
      version,
      channel,
      exePath: process.execPath,
      onProgress,
      manual,
      intent,
    });
    if (out.isTTY) out.write('\n');
    if (result.status === 'already-staged') {
      out.write(`Kimi Code ${version} is already downloaded; it applies on the next start.\n`);
    }
    return 0;
  } catch (error) {
    if (out.isTTY) out.write('\n');
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: failed to download update ${version}: ${message}\n`);
    log.warn('native update download failed', { version, error: message });
    return 1;
  } finally {
    await lock.release().catch(() => {});
  }
}

const PROGRESS_FRAME_INTERVAL_MS = 100;
const PROGRESS_LINE_INTERVAL_BYTES = 32 * 1024 * 1024;

function formatDownloadProgress(label: string, downloaded: number, total: number | null): string {
  const mb = Math.floor(downloaded / (1024 * 1024));
  if (total === null || total <= 0) return `${label} ${mb} MB`;
  const totalMb = Math.max(1, Math.round(total / (1024 * 1024)));
  const percent = Math.min(100, Math.floor((downloaded / total) * 100));
  return `${label} ${percent}% (${mb}/${totalMb} MB)`;
}

export function createDownloadProgress(
  out: NodeJS.WriteStream,
  label: string,
): (downloadedBytes: number, totalBytes: number | null) => void {
  const isTTY = out.isTTY;
  let lastFrameAt = 0;
  let lastLineAt = 0;
  if (!isTTY) out.write(`${label}\n`);
  return (downloaded, total) => {
    const done = total !== null && downloaded >= total;
    if (isTTY) {
      const now = Date.now();
      if (!done && now - lastFrameAt < PROGRESS_FRAME_INTERVAL_MS) return;
      lastFrameAt = now;
      out.write(`\r\u001B[K${formatDownloadProgress(label, downloaded, total)}`);
      return;
    }
    if (!done && downloaded - lastLineAt < PROGRESS_LINE_INTERVAL_BYTES) return;
    lastLineAt = downloaded;
    out.write(`${formatDownloadProgress(label, downloaded, total)}\n`);
  };
}
