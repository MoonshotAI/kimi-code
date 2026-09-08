/**
 * Hidden `kimi __update_download <version>` sub-command: the self-spawned
 * worker behind native staged updates. Preflight spawns it detached in the
 * background (and the `upgrade` command in the foreground); it downloads,
 * verifies and stages the binary next to the running exe. The swap into
 * place happens on the next startup (see `cli/update/native-swap.ts`).
 */

import { log } from '@moonshot-ai/kimi-code-sdk';

import {
  readUpdateInstallLockVersion,
  tryAcquireUpdateInstallLock,
  type UpdateInstallLockHandle,
} from '#/cli/update/install-lock';
import {
  hashFileSha256,
  promoteStagedUpdateToManual,
  readStagedNativeUpdate,
  stagedExePath,
  stageNativeUpdate,
} from '#/cli/update/native-stage';
import { detectNativeInstall } from '#/cli/update/source';

const LOCK_HELD_POLL_INTERVAL_MS = 2_000;

type StagedUpdateWait =
  | { readonly status: 'staged' }
  | { readonly status: 'takeover'; readonly lock: UpdateInstallLockHandle | null };

/**
 * Another worker holds the install lock for the SAME version. Returning right
 * away would report a success that has not happened yet — the in-flight
 * download may still fail — so wait for it: 'staged' once its staged update is
 * verified on disk; 'takeover' once the lock becomes acquirable, with the lock
 * already held for the caller. The lock goes stale the moment its holder dies
 * (see install-lock), so a killed downloader cannot strand a foreground
 * `kimi upgrade` in this loop.
 *
 * Adoption applies the same integrity bar as stageNativeUpdate's
 * already-staged path: the recorded size proves nothing, and the holder may
 * still be RE-STAGING a same-size-corrupted payload (its metadata is only
 * replaced when the new generation publishes). A recorded stage whose payload
 * fails the checksum is treated as not-yet-staged — the lock poll below takes
 * over once the holder finishes without repairing it.
 *
 * A manual (explicit-upgrade) waiter adopts only after CONFIRMING the manual
 * marker landed on the stage — a concurrent startup swap may be claiming and
 * restoring the metadata right now, and reporting adoption for a promotion
 * that never persisted would strand the update under the env opt-out.
 */
async function waitForStagedUpdate(
  version: string,
  exePath: string,
  manual: boolean,
): Promise<StagedUpdateWait> {
  for (;;) {
    const staged = await readStagedNativeUpdate(exePath);
    const digest =
      staged !== null && staged.version === version
        ? await hashFileSha256(stagedExePath(exePath, staged))
        : null;
    if (staged !== null && digest === staged.sha256) {
      if (!manual || (await promoteStagedUpdateToManual(exePath, staged))) {
        return { status: 'staged' };
      }
      // The stage is being claimed/restored by a concurrent swap — the next
      // poll either promotes the restored stage or takes over once it is
      // gone.
    } else {
      // Poll the acquisition itself: while the holder lives its lock stays
      // fresh and this returns null without side effects; when the holder
      // finishes (or dies) without staging a VERIFIED payload, the takeover
      // happens right here.
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
): Promise<number> {
  if (!detectNativeInstall()) {
    process.stderr.write('error: update download is only available in the native build\n');
    return 1;
  }
  const out = process.stdout;
  let lock = await tryAcquireUpdateInstallLock({ version });
  if (lock === null) {
    const holderVersion = await readUpdateInstallLockVersion();
    if (holderVersion === version) {
      // Another worker is already downloading this exact version: wait for it
      // and adopt its verified result instead of exiting on a maybe.
      out.write(
        `A download of Kimi Code ${version} is already in progress; waiting for it to finish…\n`,
      );
      const wait = await waitForStagedUpdate(version, process.execPath, manual);
      if (wait.status === 'staged') {
        out.write(`Kimi Code ${version} is downloaded; it applies on the next start.\n`);
        return 0;
      }
      // The holder finished without staging (failed or died): take over. The
      // lock may already be held by another winner of the takeover race —
      // the null check below reports that as held.
      lock = wait.lock;
    } else if (holderVersion === undefined) {
      // The lock was released between the two reads — retry the acquire once.
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
      exePath: process.execPath,
      onProgress,
      manual,
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

/**
 * Download progress renderer for the (foreground) downloader: a single
 * in-place line on a TTY (`\r` + clear-line, throttled to 10 fps, final frame
 * always rendered), or one line per 32 MB when piped to a file. The caller
 * owns the trailing newline.
 */
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
